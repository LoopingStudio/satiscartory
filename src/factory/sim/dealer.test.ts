import { describe, expect, it } from 'vitest';
import { FactorySim, type SaleEvent } from './FactorySim';
import { BELT, DEALER } from '../../data/balance';
import { BUILDINGS } from '../../data/buildings';
import type { Inventory as ItemCounts } from '../../data/items';
import { Inventory, Wallet } from '../../state/Inventory';
import type { ConveyorB, DealerB, FactorySave, MachineB } from './types';
import type { Rot } from './dirs';

const rich = { plate: 10_000, iron_rod: 10_000, bolt: 10_000 };
const T = DEALER.SELL_TICKS;

function sim(storage: ItemCounts = rich) {
  return new FactorySim({ width: 32, height: 32, storage, hub: null });
}

/** A dealer at (10, 10) rot 0: cells (10..12, 10..11), inputs on its back side from (10..12, 9). */
function dealer(s: FactorySim, opts: { free?: boolean } = {}): DealerB {
  const r = s.place('dealer', 10, 10, 0, opts);
  if (!r.ok) throw new Error(`cannot place dealer: ${r.check.error}`);
  return r.building as DealerB;
}

function belt(s: FactorySim, x: number, z: number, rot: Rot = 0): ConveyorB {
  const r = s.place('conveyor', x, z, rot);
  if (!r.ok) throw new Error(`cannot place conveyor: ${r.check.error}`);
  return r.building as ConveyorB;
}

function sales(s: FactorySim): SaleEvent[] {
  const list: SaleEvent[] = [];
  s.events.on('sold', (e) => list.push(e));
  return list;
}

const FULL = { chassis: 1, engine: 1, wheel_racing: 4, panel: 4, spoiler: 1 };

