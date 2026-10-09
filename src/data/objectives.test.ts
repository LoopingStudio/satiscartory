import { describe, expect, it } from 'vitest';
import { OBJECTIVES, type ObjectiveContext } from './objectives';
import { HAND, START_STORAGE } from './balance';
import { BUILDINGS } from './buildings';
import { FACTORY_MAP, RESOURCES } from './factoryMap';
import { recipesFor } from './recipes';
import { TIERS } from './tiers';
import type { Inventory, ItemId } from './items';
import { FACTORY_HZ } from '../config/constants';

const base: ObjectiveContext = { buildings: [{ type: 'hub' }], storage: {}, cars: 0, delivered: {}, crafted: {}, blueprints: [], racesWithOwnCar: 0, tier: 0, carsSold: 0, repaired: false };
const done = (c: ObjectiveContext) => OBJECTIVES.filter((o) => o.done(c)).map((o) => o.id);
const ids = OBJECTIVES.map((o) => o.id);

/** Evaluates the contexts in turn like FactoryMode (an objective stays done once done): ids completed at each step. */
function play(steps: ObjectiveContext[]): string[][] {
  const seen = new Set<string>();
  return steps.map((c) => {
    const now = done(c).filter((id) => !seen.has(id));
    for (const id of now) seen.add(id);
    return now;
  });
}

describe('onboarding objectives', () => {
  it('start with nothing done and follow the progression in order', () => {
    expect(new Set(ids).size).toBe(ids.length);
    expect(done(base)).toEqual([]);
    // A plausible run: each step completes exactly the next objective.
    const iron = [{ type: 'drill', resource: 'iron' }];
    const steps: Partial<ObjectiveContext>[] = [
      { storage: { iron_ore: 5 } }, // mined by hand
      { storage: { iron_rod: 10 } }, // ore crafted into rods at the bench
      { tier: 1 }, // rods spent on Extraction
      { tier: 1, buildings: iron, delivered: { iron_ore: 3 } },
      { tier: 2, buildings: iron, delivered: { iron_ore: 40 } },
      { tier: 2, delivered: { iron_ore: 40, iron_ingot: 1 } },
      { tier: 3, delivered: { iron_ore: 40, iron_ingot: 30 } },
      { tier: 3, delivered: { iron_ingot: 30, plate: 2 } },
      { tier: 3, delivered: { plate: 40 }, crafted: { tire: 1 } }, // tires made by a constructor
      { tier: 4 },
      { tier: 4, storage: { wheel: 4, chassis: 1, engine: 1 } },
      { tier: 5, storage: { wheel: 4, chassis: 1, engine: 1 } }, // Garage tier
      { tier: 5, buildings: [{ type: 'garage' }] },
      { tier: 5, cars: 1, blueprints: ['kart'] },
      { tier: 5, cars: 1, blueprints: ['kart'], racesWithOwnCar: 1 },
      { tier: 5, cars: 1, blueprints: ['kart'], racesWithOwnCar: 1, repaired: true }, // the race wore a part
      { tier: 6, cars: 1, blueprints: ['kart'], racesWithOwnCar: 1, repaired: true }, // Commerce tier
      { tier: 6, cars: 1, blueprints: ['kart'], racesWithOwnCar: 1, repaired: true, buildings: [{ type: 'dealer' }] },
      { tier: 6, cars: 1, blueprints: ['kart'], racesWithOwnCar: 1, repaired: true, carsSold: 1 },
      { tier: 6, cars: 2, blueprints: ['kart', 'sport'], racesWithOwnCar: 1, repaired: true, carsSold: 1 },
    ];
    expect(play(steps.map((s) => ({ ...base, ...s })))).toEqual(ids.map((id) => [id]));
  });

  it('machine steps also complete when the output is taken by hand instead of belted to the hub', () => {
    const at = (tier: number, crafted: ObjectiveContext['crafted']) => done({ ...base, tier, crafted });
    expect(at(1, { iron_ore: 1 })).toContain('drill_ore'); // « Prendre » on the drill
    expect(at(2, { iron_ingot: 1 })).toContain('smelt');
    expect(at(3, { plate: 2 })).toContain('plates'); // hand-fed constructor
    // The bench never counts as machine production.
    expect(at(3, {})).not.toContain('plates');
  });

  it('saves from before the tiers (everything unlocked) skip the bootstrap steps', () => {
    const old = { ...base, tier: TIERS.length };
    // Everything but the steps that need cars, parts, a garage or a dealer built, a repair, a sale.
    expect(done(old)).toEqual(ids.filter((id) => !['car_parts', 'garage', 'assembled', 'race', 'repair', 'dealer', 'sell', 'sport'].includes(id)));
    expect(done({ ...old, cars: 1, blueprints: ['kart'], racesWithOwnCar: 1 })).toEqual(ids.filter((id) => !['repair', 'dealer', 'sell', 'sport'].includes(id)));
  });

  it('a repair at the garage completes « repair », right after the first race', () => {
    expect(ids.indexOf('repair')).toBe(ids.indexOf('race') + 1);
    expect(done({ ...base, repaired: true })).toEqual(['repair']);
    expect(done({ ...base, tier: 6, cars: 1, racesWithOwnCar: 1 })).not.toContain('repair');
  });

  it('selling a car completes « sell », a dealer on the map « dealer »', () => {
    expect(done({ ...base, tier: 6, carsSold: 1 })).toContain('sell');
    expect(done({ ...base, tier: 6, carsSold: 1 })).not.toContain('dealer');
    expect(done({ ...base, tier: 6, buildings: [{ type: 'dealer' }] })).toContain('dealer');
  });

  it('a new game starts with an empty hub, and tier 1 plus a first iron chain take under two minutes by hand', () => {
    expect(START_STORAGE).toEqual({});
    const mined = new Set(FACTORY_MAP.nodes.map((n) => RESOURCES[n.resource].item));
    const bench = recipesFor('bench');
    /** Seconds of hand work (mining + bench) per unit of an item. */
    const seconds = (item: ItemId): number => {
      if (mined.has(item)) return HAND.MINE_SECONDS;
      const r = bench.find((x) => x.outputs.some((o) => o.item === item));
      if (!r) return Infinity;
      const inputs = r.inputs.reduce((s, i) => s + i.count * seconds(i.item), 0);
      return (r.ticks / FACTORY_HZ + inputs) / r.outputs.find((o) => o.item === item)!.count;
    };
    const time = (cost: Inventory, k = 1) => k * (Object.entries(cost) as [ItemId, number][]).reduce((s, [i, n]) => s + n * seconds(i), 0);
    // Belts from the nearest iron node to the hub (3×3).
    const hub = FACTORY_MAP.hub;
    const belts = Math.min(
      ...FACTORY_MAP.nodes
        .filter((n) => n.resource === 'iron')
        .map((n) => Math.max(0, hub.x - (n.x + n.w), n.x - (hub.x + 3)) + Math.max(0, hub.z - (n.z + n.h), n.z - (hub.z + 3)) + 1),
    );
    expect(belts).toBeLessThanOrEqual(16);
    const total = time(TIERS[0]!.cost) + time(BUILDINGS.drill.cost) + time(BUILDINGS.conveyor.cost, belts);
    expect(total).toBeLessThan(120);
  });
});
