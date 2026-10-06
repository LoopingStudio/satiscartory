import { describe, expect, it } from 'vitest';
import { Inventory, Wallet } from './Inventory';
import { FactorySim } from '../factory/sim/FactorySim';
import { ITEMS } from '../data/items';
import type { MachineB, DrillB } from '../factory/sim/types';

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
    const sim = new FactorySim({ width: 16, height: 16, storage: { plate: 100, bolt: 100 }, hub: null });
    const inv = new Inventory();
    inv.add('plate', 4);
    const w = new Wallet(inv, sim.hub);
    const r = sim.place('press', 2, 2, 0, { wallet: w }); // 6 plates + 4 bolts
    if (!r.ok) throw new Error(r.check.error);
    expect(inv.count('plate')).toBe(0);
    expect(sim.count('plate')).toBe(98);
    expect(sim.count('bolt')).toBe(96);
    sim.remove(r.building.id, inv);
    expect(inv.count('plate')).toBe(6);
    expect(inv.count('bolt')).toBe(4);
  });

  it('affordability checks see backpack + hub together', () => {
    const sim = new FactorySim({ width: 16, height: 16, storage: { plate: 3 }, hub: null });
    const inv = new Inventory();
    inv.add('plate', 2);
    inv.add('bolt', 4);
    expect(sim.check('drill', 0, 0, 0, { free: false }).error).not.toBe('cost'); // needs node first anyway
    expect(sim.check('press', 2, 2, 0).error).toBe('cost');
    expect(sim.check('press', 2, 2, 0, { wallet: new Wallet(inv, sim.hub) }).error).toBe('cost'); // 5 plates < 6
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
    const p = sim.place('press', 5, 5, 0, { free: true });
    if (!p.ok) throw new Error();
    sim.setRecipe(p.building.id, 'plate', inv);
    expect(sim.loadFrom(p.building.id, inv)).toBe(3);
    expect(inv.count('iron_ore')).toBe(0);
  });

  it('item conservation: place, load, collect and dismantle never create or lose items', () => {
    const sim = new FactorySim({ width: 16, height: 16, storage: { plate: 50, bolt: 50, iron_ore: 20 }, hub: null });
    const inv = new Inventory(6);
    const w = new Wallet(inv, sim.hub);
    w.add('iron_ore', 0);
    inv.add('plate', 10);
    const total = () => {
      const all = { ...sim.storage };
      for (const [k, v] of Object.entries(inv.totals())) all[k as 'plate'] = (all[k as 'plate'] ?? 0) + (v ?? 0);
      for (const b of sim.buildings.values()) {
        if (b.type === 'press' || b.type === 'assembler') {
          for (const [k, v] of Object.entries(b.inBuf)) all[k as 'plate'] = (all[k as 'plate'] ?? 0) + (v ?? 0);
          for (const it of b.outBuf) all[it] = (all[it] ?? 0) + 1;
        }
      }
      return all;
    };
    const r = sim.place('press', 2, 2, 0, { wallet: w });
    if (!r.ok) throw new Error();
    sim.setRecipe(r.building.id, 'plate', w);
    sim.loadFrom(r.building.id, w);
    sim.run(200);
    sim.collectOutput(r.building.id, inv);
    sim.remove(r.building.id, w);
    const t = total();
    // 20 ore in, each plate costs 1 ore: ore + plates produced stays 20 + initial plates (60)
    expect((t.iron_ore ?? 0) + (t.plate ?? 0)).toBe(20 + 60);
    expect(t.bolt).toBe(50);
  });
});
