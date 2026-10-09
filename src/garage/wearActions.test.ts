import { describe, expect, it } from 'vitest';
import { GameState } from '../state/GameState';
import { FactorySim } from '../factory/sim/FactorySim';
import { BLUEPRINTS, CAR_PARTS, blueprintById, type BlueprintId } from '../data/blueprints';
import { ITEM_IDS, type Inventory as ItemCounts, type ItemId } from '../data/items';
import { WEAR } from '../data/balance';
import { carCost, creditsShown } from '../data/sales';
import { repairCredits, repairItems, sanitizeWornSet, wornCarPrice, wornSetPrice, type WornSet } from '../data/wear';
import { defaultChoices, type CarInstance } from './assembly';
import { type GarageSpot } from './parking';
import { assembleCar, disassembleCar, partStock, sellCar, swapCarPart } from './actions';
import { abandonBuild, buildIn, installBuildPart, removeBuildPart } from './buildActions';
import {
  carQuote, installWornInBuild, installWornSet, payCheck, quoteCaps, renewCarSlot, repairCar, repairCarSlot, repairWornSet, sellWornSet, setQuote,
  slotForSet, slotQuote, wornGroups, type Pay, type RepairQuote,
} from './wearActions';

const g1: GarageSpot = { id: 50, x: 40, z: 40, rot: 0 };
const g2: GarageSpot = { id: 51, x: 50, z: 40, rot: 1 };
const KART = defaultChoices(BLUEPRINTS.kart);
const KART_PARTS = { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } as const;
const SPORT_FULL = { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' } as const;

/** The whole game state as saved, without its timestamp: a refused action must leave it exactly as it was. */
const snapshot = (s: GameState) => JSON.stringify({ ...s.serialize(), savedAt: 0 });

/** A game with a kart in g1's bay, worn as given, and the kit materials split between the backpack and the hub. */
function withKart(wear?: CarInstance['wear']): { s: GameState; car: CarInstance } {
  const s = new GameState(FactorySim.newGame({ terrain: 'flat' }));
  s.sim.give({ chassis: 1, engine: 1, wheel: 4 });
  const car = assembleCar(s, 'kart', KART, g1)!;
  if (wear) car.wear = { ...wear };
  s.inventory.add('tire', 2);
  s.sim.give({ tire: 10, plate: 10, iron_rod: 10, bolt: 20 });
  return { s, car };
}

describe('wear actions: quotes', () => {
  it('a slot quote is the kit of its part, worn as the slot is; none for a new, empty or unknown slot', () => {
    const { car } = withKart({ wheels: 800, engine: 250 });
    expect(slotQuote(car, 'wheels')).toEqual({ items: { tire: 4 }, credits: 560 });
    expect(slotQuote(car, 'engine')).toEqual({ items: repairItems('engine', 1, 250), credits: repairCredits('engine', 1, 250) });
    expect([slotQuote(car, 'chassis'), slotQuote(car, 'panels'), slotQuote(car, 'nope')]).toEqual([null, null, null]);
    const all = carQuote(car)!;
    expect(all.credits).toBe(560 + repairCredits('engine', 1, 250));
    expect(all.items).toEqual({ tire: 4, plate: 1, iron_rod: 1, bolt: 1 });
    expect(carQuote({ ...car, wear: undefined })).toBeNull();
  });

  it('payCheck: what the backpack and the hub miss, how many credits are short', () => {
    const { s } = withKart();
    const q: RepairQuote = { items: { tire: 13, plate: 2 }, credits: 300 };
    expect(payCheck(s, q, 'items')).toEqual({ ok: false, missing: { tire: 1 } });
    expect(payCheck(s, q, 'credits')).toEqual({ ok: false, short: 300 });
    s.sim.credits = 300;
    expect(payCheck(s, q, 'credits')).toEqual({ ok: true });
    expect(payCheck(s, { items: { tire: 12 }, credits: 10 }, 'items')).toEqual({ ok: true });
  });
});

describe('wear actions: repairing a car', () => {
  it('in items: the backpack pays first, then the hub; the slot is new again and « repair » is done', () => {
    const { s, car } = withKart({ wheels: 800, engine: 40 });
    const res = repairCarSlot(s, car.id, 'wheels', 'items');
    expect(res).toEqual({ paid: { items: { tire: 4 } } });
    expect(s.inventory.count('tire')).toBe(0);
    expect(s.sim.count('tire')).toBe(8);
    expect(car.wear).toEqual({ engine: 40 });
    expect(s.objectives.repair).toBe(true);
    expect(s.objectives.creditsSpent).toBeUndefined();
    // The last worn slot repaired: no `wear` key at all.
    expect(repairCarSlot(s, car.id, 'engine', 'items')).not.toBeNull();
    expect('wear' in car).toBe(false);
  });

  it('in credits: spent from the sim; refused without changing anything when short', () => {
    const { s, car } = withKart({ wheels: 800 });
    s.sim.credits = 559;
    const before = snapshot(s);
    expect(repairCarSlot(s, car.id, 'wheels', 'credits')).toBeNull();
    expect(snapshot(s)).toBe(before);
    expect(s.objectives.repair).toBeUndefined();
    s.sim.credits = 600;
    expect(repairCarSlot(s, car.id, 'wheels', 'credits')).toEqual({ paid: { credits: 560 } });
    expect(s.sim.credits).toBe(40);
    expect('wear' in car).toBe(false);
    expect(s.objectives.creditsSpent).toBe(true);
  });

  it('the balance shows once credits were earned or spent: not after a repair paid in items, still at 0 after one paid in credits', () => {
    // Tier 5: the garage is there, the dealer not yet; nothing sold, no credit.
    const { s, car } = withKart({ wheels: 25, engine: 400 });
    s.tier = 5;
    expect([s.isUnlocked('garage'), s.isUnlocked('dealer')]).toEqual([true, false]);
    const shown = () => creditsShown({ credits: s.sim.credits, carsSold: s.sim.carsSold, creditsSpent: !!s.objectives.creditsSpent, dealerUnlocked: s.isUnlocked('dealer') });
    expect(shown()).toBe(false);
    // « Répare une pièce au garage » with a tire: the objective is done, no credit moved.
    expect(repairCarSlot(s, car.id, 'wheels', 'items')).toEqual({ paid: { items: { tire: 1 } } });
    expect(s.objectives.repair).toBe(true);
    expect(s.sim.credits).toBe(0);
    expect(shown()).toBe(false);
    // A worn set sold: credits earned, shown; every one of them spent on a repair: still shown, at 0.
    s.worn.push({ item: 'wheel', n: 4, wear: 600 });
    expect(sellWornSet(s, s.worn[0]!)).not.toBeNull();
    expect(shown()).toBe(true);
    s.sim.credits = slotQuote(car, 'engine')!.credits;
    expect(repairCarSlot(s, car.id, 'engine', 'credits')).not.toBeNull();
    expect(s.sim.credits).toBe(0);
    expect(shown()).toBe(true);
    // Saved with the objectives (SaveData unchanged).
    expect(GameState.fromSave(s.serialize()).objectives.creditsSpent).toBe(true);
  });

  it('refusals change nothing: a new slot, an unknown car or slot, missing items', () => {
    const { s, car } = withKart({ engine: 900 });
    s.sim.credits = 10_000;
    const before = snapshot(s);
    for (const pay of ['items', 'credits'] as Pay[]) {
      expect(repairCarSlot(s, car.id, 'wheels', pay)).toBeNull();
      expect(repairCarSlot(s, 'car-9', 'engine', pay)).toBeNull();
      expect(repairCarSlot(s, car.id, 'turbo', pay)).toBeNull();
    }
    s.sim.hub.remove('plate', 10);
    const poorer = snapshot(s);
    expect(repairCarSlot(s, car.id, 'engine', 'items')).toBeNull();
    expect(snapshot(s)).toBe(poorer);
    expect(before).not.toBe(poorer);
  });

  it('« Tout réparer » is all or nothing: one quote for every worn slot', () => {
    const { s, car } = withKart({ wheels: 800, engine: 250, chassis: 100 });
    s.sim.hub.remove('iron_rod', 9);
    // One rod for the engine and one for the chassis: one is missing, nothing is paid.
    const before = snapshot(s);
    expect(repairCar(s, car.id, 'items')).toBeNull();
    expect(snapshot(s)).toBe(before);
    s.sim.give({ iron_rod: 1 });
    const q = carQuote(car)!;
    const res = repairCar(s, car.id, 'items')!;
    expect(res).toEqual({ paid: { items: q.items }, slots: ['chassis', 'engine', 'wheels'] });
    expect('wear' in car).toBe(false);
    expect(repairCar(s, car.id, 'items')).toBeNull();
    // In credits: the sum of the slots' credits; a worn car sells for exactly that less.
    const { s: t, car: c } = withKart({ wheels: 800, engine: 250, chassis: 100 });
    t.sim.credits = 10_000;
    expect(wornCarPrice('kart', c.parts, c.wear) + carQuote(c)!.credits).toBe(4480);
    expect(repairCar(t, c.id, 'credits')).toEqual({ paid: { credits: 760 }, slots: ['chassis', 'engine', 'wheels'] });
    expect(t.sim.credits).toBe(10_000 - 760);
  });
});

describe('wear actions: worn parts go to the reserve', () => {
  it('« Remplacer par du neuf »: new parts of the same kind from the stock, the worn ones to the reserve', () => {
    const { s, car } = withKart({ wheels: 540, engine: 20 });
    s.sim.give({ wheel: 4 });
    const stock = partStock(s);
    expect(renewCarSlot(s, car.id, 'wheels')).toEqual({ item: 'wheel', n: 4, wear: 540 });
    expect(car.parts.wheels).toBe('wheel');
    expect(car.wear).toEqual({ engine: 20 });
    expect(partStock(s).wheel ?? 0).toBe(stock.wheel! - 4);
    expect(s.worn).toEqual([{ item: 'wheel', n: 4, wear: 540 }]);
    // A renewal is no repair.
    expect(s.objectives.repair).toBeUndefined();
  });

  it('« Remplacer par du neuf » with too few in stock, or on a new slot, changes nothing (nothing is made from nothing)', () => {
    const { s, car } = withKart({ wheels: 540 });
    s.inventory.add('wheel', 1);
    s.sim.give({ wheel: 2 });
    const before = snapshot(s);
    expect(renewCarSlot(s, car.id, 'wheels')).toBeNull();
    expect(snapshot(s)).toBe(before);
    s.sim.give({ wheel: 1, engine: 1 });
    const again = snapshot(s);
    expect(renewCarSlot(s, car.id, 'engine')).toBeNull();
    expect(renewCarSlot(s, car.id, 'spoiler')).toBeNull();
    expect(snapshot(s)).toBe(again);
    expect(renewCarSlot(s, car.id, 'wheels')).not.toBeNull();
    // The backpack's wheel went first.
    expect(s.inventory.count('wheel')).toBe(0);
  });

  it('swapping a worn part sends it to the reserve, a new one back to the backpack; taking a worn spoiler off too', () => {
    const s = new GameState(FactorySim.newGame({ terrain: 'flat' }));
    s.sim.give({ chassis: 1, engine: 1, wheel_racing: 4, panel: 4, spoiler: 1, wheel: 4 });
    const car = assembleCar(s, 'sport', { ...SPORT_FULL }, g1)!;
    car.wear = { wheels: 300, spoiler: 620 };
    expect(swapCarPart(s, car.id, 'wheels', 'wheel')).toBe(true);
    expect(s.worn).toEqual([{ item: 'wheel_racing', n: 4, wear: 300 }]);
    expect(partStock(s).wheel_racing ?? 0).toBe(0);
    expect(swapCarPart(s, car.id, 'spoiler', null)).toBe(true);
    expect(s.worn).toEqual([{ item: 'wheel_racing', n: 4, wear: 300 }, { item: 'spoiler', n: 1, wear: 620 }]);
    expect('wear' in car).toBe(false);
    // A new part goes back to the backpack, as before.
    s.sim.give({ wheel_racing: 4 });
    expect(swapCarPart(s, car.id, 'wheels', 'wheel_racing')).toBe(true);
    expect(s.inventory.count('wheel')).toBe(4);
    expect(s.worn).toHaveLength(2);
  });

  it('dismantling: new parts to the backpack, worn ones to the reserve as whole sets', () => {
    const { s, car } = withKart({ wheels: 700, chassis: 3 });
    const res = disassembleCar(s, car.id)!;
    expect(res.refund).toEqual({ engine: 1 });
    expect(res.worn).toEqual([{ item: 'chassis', n: 1, wear: 3 }, { item: 'wheel', n: 4, wear: 700 }]);
    expect(s.worn).toEqual(res.worn);
    expect(s.inventory.count('engine')).toBe(1);
    expect(partStock(s).wheel ?? 0).toBe(0);
  });

  it('selling a worn car credits its worn price', () => {
    const { s, car } = withKart({ wheels: 500 });
    expect(sellCar(s, car.id)!.price).toBe(4130);
    expect(s.sim.credits).toBe(4130);
    expect(s.worn).toEqual([]);
  });
});

describe('wear actions: the reserve', () => {
  it('repairing a set: paid in items or credits, its parts come back new (backpack first, overflow: hub)', () => {
    const { s } = withKart();
    const set: WornSet = { item: 'wheel', n: 4, wear: 580 };
    s.worn.push(set, { item: 'chassis', n: 1, wear: 1000 });
    expect(repairWornSet(s, set, 'items')).toEqual({ paid: { items: { tire: 3 } }, toHub: 0 });
    expect(s.worn).toEqual([{ item: 'chassis', n: 1, wear: 1000 }]);
    expect(s.inventory.count('wheel')).toBe(4);
    expect(s.objectives.repair).toBe(true);
    // In credits, with a full backpack: the hub gets the parts.
    s.inventory.add('iron_ore', 1e6);
    s.sim.credits = 480;
    expect(repairWornSet(s, s.worn[0]!, 'credits')).toEqual({ paid: { credits: 480 }, toHub: 1 });
    expect(s.sim.count('chassis')).toBe(1);
    expect([s.worn, s.sim.credits]).toEqual([[], 0]);
  });

  it('a set not in the reserve (a copy, already gone), or not affordable: nothing changes', () => {
    const { s } = withKart();
    const set: WornSet = { item: 'engine', n: 1, wear: 1000 };
    s.worn.push(set);
    const before = snapshot(s);
    expect(repairWornSet(s, { ...set }, 'items')).toBeNull();
    expect(sellWornSet(s, { ...set })).toBeNull();
    expect(installWornSet(s, 'car-1', 'engine', { ...set })).toBe(false);
    expect(installWornInBuild(s, g2, 'kart', 'engine', { ...set })).toBeNull();
    expect(repairWornSet(s, set, 'credits')).toBeNull();
    expect(snapshot(s)).toBe(before);
  });

  it('selling a set credits its price by state and takes it out', () => {
    const { s } = withKart();
    const set: WornSet = { item: 'wheel', n: 4, wear: 580 };
    s.worn.push(set);
    expect(sellWornSet(s, set)).toEqual({ price: 672 });
    expect([s.worn, s.sim.credits, s.sim.carsSold]).toEqual([[], 672, 0]);
    expect(sellWornSet(s, set)).toBeNull();
  });

  it('putting a set on the car: it keeps its wear; the parts in place go to the reserve when worn, to the backpack when new', () => {
    const { s, car } = withKart({ engine: 80 });
    const wheels: WornSet = { item: 'wheel_racing', n: 4, wear: 420 };
    const engine: WornSet = { item: 'engine', n: 1, wear: 600 };
    s.worn.push(wheels, engine);
    expect(installWornSet(s, car.id, 'wheels', wheels)).toBe(true);
    expect(car.parts.wheels).toBe('wheel_racing');
    expect(car.wear).toEqual({ engine: 80, wheels: 420 });
    expect(s.inventory.count('wheel')).toBe(4);
    expect(installWornSet(s, car.id, 'engine', engine)).toBe(true);
    expect(car.wear).toEqual({ engine: 600, wheels: 420 });
    expect(s.worn).toEqual([{ item: 'engine', n: 1, wear: 80 }]);
    // A slot that does not take it, a whole slot only: refused.
    const before = snapshot(s);
    expect(installWornSet(s, car.id, 'chassis', s.worn[0]!)).toBe(false);
    expect(installWornSet(s, car.id, 'panels', s.worn[0]!)).toBe(false);
    expect(installWornSet(s, 'car-9', 'engine', s.worn[0]!)).toBe(false);
    expect(snapshot(s)).toBe(before);
  });

  it('a set starts a build in an empty bay; completed, the car rolls out with the wear of its sets', () => {
    const { s, car } = withKart({ wheels: 300, chassis: 20 });
    disassembleCar(s, car.id);
    expect(s.worn).toHaveLength(2);
    // The bay of g1 is free again: the worn wheels start a kart there.
    const wheels = s.worn.find((w) => w.item === 'wheel')!;
    expect(installWornInBuild(s, g1, 'kart', 'wheels', wheels)).toEqual({ car: null });
    expect(buildIn(s, g1.id)!.parts.wheels).toEqual({ item: 'wheel', n: 4, wear: 300 });
    // The engine is new (from the backpack), the chassis the worn one.
    expect(installBuildPart(s, g1, 'kart', 'engine', 'engine').n).toBe(1);
    const res = installWornInBuild(s, g1, 'kart', 'chassis', s.worn[0]!)!;
    expect(res.car).toMatchObject({ blueprint: 'kart', parts: { ...KART_PARTS }, wear: { wheels: 300, chassis: 20 } });
    expect(s.worn).toEqual([]);
    expect(s.builds).toEqual([]);
    expect(s.cars).toEqual([res.car]);
  });

  it('a set goes only into an empty slot of a build of the same blueprint, in a bay without a car', () => {
    const { s, car } = withKart();
    const wheels: WornSet = { item: 'wheel', n: 4, wear: 300 };
    const panels: WornSet = { item: 'panel', n: 4, wear: 300 };
    s.worn.push(wheels, panels);
    const before = snapshot(s);
    // A car in g1's bay; a kart has no panels; the loaner is not buildable.
    expect(installWornInBuild(s, g1, 'kart', 'wheels', wheels)).toBeNull();
    expect(installWornInBuild(s, g2, 'kart', 'panels', panels)).toBeNull();
    expect(installWornInBuild(s, g2, 'loaner' as BlueprintId, 'wheels', wheels)).toBeNull();
    expect(installWornInBuild(s, g2, 'kart', 'chassis', wheels)).toBeNull();
    expect(snapshot(s)).toBe(before);
    // Two new wheels in g2's slot first: the set waits.
    s.sim.give({ wheel: 2 });
    installBuildPart(s, g2, 'kart', 'wheels', 'wheel');
    const started = snapshot(s);
    expect(installWornInBuild(s, g2, 'kart', 'wheels', wheels)).toBeNull();
    expect(installWornInBuild(s, g2, 'sport', 'panels', panels)).toBeNull();
    expect(snapshot(s)).toBe(started);
    expect(car.id).toBe('car-1');
  });

  it('a worn set taken off a build or left by an abandoned one goes back to the reserve, new parts to the backpack', () => {
    const { s } = withKart();
    const chassis: WornSet = { item: 'chassis', n: 1, wear: 910 };
    const wheels: WornSet = { item: 'wheel', n: 4, wear: 120 };
    s.worn.push(chassis, wheels);
    installWornInBuild(s, g2, 'kart', 'chassis', chassis);
    installWornInBuild(s, g2, 'kart', 'wheels', wheels);
    s.sim.give({ engine: 1 });
    expect(removeBuildPart(s, g2.id, 'chassis')).toEqual({ n: 1, toHub: 0 });
    expect(s.worn).toEqual([{ item: 'chassis', n: 1, wear: 910 }]);
    expect(s.inventory.count('chassis')).toBe(0);
    s.inventory.add('engine', 1);
    expect(installBuildPart(s, g2, 'kart', 'engine', 'engine').n).toBe(1);
    expect(abandonBuild(s, g2.id)).toMatchObject({ refund: { engine: 1 } });
    expect(s.worn).toEqual([{ item: 'chassis', n: 1, wear: 910 }, { item: 'wheel', n: 4, wear: 120 }]);
    expect(s.builds).toEqual([]);
  });
});

describe('wear actions: the reserve as the garage lists it', () => {
  it('wornGroups: by item, count and state shown; the most worn set of a group acts; CAR_PARTS order, least worn first', () => {
    const a: WornSet = { item: 'wheel', n: 4, wear: 581 };
    const b: WornSet = { item: 'wheel', n: 4, wear: 590 };
    const c: WornSet = { item: 'chassis', n: 1, wear: 100 };
    const d: WornSet = { item: 'wheel', n: 4, wear: 300 };
    const e: WornSet = { item: 'wheel_racing', n: 4, wear: 999 };
    const f: WornSet = { item: 'wheel', n: 4, wear: 585 };
    const groups = wornGroups([a, c, b, d, e, f]);
    expect(groups.map((g) => [g.key, g.count])).toEqual([['chassis:1:90', 1], ['wheel:4:70', 1], ['wheel:4:41', 3], ['wheel_racing:4:0', 1]]);
    // The reserve's own objects (the actions find a set by identity), the group's most worn one.
    expect(groups[2]!.set).toBe(b);
    expect(groups[0]!.set).toBe(c);
    // A tie keeps the first one.
    const twin: WornSet = { ...a };
    expect(wornGroups([a, twin])[0]!.set).toBe(a);
    expect(wornGroups([])).toEqual([]);
  });

  it('a group acts on its own set: repaired, the group shrinks and keeps its key while a set is left', () => {
    const { s } = withKart();
    s.worn.push({ item: 'wheel', n: 4, wear: 581 }, { item: 'wheel', n: 4, wear: 590 });
    const [g] = wornGroups(s.worn);
    expect(repairWornSet(s, g!.set, 'items')).toMatchObject({ paid: { items: setQuote('wheel', 4, 590).items } });
    expect(s.worn).toEqual([{ item: 'wheel', n: 4, wear: 581 }]);
    expect(wornGroups(s.worn).map((x) => [x.key, x.count])).toEqual([[g!.key, 1]]);
  });

  it('quoteCaps: the most of each item any quote asks for (the refresh key caps the stock at it)', () => {
    expect(quoteCaps([])).toEqual({});
    const q = (items: RepairQuote['items']): RepairQuote => ({ items, credits: 10 });
    expect(quoteCaps([q({ tire: 4 }), q({ tire: 7, plate: 1 }), q({ plate: 2, bolt: 4, iron_rod: 1 })])).toEqual({ tire: 7, plate: 2, bolt: 4, iron_rod: 1 });
  });

  it('slotForSet: the slot that takes the set (item and count), null for none or an odd blueprint', () => {
    expect(slotForSet('kart', { item: 'wheel_racing', n: 4 })?.id).toBe('wheels');
    expect(slotForSet('sport', { item: 'spoiler', n: 1 })?.id).toBe('spoiler');
    expect(slotForSet('kart', { item: 'panel', n: 4 })).toBeNull();
    expect(slotForSet('kart', { item: 'wheel', n: 2 })).toBeNull();
    expect(slotForSet('constructor', { item: 'wheel', n: 4 })).toBeNull();
  });
});

// ------------------------------------------------------------------ random actions: nothing is ever made from nothing

/** Random actions, weighted so that cars, builds and worn sets come and go. */
const ACTIONS = Object.entries({
  assemble: 3, drive: 6, swap: 3, renew: 3, repairSlot: 3, repairCar: 1, disassemble: 1, sell: 1, repairSet: 2, sellSet: 1,
  installSet: 3, setInBuild: 4, buildPart: 1, removeBuildPart: 1, abandon: 1, give: 1,
}).flatMap(([name, w]) => Array<string>(w).fill(name));

describe('wear actions: 500 random actions', () => {
  /** Successful actions of every run, by kind. */
  const covered: Record<string, number> = {};

  it.each([2026, 7, 99, 1234])('keep every item, every credit and every thousandth of wear accounted for (seed %i)', (first) => {
    let seed = first;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed >>> 16) % n;
    };
    const pick = <T>(list: readonly T[]): T | undefined => (list.length ? list[rnd(list.length)] : undefined);

    const s = new GameState(FactorySim.newGame({ terrain: 'flat' }));
    s.sim.give({ chassis: 12, engine: 12, wheel: 48, wheel_racing: 24, panel: 24, spoiler: 4, tire: 60, plate: 60, iron_rod: 30, bolt: 90 });
    s.inventory.add('wheel', 3);
    s.sim.credits = 6000;
    const garages: GarageSpot[] = [g1, g2, { id: 52, x: 60, z: 40, rot: 0 }, { id: 53, x: 40, z: 60, rot: 2 }];

    // Sources and sinks, from the sim's events and the actions' results.
    const out: ItemCounts = {};
    const add = (c: ItemCounts, item: ItemId, n: number) => (c[item] = (c[item] ?? 0) + n);
    let ledger = s.sim.credits;
    s.sim.events.on('sold', (e) => {
      ledger += e.price;
      for (const [item, n] of Object.entries(carCost(e.blueprint, e.parts)) as [ItemId, number][]) add(out, item, n);
    });
    s.sim.events.on('soldWorn', (e) => {
      ledger += e.price;
      add(out, e.item, e.n);
    });
    s.sim.events.on('spent', (e) => (ledger -= e.amount));

    /** Every item held: backpack, hub, cars, builds, reserve, plus what left (sold, spent on repairs). */
    const held = (): ItemCounts => {
      const all: ItemCounts = {};
      for (const id of ITEM_IDS) {
        const n = s.wallet().count(id) + (out[id] ?? 0);
        if (n) all[id] = n;
      }
      for (const car of s.cars) for (const sl of blueprintById(car.blueprint)!.slots) if (car.parts[sl.id]) add(all, car.parts[sl.id]!, sl.count);
      for (const b of s.builds) for (const p of Object.values(b.parts)) add(all, p.item, p.n);
      for (const w of s.worn) add(all, w.item, w.n);
      return all;
    };
    /** Wear (‰ × parts) on cars, builds and in the reserve. */
    const wearMass = () => {
      let m = 0;
      for (const car of s.cars) for (const sl of blueprintById(car.blueprint)!.slots) if (car.parts[sl.id]) m += (car.wear?.[sl.id] ?? 0) * sl.count;
      for (const b of s.builds) for (const p of Object.values(b.parts)) m += (p.wear ?? 0) * p.n;
      for (const w of s.worn) m += w.wear * w.n;
      return m;
    };
    const paidItems = (paid: Partial<RepairQuote>) => {
      for (const [item, n] of Object.entries(paid.items ?? {}) as [ItemId, number][]) add(out, item, n);
      expect((paid.credits ?? 0) > 0 || Object.keys(paid.items ?? {}).length > 0, 'a repair is never free').toBe(true);
    };

    const start = held();
    const counts: Record<string, number> = {};
    for (let step = 0; step < 500; step++) {
      const car = pick(s.cars);
      const slots = car ? blueprintById(car.blueprint)!.slots : [];
      const slot = pick(slots);
      const set = pick(s.worn);
      const pay: Pay = rnd(2) ? 'items' : 'credits';
      const before = snapshot(s);
      const massBefore = wearMass();
      let expectedMass = massBefore;
      let changed: boolean;
      const name = pick(ACTIONS)!;
      switch (name) {
        case 'assemble': {
          const bp = pick(['kart', 'sport'] as const)!;
          changed = !!assembleCar(s, bp, defaultChoices(BLUEPRINTS[bp]), pick(garages)!);
          break;
        }
        case 'drive': {
          // Wear comes from driving (the meter): any installed part, a whole number of thousandths, up to MAX.
          changed = false;
          if (car && slot && car.parts[slot.id]) {
            const cur = car.wear?.[slot.id] ?? 0;
            const next = Math.min(WEAR.MAX, cur + 1 + rnd(400));
            if (next !== cur) {
              (car.wear ??= {})[slot.id] = next;
              expectedMass += (next - cur) * slot.count;
              changed = true;
            }
          }
          break;
        }
        case 'swap':
          changed = !!car && !!slot && swapCarPart(s, car.id, slot.id, pick([...(slot.optional ? [null] : []), ...slot.accepts])!);
          break;
        case 'renew':
          changed = !!car && !!slot && !!renewCarSlot(s, car.id, slot.id);
          break;
        case 'repairSlot': {
          const w = car && slot && car.parts[slot.id] ? (car.wear?.[slot.id] ?? 0) * slot.count : 0;
          const res = car && slot ? repairCarSlot(s, car.id, slot.id, pay) : null;
          if (res) {
            paidItems(res.paid);
            expectedMass -= w;
          }
          changed = !!res;
          break;
        }
        case 'repairCar': {
          let w = 0;
          for (const sl of slots) if (car!.parts[sl.id]) w += (car!.wear?.[sl.id] ?? 0) * sl.count;
          const res = car ? repairCar(s, car.id, pay) : null;
          if (res) {
            paidItems(res.paid);
            expectedMass -= w;
          }
          changed = !!res;
          break;
        }
        case 'disassemble':
          changed = !!car && !!disassembleCar(s, car.id);
          break;
        case 'sell': {
          let w = 0;
          for (const sl of slots) if (car!.parts[sl.id]) w += (car!.wear?.[sl.id] ?? 0) * sl.count;
          const res = car ? sellCar(s, car.id) : null;
          if (res) {
            expectedMass -= w;
            expect(res.price).toBe(wornCarPrice(res.car.blueprint, res.car.parts, res.car.wear));
          }
          changed = !!res;
          break;
        }
        case 'repairSet': {
          const res = set ? repairWornSet(s, set, pay) : null;
          if (res) {
            paidItems(res.paid);
            expectedMass -= set!.wear * set!.n;
          }
          changed = !!res;
          break;
        }
        case 'sellSet': {
          const res = set ? sellWornSet(s, set) : null;
          if (res) {
            expectedMass -= set!.wear * set!.n;
            expect(res.price).toBe(wornSetPrice(set!.item, set!.n, set!.wear));
          }
          changed = !!res;
          break;
        }
        case 'installSet': {
          // Mostly into a slot that takes the set (a random one now and then).
          const fit = rnd(4) ? (pick(slots.filter((sl) => set && sl.accepts.includes(set.item))) ?? slot) : slot;
          changed = !!car && !!fit && !!set && installWornSet(s, car.id, fit.id, set);
          break;
        }
        case 'setInBuild': {
          // Into a build under way (its blueprint), or a bay picked at random; mostly a slot that takes the set.
          const b = rnd(2) ? pick(s.builds) : undefined;
          const g = b ? garages.find((x) => x.id === b.garage)! : pick(garages)!;
          const bp = b?.blueprint ?? pick(['kart', 'sport'] as const)!;
          const sl = (rnd(4) ? pick(BLUEPRINTS[bp].slots.filter((x) => set && x.accepts.includes(set.item))) : undefined) ?? pick(BLUEPRINTS[bp].slots)!;
          changed = !!set && !!installWornInBuild(s, g, bp, sl.id, set);
          break;
        }
        case 'buildPart': {
          const bp = pick(['kart', 'sport'] as const)!;
          const sl = pick(BLUEPRINTS[bp].slots)!;
          changed = installBuildPart(s, pick(garages)!, bp, sl.id, pick(sl.accepts)!).n > 0;
          break;
        }
        case 'removeBuildPart': {
          const b = pick(s.builds);
          const slotId = b && rnd(4) ? pick(Object.keys(b.parts))! : pick(['chassis', 'engine', 'wheels', 'panels', 'spoiler'])!;
          changed = removeBuildPart(s, b?.garage ?? pick(garages)!.id, slotId).n > 0;
          break;
        }
        case 'abandon':
          changed = !!abandonBuild(s, pick(garages)!.id);
          break;
        default: {
          // More of everything now and then (the factory keeps producing): counted as a source.
          const item = pick([...CAR_PARTS, 'tire', 'plate', 'iron_rod', 'bolt'] as ItemId[])!;
          s.sim.give({ [item]: 4 });
          add(start, item, 4);
          if (rnd(4) === 0) {
            s.sim.credits += 500;
            ledger += 500;
          }
          changed = true;
        }
      }
      if (changed) counts[name] = (counts[name] ?? 0) + 1;
      else expect(snapshot(s), `${step}: refused ${name} changed the state`).toBe(before);
      // Items: none made or lost; credits: the ledger; wear: only driving adds, only a paid repair or a sale removes.
      expect(held(), `${step} ${name}`).toEqual(start);
      expect(s.sim.credits, `${step} ${name}`).toBe(ledger);
      expect(s.sim.credits).toBeGreaterThanOrEqual(0);
      expect(wearMass(), `${step} ${name}`).toBe(expectedMass);
      for (const w of s.worn) expect(sanitizeWornSet(w), `${step} ${name}`).toEqual(w);
      for (const c of s.cars) if (c.wear) expect(Object.values(c.wear).every((w) => Number.isInteger(w) && w! >= 1 && w! <= WEAR.MAX) && Object.keys(c.wear).length > 0, `${step} ${name}`).toBe(true);
      for (const id of ITEM_IDS) expect(s.wallet().count(id)).toBeGreaterThanOrEqual(0);
    }
    for (const [name, n] of Object.entries(counts)) covered[name] = (covered[name] ?? 0) + n;
  });

  it('the runs went through every kind of action (the seeds are not dull ones)', () => {
    for (const name of new Set(ACTIONS)) expect(covered[name] ?? 0, name).toBeGreaterThan(0);
  });
});
