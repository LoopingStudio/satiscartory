import { describe, expect, it } from 'vitest';
import { FactorySim, type SaleEvent, type SimEvents } from './FactorySim';
import type { FactorySave } from './types';
import { WEAR } from '../../data/balance';
import { wornCarPrice, wornSetPrice } from '../../data/wear';
import type { ItemId } from '../../data/items';

const KART = { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } as const;

function sim(credits = 0) {
  const s = new FactorySim({ width: 16, height: 16, hub: null });
  s.credits = credits;
  return s;
}

function events(s: FactorySim) {
  const log = { sold: [] as SaleEvent[], soldWorn: [] as SimEvents['soldWorn'][], spent: [] as SimEvents['spent'][] };
  s.events.on('sold', (e) => log.sold.push(e));
  s.events.on('soldWorn', (e) => log.soldWorn.push(e));
  s.events.on('spent', (e) => log.spent.push(e));
  return log;
}

describe('credits: spending', () => {
  it('spend takes a safe integer within the balance, and says so', () => {
    const s = sim(500);
    const log = events(s);
    expect(s.spend(120, 'repair')).toBe(true);
    expect(s.credits).toBe(380);
    expect(s.spend(380, 'repair')).toBe(true);
    expect(s.credits).toBe(0);
    expect(log.spent).toEqual([{ amount: 120, reason: 'repair' }, { amount: 380, reason: 'repair' }]);
  });

  it('refuses anything else without changing the balance or emitting', () => {
    const s = sim(500);
    const log = events(s);
    for (const amount of [0, -10, 1.5, NaN, Infinity, 501, Number.MAX_SAFE_INTEGER + 2, '50' as unknown as number]) {
      expect(s.spend(amount, 'repair'), String(amount)).toBe(false);
    }
    expect(s.credits).toBe(500);
    expect(log.spent).toEqual([]);
    expect(sim(0).spend(10, 'repair')).toBe(false);
  });
});

describe('credits: worn parts and worn cars', () => {
  it('sellWorn credits a whole slot by its state, a second source of credits, not a car sale', () => {
    const s = sim(100);
    const log = events(s);
    expect(s.sellWorn('wheel', 4, 580)).toBe(672);
    expect(s.sellWorn('chassis', 1, WEAR.MAX)).toBe(0);
    expect(s.credits).toBe(772);
    expect([s.sales, s.carsSold]).toEqual([{}, 0]);
    expect(log.soldWorn).toEqual([{ item: 'wheel', n: 4, wear: 580, price: 672 }, { item: 'chassis', n: 1, wear: WEAR.MAX, price: 0 }]);
    expect(log.sold).toEqual([]);
  });

  it('sellWorn refuses an invalid set: not a car part, not a whole slot, a wear out of 1..1000 or not an integer', () => {
    const s = sim(100);
    const log = events(s);
    const bad: [string, number, number][] = [['tire', 4, 300], ['plate', 1, 300], ['wheel', 2, 300], ['wheel', 1, 300], ['spoiler', 4, 300], ['wheel', 4, 0], ['wheel', 4, 1001], ['wheel', 4, 2.5], ['wheel', 4, NaN], ['nope', 1, 300]];
    for (const [item, n, w] of bad) expect(s.sellWorn(item as ItemId, n, w), `${item} ${n} ${w}`).toBeNull();
    expect(s.credits).toBe(100);
    expect(log.soldWorn).toEqual([]);
  });

  it('a worn car sells for its new price minus its repair; the event and the count stay those of a car', () => {
    const s = sim();
    const log = events(s);
    const price = s.sell('kart', KART, null, { wheels: 500 });
    expect(price).toBe(4130);
    expect(price).toBe(wornCarPrice('kart', KART, { wheels: 500 }));
    expect(s.sell('kart', KART)).toBe(4480);
    expect(s.sell('kart', KART, null, {})).toBe(4480);
    expect(s.credits).toBe(4130 + 2 * 4480);
    expect([s.sales, s.carsSold]).toEqual([{ kart: 3 }, 3]);
    expect(log.sold[0]).toEqual({ blueprint: 'kart', parts: { ...KART }, price: 4130, dealer: null });
  });

  it('every way in and out is in the state: hash, save and reload', () => {
    const a = sim(1000);
    const b = sim(1000);
    expect(a.hash()).toBe(b.hash());
    a.spend(10, 'repair');
    expect(a.hash()).not.toBe(b.hash());
    b.sellWorn('spoiler', 1, 500);
    b.spend(10 + wornSetPrice('spoiler', 1, 500), 'repair');
    // Same balance, same state.
    expect(b.credits).toBe(a.credits);
    expect(b.hash()).toBe(a.hash());
    const c = FactorySim.fromSave(JSON.parse(JSON.stringify(a.serialize())) as FactorySave, { width: 16, height: 16, nodes: [] });
    expect(c.credits).toBe(990);
    expect(c.hash()).toBe(a.hash());
  });
});
