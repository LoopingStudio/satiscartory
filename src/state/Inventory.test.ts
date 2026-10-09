import { describe, expect, it } from 'vitest';
import { Inventory, Wallet } from './Inventory';
import { FactorySim } from '../factory/sim/FactorySim';
import { ITEMS, type Inventory as ItemCounts, type ItemId } from '../data/items';
import { BUILDINGS } from '../data/buildings';
import { RECIPES_BY_ID, recipesFor } from '../data/recipes';
import { isMachine, type MachineB, type DrillB, type DealerB } from '../factory/sim/types';
import { carCost } from '../data/sales';
import { CAR_PARTS } from '../data/blueprints';
import { DEALER } from '../data/balance';

describe('Inventory (backpack)', () => {
  it('stacks up to the per-item stack size and reports leftovers', () => {
    const inv = new Inventory(3);
    expect(inv.add('engine', 25)).toBe(25); // stack 10 → 3 slots: 10, 10, 5
    expect(inv.usedSlots).toBe(3);
    expect(inv.add('engine', 10)).toBe(5); // only 5 room left
    expect(inv.add('plate', 1)).toBe(0); // no free slot
    expect(inv.count('engine')).toBe(30);
    expect(inv.room('engine')).toBe(0);
  });

  it('merges into existing stacks before using new slots', () => {
    const inv = new Inventory(4);
    inv.add('plate', 30);
    inv.add('bolt', 5);
    inv.add('plate', 30);
    expect(inv.slots.filter((s) => s?.item === 'plate')).toEqual([{ item: 'plate', count: 60 }]);
  });

  it('removes across stacks and frees emptied slots', () => {
    const inv = new Inventory(4);
    inv.add('wheel', 30); // 20 + 10
    expect(inv.remove('wheel', 25)).toBe(25);
    expect(inv.count('wheel')).toBe(5);
    expect(inv.usedSlots).toBe(1);
    expect(inv.remove('wheel', 99)).toBe(5);
    expect(inv.usedSlots).toBe(0);
  });

  it('moves, merges and swaps slots (drag and drop)', () => {
    const inv = new Inventory(4);
    inv.add('plate', 70); // slot 0
    inv.add('bolt', 5); // slot 1
    expect(inv.move(0, 3)).toBe(true); // into an empty slot
    expect(inv.slots).toEqual([null, { item: 'bolt', count: 5 }, null, { item: 'plate', count: 70 }]);
    expect(inv.move(1, 3)).toBe(true); // different item: swap
    expect(inv.slots).toEqual([null, { item: 'plate', count: 70 }, null, { item: 'bolt', count: 5 }]);
    inv.slots[0] = { item: 'plate', count: 50 };
    expect(inv.move(0, 1)).toBe(true); // same item: merge up to the stack size, remainder stays
    expect(inv.slots[1]).toEqual({ item: 'plate', count: 100 });
    expect(inv.slots[0]).toEqual({ item: 'plate', count: 20 });
    expect(inv.move(0, 1)).toBe(false); // target stack full
    expect(inv.move(1, 0)).toBe(true); // 100 onto 20: 80 move, 20 stay
    expect(inv.slots[0]).toEqual({ item: 'plate', count: 100 });
    expect(inv.slots[1]).toEqual({ item: 'plate', count: 20 });
    expect(inv.count('plate')).toBe(120);
  });

  it('ignores invalid moves', () => {
    const inv = new Inventory(3);
    inv.add('tire', 4);
    const before = inv.serialize();
    expect(inv.move(0, 0)).toBe(false);
    expect(inv.move(2, 0)).toBe(false); // empty source
    expect(inv.move(0, 3)).toBe(false);
    expect(inv.move(-1, 0)).toBe(false);
    expect(inv.move(0, 1.5)).toBe(false);
    expect(inv.serialize()).toEqual(before);
  });

  it('round-trips through save data and sanitizes it', () => {
    const inv = new Inventory();
    inv.add('tire', 12);
    expect(Inventory.fromSave(JSON.parse(JSON.stringify(inv.serialize()))).count('tire')).toBe(12);
    const bad = Inventory.fromSave([{ item: 'nope', count: 3 }, { item: 'plate', count: 9999 }, { item: 'bolt', count: -2 }, 'x']);
    expect(bad.totals()).toEqual({ plate: ITEMS.plate.stack });
  });
});

