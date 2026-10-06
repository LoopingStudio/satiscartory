import { describe, expect, it } from 'vitest';
import { GameState } from './GameState';
import { FACTORY_MAP } from '../data/factoryMap';
import { BUILDINGS } from '../data/buildings';
import { RECIPES_BY_ID } from '../data/recipes';
import { TIERS } from '../data/tiers';
import { DRILL } from '../data/balance';

describe('bootstrap of a new game (hand mining → bench → tiers)', () => {
  it('reaches tier 2 from nothing with only the hands, the bench and a first drill', () => {
    // The numbers below follow these costs.
    expect(TIERS[0]!.cost).toEqual({ iron_rod: 10 });
    expect(TIERS[1]!.cost).toEqual({ plate: 10, iron_rod: 10 });
    expect(BUILDINGS.drill.cost).toEqual({ plate: 6, iron_rod: 4 });

    const s = new GameState(); // default map and hub, empty hub, tier 0
    expect(s.sim.storage).toEqual({});
    const node = FACTORY_MAP.nodes.find((n) => n.resource === 'iron')!; // the starting iron node, west of the hub
    const cell = { x: node.x + 1, z: node.z + 1 };
    let mined = 0;
    const mine = (n: number) => {
      for (let i = 0; i < n; i++) expect(s.sim.mineAt(cell.x, cell.z, s.inventory)).toBe('iron_ore');
      mined += n;
    };
    const craft = (id: string, n: number) => {
      for (let i = 0; i < n; i++) expect(s.wallet().craft(RECIPES_BY_ID[id]!)).toBe(true);
    };

    // Tier 1 (10 rods): 12 ore → 12 ingots → 12 rods; 5 of them wait at the hub.
    expect(s.isUnlocked('drill')).toBe(false);
    mine(12);
    expect(s.inventory.totals()).toEqual({ iron_ore: 12 });
    craft('hand_ingot', 12);
    craft('hand_rod', 12);
    expect(s.inventory.totals()).toEqual({ iron_rod: 12 });
    s.inventory.remove('iron_rod', 5);
    s.sim.give({ iron_rod: 5 });
    expect(s.unlockNextTier()).toEqual({ ok: true });
    expect(s.tier).toBe(1);
    // paid with the 7 rods of the backpack first, then 3 from the hub
    expect(s.inventory.count('iron_rod')).toBe(0);
    expect(s.sim.count('iron_rod')).toBe(2);
    expect(s.isUnlocked('drill') && s.isUnlocked('conveyor')).toBe(true);
    expect(s.isUnlocked('smelter')).toBe(false);

    // The tier survives a save.
    const reloaded = GameState.fromSave(JSON.parse(JSON.stringify(s.serialize())));
    expect(reloaded.tier).toBe(1);
    expect(reloaded.sim.count('iron_rod')).toBe(2);

    // First drill (6 plates + 4 rods, 2 rods already at the hub): 11 more ore by hand.
    mine(11);
    craft('hand_ingot', 11);
    craft('hand_plate', 3); // 9 ingots → 6 plates
    craft('hand_rod', 2);
    expect(s.inventory.totals()).toEqual({ plate: 6, iron_rod: 2 });
    const d = s.sim.place('drill', node.x + 2, node.z, 1, { wallet: s.wallet() }); // cells (x+2, z..z+1)
    if (!d.ok) throw new Error(d.check.error);
    expect(s.inventory.usedSlots).toBe(0);
    expect(s.sim.count('iron_rod')).toBe(0);
    expect(s.sim.mineAt(node.x + 2, node.z, s.inventory)).toBeNull(); // under the drill now
    // no belt yet: its ore is picked up by hand (E → « Prendre »)
    s.sim.run(DRILL.PERIOD * DRILL.OUT_CAP);
    expect(s.sim.collectOutput(d.building.id, s.inventory)).toBe(DRILL.OUT_CAP);

    // Tier 2 (10 plates + 10 rods = 15 + 10 ingots): the drill's 5 ore + 20 by hand.
    mine(20);
    expect(s.inventory.count('iron_ore')).toBe(25);
    craft('hand_ingot', 25);
    craft('hand_plate', 5);
    craft('hand_rod', 10);
    expect(s.inventory.totals()).toEqual({ plate: 10, iron_rod: 10 });
    expect(s.unlockNextTier()).toEqual({ ok: true });
    expect(s.tier).toBe(2);
    expect(s.inventory.usedSlots).toBe(0);
    expect(s.isUnlocked('smelter')).toBe(true);
    expect(s.isUnlocked('press')).toBe(false);

    // Nothing left: tier 3 reports its whole cost as missing and changes nothing.
    expect(s.unlockNextTier()).toEqual({ ok: false, missing: TIERS[2]!.cost });
    expect(s.tier).toBe(2);

    // 43 ore by hand; hand work is not factory production
    expect(mined).toBe(43);
    expect(s.sim.crafted).toEqual({ iron_ore: DRILL.OUT_CAP });
    expect(s.sim.delivered).toEqual({});
    expect(s.sim.storage).toEqual({ iron_rod: 0 });
  });
});
