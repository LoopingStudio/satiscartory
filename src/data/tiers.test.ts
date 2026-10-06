import { describe, expect, it } from 'vitest';
import { TIERS, isUnlocked, tierOf } from './tiers';
import { BUILDINGS, BUILD_MENU, type BuildingType } from './buildings';
import { RECIPES, type Station } from './recipes';
import { FACTORY_MAP, RESOURCES } from './factoryMap';
import { ITEMS, ITEM_IDS, type Inventory, type ItemId } from './items';

/** Items of the resources present on the map: mined by hand from the start, later by drills. */
const NODE_ITEMS = new Set<ItemId>(FACTORY_MAP.nodes.map((n) => RESOURCES[n.resource].item));

/**
 * Everything the player can produce with `tier` tiers unlocked: hand mining and drills on the map's
 * nodes, the bench, and the unlocked machines whose own building cost is producible (fixed point).
 */
function producible(tier: number): Set<ItemId> {
  const have = new Set<ItemId>(NODE_ITEMS);
  const machines = BUILD_MENU.map((t) => BUILDINGS[t]).filter((b) => b.machine && isUnlocked(b.type, tier));
  const pays = (cost: Inventory) => (Object.keys(cost) as ItemId[]).every((i) => have.has(i));
  for (let grew = true; grew; ) {
    grew = false;
    const stations = new Set<Station>(['bench']);
    for (const b of machines) if (pays(b.cost)) stations.add(b.machine!);
    for (const r of RECIPES) {
      if (!stations.has(r.machine) || !r.inputs.every((s) => have.has(s.item))) continue;
      for (const o of r.outputs) {
        if (have.has(o.item)) continue;
        have.add(o.item);
        grew = true;
      }
    }
  }
  return have;
}

const missingFrom = (have: Set<ItemId>, cost: Inventory) => (Object.keys(cost) as ItemId[]).filter((i) => !have.has(i));

describe('hub tiers', () => {
  it('tierOf and isUnlocked follow the tier list', () => {
    TIERS.forEach((t, i) => {
      for (const type of t.unlocks) {
        expect(tierOf(type), type).toBe(i + 1);
        expect(isUnlocked(type, i), type).toBe(false);
        expect(isUnlocked(type, i + 1), type).toBe(true);
        expect(isUnlocked(type, TIERS.length), type).toBe(true);
      }
    });
    // the hub is always there; a new game (tier 0) has only hand mining and the bench
    expect(tierOf('hub')).toBe(0);
    expect(isUnlocked('hub', 0)).toBe(true);
    expect(BUILD_MENU.filter((t) => isUnlocked(t, 0))).toEqual([]);
    expect(BUILD_MENU.every((t) => isUnlocked(t, TIERS.length))).toBe(true);
  });

  it('every building of the build menu is unlocked by exactly one tier', () => {
    for (const type of BUILD_MENU) expect(TIERS.filter((t) => t.unlocks.includes(type)).length, type).toBe(1);
    const unlocked = TIERS.flatMap((t) => t.unlocks);
    expect(new Set(unlocked).size).toBe(unlocked.length);
    for (const type of unlocked) expect(BUILD_MENU, type).toContain(type);
    // hotkeys 1-5 follow the unlock order
    const order = BUILD_MENU.map(tierOf);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('tiers have names, at least one unlock and a valid cost', () => {
    for (const t of TIERS) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.unlocks.length).toBeGreaterThan(0);
      const entries = Object.entries(t.cost) as [ItemId, number][];
      expect(entries.length).toBeGreaterThan(0);
      for (const [item, n] of entries) {
        expect(ITEMS[item], item).toBeDefined();
        expect(Number.isInteger(n) && n > 0, `${t.name}: ${item}`).toBe(true);
      }
    }
  });

  it('starting from nothing, each tier and its buildings can be paid with what is available before it', () => {
    TIERS.forEach((t, i) => {
      const have = producible(i);
      expect(missingFrom(have, t.cost), `tier ${i + 1} (${t.name})`).toEqual([]);
      // its buildings can be built right after unlocking, without needing themselves
      for (const type of t.unlocks) expect(missingFrom(have, BUILDINGS[type].cost), `${type} after tier ${i + 1}`).toEqual([]);
    });
    // once everything is unlocked, every item of the game can be made
    const all = producible(TIERS.length);
    expect(ITEM_IDS.filter((i) => !all.has(i))).toEqual([]);
  });

  it('the reachability check is not vacuous: machine-only items wait for their machine', () => {
    const first = (item: ItemId) => [...Array(TIERS.length + 1).keys()].find((k) => producible(k).has(item)) ?? Infinity;
    const benchMade = new Set(RECIPES.filter((r) => r.machine === 'bench').flatMap((r) => r.outputs.map((o) => o.item)));
    for (const item of ITEM_IDS) {
      if (NODE_ITEMS.has(item) || benchMade.has(item)) {
        expect(first(item), item).toBe(0);
        continue;
      }
      // the earliest machine able to make it sets the earliest tier
      const makers = RECIPES.filter((r) => r.outputs.some((o) => o.item === item)).map((r) => r.machine as BuildingType);
      expect(first(item), item).toBeGreaterThanOrEqual(Math.min(...makers.map(tierOf)));
    }
    expect(first('tire')).toBe(tierOf('press'));
    expect(first('chassis')).toBe(tierOf('assembler'));
  });
});