describe('Wallet (backpack first, then hub)', () => {
  it('counts both, spends the backpack first and overflows refunds to the hub', () => {
    const sim = new FactorySim({ width: 16, height: 16, storage: { plate: 10 }, hub: null });
    const inv = new Inventory(1);
    inv.add('plate', 4);
    const w = new Wallet(inv, sim.hub);
    expect(w.count('plate')).toBe(14);
    expect(w.remove('plate', 6)).toBe(6);
    expect(inv.count('plate')).toBe(0);
    expect(sim.count('plate')).toBe(8);
    inv.add('bolt', 1); // occupy the only slot
    expect(w.add('plate', 5)).toBe(5);
    expect(sim.count('plate')).toBe(13);
  });

  it('pays building costs from the backpack first and refunds dismantling into it', () => {
    const sim = new FactorySim({ width: 16, height: 16, storage: { plate: 100, iron_rod: 100, bolt: 100 }, hub: null });
    const inv = new Inventory();
    inv.add('plate', 4);
    const w = new Wallet(inv, sim.hub);
    const cost = BUILDINGS.press.cost; // plates, rods and bolts
    const r = sim.place('press', 2, 2, 0, { wallet: w });
    if (!r.ok) throw new Error(r.check.error);
    expect(inv.count('plate')).toBe(0);
    expect(sim.count('plate')).toBe(100 - (cost.plate! - 4));
    expect(sim.count('iron_rod')).toBe(100 - cost.iron_rod!);
    expect(sim.count('bolt')).toBe(100 - cost.bolt!);
    sim.remove(r.building.id, inv);
    expect(inv.totals()).toEqual(cost);
  });

  it('affordability checks see backpack + hub together', () => {
    const cost = BUILDINGS.press.cost;
    // the hub has every rod and bolt but 3 plates; the backpack has 4 plates short of the rest
    const sim = new FactorySim({ width: 16, height: 16, storage: { plate: 3, iron_rod: cost.iron_rod!, bolt: cost.bolt! }, hub: null });
    const inv = new Inventory();
    inv.add('plate', cost.plate! - 4);
    expect(sim.check('drill', 0, 0, 0, { free: false }).error).not.toBe('cost'); // needs node first anyway
    expect(sim.check('press', 2, 2, 0).error).toBe('cost');
    const short = sim.check('press', 2, 2, 0, { wallet: new Wallet(inv, sim.hub) });
    expect(short.error).toBe('cost');
    expect(short.missing).toEqual({ plate: 1 });
    inv.add('plate', 1);
    expect(sim.check('press', 2, 2, 0, { wallet: new Wallet(inv, sim.hub) }).ok).toBe(true);
  });
});

