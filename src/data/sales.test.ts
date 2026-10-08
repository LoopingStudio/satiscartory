import { describe, expect, it } from 'vitest';
import { CAR_SALES, PART_VALUES, bestSale, carCost, carLabel, carPrice, formatCredits, nearestSale, planCars, planLoad, priceList, sanitizeCar } from './sales';
import { BLUEPRINTS, CAR_PARTS, isCarPart } from './blueprints';
import { CAR_PARTS as GARAGE_CAR_PARTS } from '../garage/actions';
import { RECIPES } from './recipes';
import { SALE } from './balance';
import type { Inventory, ItemId } from './items';

const KART = { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } as const;
const SPORT = { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' } as const;
const FULL = { ...SPORT, wheels: 'wheel_racing', spoiler: 'spoiler' } as const;

/** Tiny deterministic PRNG for the fuzz tests. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('part values', () => {
  it('values every item from its machine recipe and the drill, never the bench', () => {
    expect(PART_VALUES).toMatchObject({
      iron_ore: 40,
      latex: 40,
      iron_ingot: 80,
      plate: 180, // (3 × 80 + 120) / 2: the bench's 20 ticks would give 130
      iron_rod: 120,
      bolt: 40,
      tire: 140,
      chassis: 880,
      engine: 1100,
      wheel: 400,
      wheel_racing: 640,
      panel: 340,
      spoiler: 460,
    });
    for (const r of RECIPES) {
      if (r.machine === 'bench') continue;
      const made = r.outputs.reduce((n, o) => n + o.count, 0);
      const inputs = r.inputs.reduce((n, i) => n + PART_VALUES[i.item] * i.count, 0);
      for (const o of r.outputs) expect(PART_VALUES[o.item] * made, r.id).toBe(inputs + r.ticks);
    }
    for (const [item, v] of Object.entries(PART_VALUES)) expect(Number.isInteger(v) && v > 0, item).toBe(true);
  });
});

describe('car prices', () => {
  it('prices every car: its parts × 5/4, rounded to 10 cr', () => {
    expect(CAR_SALES.map((s) => [s.blueprint, s.parts, s.price])).toEqual([
      ['sport', FULL, 7950],
      ['sport', { ...SPORT, wheels: 'wheel_racing' }, 7380],
      ['sport', { ...SPORT, spoiler: 'spoiler' }, 6750],
      ['sport', SPORT, 6180],
      ['kart', { ...KART, wheels: 'wheel_racing' }, 5680],
      ['kart', KART, 4480],
    ]);
    for (const s of CAR_SALES) {
      expect(s.price % SALE.ROUND).toBe(0);
      expect(s.cost).toEqual(carCost(s.blueprint, s.parts));
      expect(s.blueprint).not.toBe('loaner');
    }
  });

  it('each better or extra part sells for more', () => {
    expect(carPrice('kart', { ...KART, wheels: 'wheel_racing' })).toBeGreaterThan(carPrice('kart', KART));
    expect(carPrice('sport', SPORT)).toBeGreaterThan(carPrice('kart', KART));
    expect(carPrice('sport', { ...SPORT, spoiler: 'spoiler' })).toBeGreaterThan(carPrice('sport', SPORT));
    expect(carPrice('sport', FULL)).toBeGreaterThan(carPrice('kart', KART));
  });

  it('bad data is worth nothing rather than crashing', () => {
    expect(carPrice('truck', KART)).toBe(0);
    expect(carPrice('constructor', KART)).toBe(0);
    expect(carPrice('loaner', {})).toBe(0);
    expect(carCost('constructor', KART)).toEqual({});
    // A misplaced part counts for nothing: chassis + engine only (1 980 × 5/4 = 2 475 → 2 480).
    expect(carPrice('kart', { ...KART, wheels: 'panel' })).toBe(2480);
    expect(carPrice('kart', { ...KART, wheels: 'unobtainium' })).toBe(2480);
  });

  it('formats credits with plain spaces', () => {
    expect(formatCredits(0)).toBe('0 cr');
    expect(formatCredits(950)).toBe('950 cr');
    expect(formatCredits(4480)).toBe('4 480 cr');
    expect(formatCredits(1234567)).toBe('1 234 567 cr');
    expect(formatCredits(-4480)).toBe('-4 480 cr');
    expect(formatCredits(1234567)).not.toMatch(/[  ]/);
  });

  it('names a car by its options, lists the prices and what each option adds', () => {
    expect(carLabel('kart', KART)).toBe('Kart Oopi');
    expect(carLabel('kart', { ...KART, wheels: 'wheel_racing' })).toBe('Kart Oopi (roues racing)');
    expect(carLabel('sport', { ...SPORT, spoiler: 'spoiler' })).toBe('Sportive (aileron)');
    expect(carLabel('sport', FULL)).toBe('Sportive (roues racing, aileron)');
    const list = priceList();
    expect(list.map((l) => [l.blueprint, l.price, l.bonuses.map((b) => [b.item, b.label, b.bonus])])).toEqual([
      ['kart', 4480, [['wheel_racing', 'roues racing', 1200]]],
      ['sport', 6180, [['wheel_racing', 'roues racing', 1200], ['spoiler', 'aileron', 570]]],
    ]);
  });
});

describe('what a stock sells', () => {
  it('bestSale picks the most profitable car the stock allows', () => {
    const car: Inventory = { chassis: 1, engine: 1 };
    expect(bestSale({})).toBeNull();
    expect(bestSale({ ...car, wheel: 3 })).toBeNull();
    // the 4 wheels of a car are of one sort
    expect(bestSale({ ...car, wheel: 2, wheel_racing: 2 })).toBeNull();
    expect(bestSale({ ...car, wheel: 4 })?.parts).toEqual(KART);
    expect(bestSale({ ...car, wheel: 4, panel: 3 })?.parts).toEqual(KART);
    expect(bestSale({ ...car, wheel: 4, panel: 4 })?.parts).toEqual(SPORT);
    expect(bestSale({ ...car, wheel: 4, panel: 4, spoiler: 1 })?.parts).toEqual({ ...SPORT, spoiler: 'spoiler' });
    const full = bestSale({ ...car, wheel: 4, wheel_racing: 4, panel: 4, spoiler: 1 });
    expect(full?.parts).toEqual(FULL);
    expect(full?.cost).toEqual({ chassis: 1, engine: 1, wheel_racing: 4, panel: 4, spoiler: 1 });
  });

  it('planCars sells everything a stock makes, the best first, without touching it', () => {
    const stock: Inventory = { chassis: 3, engine: 2, wheel: 9, wheel_racing: 4, panel: 5, spoiler: 2 };
    const copy = { ...stock };
    const plan = planCars(stock);
    expect(plan.cars.map((c) => [c.sale.parts, c.n])).toEqual([[FULL, 1], [KART, 1]]);
    expect(plan.count).toBe(2);
    expect(plan.parts).toEqual({ chassis: 2, engine: 2, wheel: 4, wheel_racing: 4, panel: 4, spoiler: 1 });
    expect(plan.total).toBe(7950 + 4480);
    expect(stock).toEqual(copy);
    expect(planCars({ chassis: 10, engine: 10, wheel: 40 })).toMatchObject({ count: 10, total: 44800 });
  });

  it('planCars makes as many cars as the parts allow and leaves nothing that would make one more', () => {
    const rnd = mulberry32(3);
    for (let k = 0; k < 200; k++) {
      const stock: Inventory = {};
      for (const p of CAR_PARTS) stock[p] = Math.floor(rnd() * 14);
      const plan = planCars(stock);
      const w = stock.wheel ?? 0;
      const wr = stock.wheel_racing ?? 0;
      expect(plan.count).toBe(Math.min(stock.chassis ?? 0, stock.engine ?? 0, Math.floor(w / 4) + Math.floor(wr / 4)));
      const left: Inventory = {};
      for (const p of CAR_PARTS) {
        expect(plan.parts[p] ?? 0).toBeLessThanOrEqual(stock[p] ?? 0);
        left[p] = (stock[p] ?? 0) - (plan.parts[p] ?? 0);
      }
      expect(bestSale(left)).toBeNull();
      // the same as taking the best car again and again
      const again: Inventory = { ...stock };
      let total = 0;
      for (let s = bestSale(again); s; s = bestSale(again)) {
        total += s.price;
        for (const [item, n] of Object.entries(s.cost) as [ItemId, number][]) again[item] = (again[item] ?? 0) - n;
      }
      expect(plan.total).toBe(total);
    }
  });

  it('planLoad takes exactly the missing parts of the complete cars, counting only the cars it adds', () => {
    // The dealer holds 1 panel; the bag and hub hold a little of everything.
    const p = planLoad({ panel: 1 }, { chassis: 2, engine: 1, wheel: 7, panel: 3, spoiler: 1 });
    expect(p.load).toEqual({ chassis: 1, engine: 1, wheel: 4, panel: 3, spoiler: 1 });
    expect(p).toMatchObject({ items: 10, cars: 1, total: 6750 });
    // Once loaded, nothing more to take.
    expect(planLoad({ chassis: 1, engine: 1, wheel: 4, panel: 4, spoiler: 1 }, { chassis: 1, wheel: 3 })).toMatchObject({ items: 0, cars: 0, total: 0 });
    // A dealer that already holds a kart: 4 panels make it a Sportive (no new car, but more credits).
    const up = planLoad({ chassis: 1, engine: 1, wheel: 4 }, { panel: 4 });
    expect(up).toMatchObject({ load: { panel: 4 }, items: 4, cars: 0, total: 6180 - 4480 });
    expect(planLoad({}, {})).toEqual({ load: {}, items: 0, cars: 0, total: 0 });
  });

  it('nearestSale says what the closest car misses', () => {
    expect(nearestSale({}).missing).toEqual({ chassis: 1, engine: 1, wheel: 4 });
    expect(nearestSale({ chassis: 1, wheel_racing: 3, wheel: 1 })).toMatchObject({ sale: { parts: { wheels: 'wheel_racing' } }, missing: { engine: 1, wheel_racing: 1 } });
    expect(nearestSale({ chassis: 1, engine: 1, wheel: 2 }).missing).toEqual({ wheel: 2 });
  });
});

describe('save data', () => {
  it('sanitizeCar keeps a complete car of a buildable blueprint, and nothing else', () => {
    expect(sanitizeCar({ blueprint: 'sport', parts: { ...FULL, extra: 'bolt' } })).toEqual({ blueprint: 'sport', parts: FULL });
    expect(sanitizeCar({ blueprint: 'kart', parts: KART })).toEqual({ blueprint: 'kart', parts: KART });
    for (const bad of [
      { blueprint: 'sport', parts: KART }, // no panels
      { blueprint: 'kart', parts: { ...KART, wheels: 'panel' } },
      { blueprint: 'kart', parts: { ...KART, wheels: 'unobtainium' } },
      { blueprint: 'truck', parts: KART },
      { blueprint: 'constructor', parts: KART },
      { blueprint: 'loaner', parts: {} },
      { blueprint: 'kart' },
      { blueprint: 'kart', parts: 'x' },
      null,
      'kart',
    ]) {
      expect(sanitizeCar(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('car parts are the slot parts of the blueprints, shared with the garage', () => {
    expect(CAR_PARTS).toEqual(['chassis', 'engine', 'wheel', 'wheel_racing', 'panel', 'spoiler']);
    expect(GARAGE_CAR_PARTS).toBe(CAR_PARTS);
    expect(isCarPart('plate')).toBe(false);
    expect(isCarPart('spoiler')).toBe(true);
    for (const bp of Object.values(BLUEPRINTS)) for (const s of bp.slots) for (const i of s.accepts) expect(isCarPart(i)).toBe(true);
  });
});