describe('dealer', () => {
  it('takes every car part through its three back inputs and refuses anything else', () => {
    const s = sim();
    const d = dealer(s);
    const belts = [belt(s, 10, 9), belt(s, 11, 9), belt(s, 12, 9)];
    belts[0]!.items.push({ item: 'chassis', pos: 0, prev: 0, from: 2 });
    belts[1]!.items.push({ item: 'plate', pos: 0, prev: 0, from: 2 });
    belts[2]!.items.push({ item: 'wheel', pos: 0, prev: 0, from: 2 });
    s.run(30);
    expect(d.stock).toEqual({ chassis: 1, wheel: 1 });
    // The plate waits at the end of its belt, like an item a machine refuses.
    expect(belts[1]!.items.map((it) => [it.item, it.pos])).toEqual([['plate', BELT.SEG]]);
    const ports = s.portsOf(d.id);
    expect(ports.map((p) => [p.dir, p.side, p.state])).toEqual([['in', 2, 'linked'], ['in', 2, 'linked'], ['in', 2, 'linked']]);
    // No output, and no input on the sides or the front.
    const side = belt(s, 13, 10, 3);
    side.items.push({ item: 'wheel', pos: 0, prev: 0, from: 2 });
    s.run(30);
    expect(side.items.length).toBe(1);
    expect(d.stock.wheel).toBe(1);
  });

  it('takes an assembler’s output directly', () => {
    const s = sim({ ...rich, tire: 10 });
    const d = dealer(s);
    const r = s.place('assembler', 10, 9, 0); // cells (10..11, 9), out +Z into the dealer's back
    if (!r.ok) throw new Error(r.check.error);
    s.setRecipe(r.building.id, 'wheel');
    s.loadFrom(r.building.id, s.hub);
    s.run(4 * 80 + 10);
    expect(d.stock).toEqual({ wheel: 4 });
    expect((r.building as MachineB).outBuf).toEqual([]);
  });

  it('sells the most profitable car its stock allows after SELL_TICKS', () => {
    const s = sim();
    const d = dealer(s);
    const sold = sales(s);
    d.stock = { ...FULL, wheel: 4 };
    s.tick();
    expect(d.car).toEqual({ blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' } });
    expect(d.stock).toEqual({ wheel: 4 });
    expect(s.progressOf(d)).toBe(0);
    s.run(T - 1);
    expect(s.credits).toBe(0);
    expect(s.progressOf(d)).toBeCloseTo((T - 1) / T);
    s.tick();
    expect(s.credits).toBe(7950);
    expect(s.sales).toEqual({ sport: 1 });
    expect(s.carsSold).toBe(1);
    expect(sold).toEqual([{ blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' }, price: 7950, dealer: d.id }]);
    expect(d.car).toBeNull();
    expect(s.progressOf(d)).toBe(0);
  });

  it('chains cars without losing a tick', () => {
    const s = sim();
    const d = dealer(s);
    d.stock = { chassis: 2, engine: 2, wheel: 8 };
    s.run(1 + 2 * T - 1);
    expect(s.credits).toBe(4480);
    s.tick();
    expect(s.credits).toBe(2 * 4480);
    expect(s.sales).toEqual({ kart: 2 });
    expect(d.stock).toEqual({});
  });

  it('a mixed belt never jams it: 9 wheels ahead of the chassis and the engine', () => {
    const s = sim();
    const d = dealer(s);
    const line = [2, 3, 4, 5, 6, 7, 8, 9].map((z) => belt(s, 11, z));
    const queue = [...Array(9).fill('wheel'), 'chassis', 'engine'];
    for (let t = 0; t < 600; t++) {
      const first = line[0]!;
      if (queue.length && first.items.every((it) => it.pos >= BELT.SPACING)) first.items.push({ item: queue.shift()!, pos: 0, prev: 0, from: 2 });
      s.tick();
    }
    expect(queue).toEqual([]);
    expect(s.credits).toBe(4480);
    expect(d.stock).toEqual({ wheel: 5 });
    expect(line.every((c) => c.items.length === 0)).toBe(true);
  });

  it('« Charger » loads exactly the parts of the complete cars, backpack first, with what it holds', () => {
    const s = sim({});
    const d = dealer(s, { free: true });
    const bag = new Inventory();
    bag.add('wheel', 2);
    s.storage = { chassis: 2, engine: 1, wheel: 5, panel: 3, spoiler: 1, plate: 10 };
    d.stock = { panel: 1 };
    const wallet = new Wallet(bag, s.hub);
    expect(s.loadDealer(d.id, wallet)).toEqual({ items: { chassis: 1, engine: 1, wheel: 4, panel: 3, spoiler: 1 }, count: 10, cars: 1, total: 6750 });
    expect(bag.count('wheel')).toBe(0);
    expect([s.count('wheel'), s.count('chassis'), s.count('engine'), s.count('panel'), s.count('spoiler'), s.count('plate')]).toEqual([3, 1, 0, 0, 0, 10]);
    expect(d.stock).toEqual({ chassis: 1, engine: 1, wheel: 4, panel: 4, spoiler: 1 });
    // Nothing more makes a car.
    expect(s.loadDealer(d.id, wallet)).toEqual({ items: {}, count: 0, cars: 0, total: 0 });
    s.run(T + 1);
    expect(s.credits).toBe(6750);
    // Not a dealer: nothing happens.
    expect(s.loadDealer(9999, wallet).count).toBe(0);
  });

  it('« Reprendre » gives the waiting parts back (backpack, then hub), not the car being assembled', () => {
    const s = sim({});
    const d = dealer(s, { free: true });
    d.stock = { chassis: 2, engine: 1, wheel: 30 };
    s.tick(); // a kart starts
    const bag = new Inventory(2);
    expect(s.unloadDealer(d.id, bag)).toEqual({ items: { chassis: 1, wheel: 26 }, count: 27, toHub: 6 });
    expect(bag.totals()).toEqual({ chassis: 1, wheel: 20 });
    expect(s.count('wheel')).toBe(6);
    expect(d.stock).toEqual({});
    expect(d.car?.blueprint).toBe('kart');
    s.run(T);
    expect(s.credits).toBe(4480);
    expect(s.unloadDealer(d.id, bag)).toEqual({ items: {}, count: 0, toHub: 0 });
  });

  it('dismantled mid-sale, it gives back its cost, its stock and the car in progress; credits stay', () => {
    const s = sim();
    const d = dealer(s);
    s.credits = 100;
    d.stock = { chassis: 2, engine: 1, wheel: 9 };
    s.run(50);
    expect(d.car).not.toBeNull();
    const bag = new Inventory();
    expect(s.remove(d.id, bag)).toBe(true);
    expect(bag.totals()).toEqual({ ...BUILDINGS.dealer.cost, chassis: 2, engine: 1, wheel: 9 });
    expect(s.credits).toBe(100);
    expect(s.carsSold).toBe(0);
  });

  it('saved mid-sale, it has the same future, credits and sales included', () => {
    const setup = () => {
      const s = sim();
      dealer(s).stock = { chassis: 5, engine: 5, wheel: 12, wheel_racing: 8, panel: 9, spoiler: 2 };
      return s;
    };
    const a = setup();
    const b = setup();
    a.run(3 * T);
    b.run(T + 37);
    const c = FactorySim.fromSave(JSON.parse(JSON.stringify(b.serialize())) as FactorySave, { width: 32, height: 32, nodes: [] });
    expect(c.hash()).toBe(b.hash());
    expect(c.credits).toBe(b.credits);
    c.run(2 * T - 37);
    expect(c.hash()).toBe(a.hash());
    expect(c.credits).toBe(a.credits);
    expect(a.credits).toBe(2 * 7950);
    expect(c.sales).toEqual({ sport: 2 });
    // Credits and sales are part of the state.
    const h = c.hash();
    c.credits++;
    expect(c.hash()).not.toBe(h);
    c.credits--;
    c.sales.kart = 1;
    expect(c.hash()).not.toBe(h);
  });

  it('a save from before the dealer has no credits; garbage is cleaned on load', () => {
    const s = sim();
    const d = dealer(s);
    const save = JSON.parse(JSON.stringify(s.serialize())) as FactorySave;
    delete save.credits;
    delete save.sales;
    const opts = { width: 32, height: 32, nodes: [] };
    const old = FactorySim.fromSave(save, opts);
    expect([old.credits, old.sales]).toEqual([0, {}]);
    for (const [credits, expected] of [[-5, 0], [1.5, 0], ['x', 0], [12345, 12345]] as const) {
      expect(FactorySim.fromSave({ ...save, credits: credits as number }, opts).credits).toBe(expected);
    }
    const sold = FactorySim.fromSave({ ...save, sales: { kart: 2, sport: -1, loaner: 3, truck: 4 } as FactorySave['sales'] }, opts);
    expect(sold.sales).toEqual({ kart: 2 });

    const withDealer = (b: Record<string, unknown>) => {
      const sv = JSON.parse(JSON.stringify(save)) as FactorySave;
      Object.assign(sv.buildings.find((x) => x.id === d.id)!, b);
      const l = FactorySim.fromSave(sv, opts);
      return { d: l.buildings.get(d.id) as DealerB, l };
    };
    const g = withDealer({ stock: { wheel: 3, plate: 2, unobtainium: 5, engine: -1, chassis: 1.5 } });
    expect(g.d.stock).toEqual({ wheel: 3 });
    expect(g.l.count('plate')).toBe(rich.plate - BUILDINGS.dealer.cost.plate! + 2);
    // A car that is no longer complete: dropped, its parts go to the hub.
    const bad = withDealer({ car: { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } }, progress: 50 });
    expect([bad.d.car, bad.d.progress]).toEqual([null, 0]);
    expect([bad.l.count('chassis'), bad.l.count('engine'), bad.l.count('wheel')]).toEqual([1, 1, 4]);
    const inherited = withDealer({ car: { blueprint: 'constructor', parts: { chassis: 'chassis' } } });
    expect(inherited.d.car).toBeNull();
    expect(inherited.l.count('chassis')).toBe(0);
    const kart = { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } };
    expect(withDealer({ car: kart, progress: 'x' }).d).toMatchObject({ car: kart, progress: 0 });
    expect(withDealer({ car: kart, progress: 120 }).d).toMatchObject({ car: kart, progress: 120 });
    expect(withDealer({ stock: null, car: 'kart' }).d).toMatchObject({ stock: {}, car: null, progress: 0 });
  });
});