describe('collecting from machines into the backpack', () => {
  it('takes a machine output into the backpack; what does not fit stays in the machine', () => {
    const sim = new FactorySim({ width: 16, height: 16, storage: {}, hub: null });
    const r = sim.place('assembler', 2, 2, 0, { free: true });
    if (!r.ok) throw new Error();
    const m = r.building as MachineB;
    sim.setRecipe(m.id, 'engine');
    m.outBuf = Array(8).fill('engine');
    const inv = new Inventory(1); // one slot of 10 engines
    inv.add('engine', 7);
    expect(sim.collectOutput(m.id, inv)).toBe(3);
    expect(m.outBuf).toHaveLength(5);
    expect(inv.count('engine')).toBe(10);
  });

  it('collects a drill output and loads a machine from the backpack', () => {
    const sim = new FactorySim({ width: 16, height: 16, storage: {}, hub: null, nodes: [{ resource: 'iron', x: 1, z: 1, w: 1, h: 1 }] });
    const d = sim.place('drill', 1, 1, 0, { free: true });
    if (!d.ok) throw new Error();
    sim.run(40 * 3);
    const inv = new Inventory();
    expect(sim.collectOutput(d.building.id, inv)).toBe(3);
    expect((d.building as DrillB).outBuf).toEqual([]);
    const f = sim.place('smelter', 5, 5, 0, { free: true });
    if (!f.ok) throw new Error();
    sim.setRecipe(f.building.id, 'iron_ingot', inv);
    expect(sim.loadFrom(f.building.id, inv)).toBe(3);
    expect(inv.count('iron_ore')).toBe(0);
  });

  it('part conservation with a dealer: load, sell, take back and dismantle; credits are the prices sold', () => {
    const sim = new FactorySim({ width: 16, height: 16, storage: { plate: 100, iron_rod: 100, bolt: 200, chassis: 4, engine: 3, wheel: 9, wheel_racing: 6, panel: 7, spoiler: 2 }, hub: null });
    const inv = new Inventory(4);
    inv.add('wheel', 3);
    inv.add('panel', 2);
    const w = new Wallet(inv, sim.hub);
    const sold: ItemCounts = {};
    let prices = 0;
    sim.events.on('sold', (e) => {
      prices += e.price;
      for (const [k, v] of Object.entries(carCost(e.blueprint, e.parts)) as [ItemId, number][]) sold[k] = (sold[k] ?? 0) + v;
    });
    const total = () => {
      const all: ItemCounts = {};
      const put = (item: ItemId, n: number) => (all[item] = (all[item] ?? 0) + n);
      for (const [k, v] of Object.entries(sim.storage) as [ItemId, number][]) put(k, v);
      for (const [k, v] of Object.entries(inv.totals()) as [ItemId, number][]) put(k, v);
      for (const [k, v] of Object.entries(sold) as [ItemId, number][]) put(k, v);
      for (const b of sim.buildings.values()) {
        if (b.type !== 'dealer') continue;
        for (const [k, v] of Object.entries(BUILDINGS.dealer.cost) as [ItemId, number][]) put(k, v);
        for (const [k, v] of Object.entries(b.stock) as [ItemId, number][]) put(k, v);
        if (b.car) for (const [k, v] of Object.entries(carCost(b.car.blueprint, b.car.parts)) as [ItemId, number][]) put(k, v);
      }
      return Object.fromEntries(Object.entries(all).filter(([, v]) => v));
    };
    const start = total();
    const check = () => {
      expect(total()).toEqual(start);
      expect(sim.credits).toBe(prices);
    };
    const r = sim.place('dealer', 2, 2, 0, { wallet: w });
    if (!r.ok) throw new Error(r.check.error);
    const id = r.building.id;
    check();
    expect(sim.loadDealer(id, w).count).toBeGreaterThan(0);
    check();
    sim.run(DEALER.SELL_TICKS + 30); // one car sold, the next one under way
    check();
    expect(sim.carsSold).toBe(1);
    sim.unloadDealer(id, inv);
    check();
    sim.loadDealer(id, w);
    sim.run(DEALER.SELL_TICKS / 2);
    expect((sim.buildings.get(id) as DealerB).car).not.toBeNull();
    check();
    sim.remove(id, inv);
    check();
    for (const p of CAR_PARTS) expect(sold[p] ?? 0, p).toBeGreaterThanOrEqual(0);
    expect(prices).toBeGreaterThan(0);
  });

  it('the credits ledger: credits = Σ cars sold + Σ worn sets sold − Σ spent, whatever the order', () => {
    const sim = new FactorySim({ width: 16, height: 16, storage: {}, hub: null });
    let ledger = 0;
    sim.events.on('sold', (e) => (ledger += e.price));
    sim.events.on('soldWorn', (e) => (ledger += e.price));
    sim.events.on('spent', (e) => (ledger -= e.amount));
    const r = sim.place('dealer', 2, 2, 0, { free: true });
    if (!r.ok) throw new Error(r.check.error);
    (r.building as DealerB).stock = { chassis: 2, engine: 2, wheel: 8 };
    const kart = { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } as const;
    const steps: (() => unknown)[] = [
      () => sim.run(DEALER.SELL_TICKS + 1),
      () => sim.sell('kart', kart, null, { wheels: 640, engine: 90 }),
      () => sim.spend(530, 'repair'),
      () => sim.sellWorn('wheel', 4, 312),
      () => sim.spend(sim.credits + 1, 'repair'), // refused
      () => sim.sellWorn('wheel', 3, 312), // refused
      () => sim.spend(sim.credits, 'repair'),
      () => sim.run(DEALER.SELL_TICKS + 1),
      () => sim.sellWorn('panel', 4, 1000),
      () => sim.spend(10, 'repair'),
    ];
    for (const step of steps) {
      step();
      expect(sim.credits).toBe(ledger);
      expect(sim.credits).toBeGreaterThanOrEqual(0);
    }
    expect(sim.carsSold).toBe(3);
  });

  it('item conservation: place, load, collect and dismantle never create or lose items', () => {
    const sim = new FactorySim({ width: 16, height: 16, storage: { plate: 50, iron_rod: 50, bolt: 50, iron_ore: 20 }, hub: null });
    const inv = new Inventory(6);
    const w = new Wallet(inv, sim.hub);
    inv.add('plate', 10);
    /** Everything held by the hub, the backpack and the buildings (cost, buffers, inputs of a craft in progress). */
    const total = () => {
      const all: ItemCounts = { ...sim.storage };
      const put = (item: ItemId, n: number) => (all[item] = (all[item] ?? 0) + n);
      for (const [k, v] of Object.entries(inv.totals()) as [ItemId, number][]) put(k, v);
      for (const b of sim.buildings.values()) {
        if (!b.free) for (const [k, v] of Object.entries(BUILDINGS[b.type].cost) as [ItemId, number][]) put(k, v);
        if (!isMachine(b)) continue;
        for (const [k, v] of Object.entries(b.inBuf) as [ItemId, number][]) put(k, v);
        for (const it of b.outBuf) put(it, 1);
        if (b.status === 'working') for (const st of RECIPES_BY_ID[b.recipe!]!.inputs) put(st.item, st.count);
      }
      return all;
    };
    // Iron content: 1 ore → 1 ingot, 3 ingots → 2 plates. With ore = ingot = 2, a plate weighs 3.
    const iron = (t: ItemCounts) => 2 * ((t.iron_ore ?? 0) + (t.iron_ingot ?? 0)) + 3 * (t.plate ?? 0);
    const start = iron(total());
    const run = (n: number) => {
      for (let i = 0; i < n; i += 10) {
        sim.run(10);
        expect(iron(total())).toBe(start);
      }
    };
    const f = sim.place('smelter', 2, 2, 0, { wallet: w });
    const p = sim.place('press', 2, 6, 0, { wallet: w });
    if (!f.ok || !p.ok) throw new Error();
    sim.setRecipe(f.building.id, 'iron_ingot', w);
    sim.setRecipe(p.building.id, 'iron_plate', w);
    expect(sim.loadFrom(f.building.id, w)).toBe(10); // manual cap: 1 ore × 10
    run(500);
    expect(sim.collectOutput(f.building.id, inv)).toBe(10);
    expect(sim.loadFrom(f.building.id, w)).toBe(10); // the other 10 ore
    expect(sim.loadFrom(p.building.id, w)).toBe(10); // 10 ingots (cap 30)
    run(250); // two plate crafts done, a third in progress, and the smelter halfway
    expect(iron(total())).toBe(start);
    sim.collectOutput(p.building.id, inv);
    sim.remove(f.building.id, w);
    sim.remove(p.building.id, w);
    const t = total();
    expect(iron(t)).toBe(start);
    expect(t.iron_ingot ?? 0).toBeGreaterThan(0);
    expect(t.plate).toBeGreaterThan(60);
    // building costs come back in full
    expect(t.iron_rod).toBe(50);
    expect(t.bolt).toBe(50);
  });
});

describe('hand crafting at the bench (Wallet.craft)', () => {
  const bench = (id: string) => {
    const r = RECIPES_BY_ID[id];
    if (!r || r.machine !== 'bench') throw new Error(`not a bench recipe: ${id}`);
    return r;
  };
  const setup = (storage: ItemCounts, slots?: number) => {
    const sim = new FactorySim({ width: 8, height: 8, storage, hub: null });
    const inv = new Inventory(slots);
    return { sim, inv, w: new Wallet(inv, sim.hub) };
  };

  it('takes the inputs from the backpack first, then the hub, and puts the result in the backpack', () => {
    const { sim, inv, w } = setup({ iron_ingot: 5 });
    inv.add('iron_ingot', 2);
    expect(w.craft(bench('hand_plate'))).toBe(true); // 3 ingots → 2 plates
    expect(inv.totals()).toEqual({ plate: 2 });
    expect(sim.storage).toEqual({ iron_ingot: 4 });
  });

  it('outputs overflow to the hub when the backpack is full', () => {
    const { sim, inv, w } = setup({ iron_ingot: 3 }, 2);
    inv.add('iron_ore', ITEMS.iron_ore.stack);
    inv.add('plate', ITEMS.plate.stack - 1);
    expect(w.craft(bench('hand_plate'))).toBe(true);
    expect(inv.totals()).toEqual({ iron_ore: ITEMS.iron_ore.stack, plate: ITEMS.plate.stack });
    expect(sim.storage).toEqual({ iron_ingot: 0, plate: 1 });
  });

  it('inputs leave before outputs arrive, so a backpack full of inputs keeps the result', () => {
    const { sim, inv, w } = setup({}, 1);
    inv.add('iron_rod', 1);
    expect(w.craft(bench('hand_bolts'))).toBe(true);
    expect(inv.totals()).toEqual({ bolt: 4 });
    expect(sim.storage).toEqual({});
  });

  it('changes nothing when an input is missing', () => {
    const { sim, inv, w } = setup({ iron_ingot: 1, bolt: 3 });
    inv.add('iron_ingot', 1);
    inv.add('plate', 2);
    inv.add('iron_rod', 2);
    const state = () => ({ inv: inv.serialize(), hub: { ...sim.storage } });
    const before = state();
    expect(w.craft(bench('hand_plate'))).toBe(false); // 2 ingots < 3
    expect(state()).toEqual(before);
    // several inputs: the ones present are not taken either
    expect(w.craft(RECIPES_BY_ID.chassis!)).toBe(false); // 3 bolts < 4
    expect(state()).toEqual(before);
    // the same item listed twice adds up
    expect(w.craft({ inputs: [{ item: 'iron_ingot', count: 1 }, { item: 'iron_ingot', count: 2 }], outputs: [{ item: 'plate', count: 1 }] })).toBe(false);
    expect(state()).toEqual(before);
    // with the missing bolt, the chassis is made by hand from both sides
    sim.give({ bolt: 1 });
    expect(w.craft(RECIPES_BY_ID.chassis!)).toBe(true);
    expect(inv.totals()).toEqual({ iron_ingot: 1, chassis: 1 });
    expect(sim.storage).toEqual({ iron_ingot: 1, bolt: 0 });
  });

  it('conserves iron over a long series of crafts split between the backpack and the hub', () => {
    const { sim, inv, w } = setup({ iron_ore: 300, iron_ingot: 7 }, 3);
    inv.add('iron_ore', 50);
    // Iron content: ore = ingot = rod = 12, plate = 3 × 12 / 2 = 18, bolt = 12 / 4 = 3.
    const weight: ItemCounts = { iron_ore: 12, iron_ingot: 12, iron_rod: 12, plate: 18, bolt: 3 };
    const iron = () => (Object.entries(weight) as [ItemId, number][]).reduce((s, [item, k]) => s + k * w.count(item), 0);
    const start = iron();
    const recipes = recipesFor('bench');
    expect(recipes.map((r) => r.id).sort()).toEqual(['hand_bolts', 'hand_ingot', 'hand_plate', 'hand_rod']);
    let crafted = 0;
    let seed = 7;
    for (let i = 0; i < 400; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648; // deterministic pick
      if (w.craft(recipes[(seed >>> 16) % recipes.length]!)) crafted++;
      expect(iron()).toBe(start);
    }
    expect(crafted).toBeGreaterThan(200);
    // both sides were used: hub ore went in, and the 3-slot backpack overflowed products to the hub
    expect(sim.count('iron_ore')).toBeLessThan(300);
    expect(sim.count('iron_rod') + sim.count('plate') + sim.count('bolt')).toBeGreaterThan(0);
  });
});
