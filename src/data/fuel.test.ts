import { describe, expect, it } from 'vitest';
import { FUEL } from './balance';
import { FuelMeter, fillCans, fillCredits, fuelBlocked, fuelPct, isDry, litersLeft, pourCans, sanitizeFuel, tankLiters, type FuelCar } from './fuel';
import { raceBlocker } from './wear';
import { blockText, needOf } from './wearText';
import { PART_VALUES } from './sales';
import { RESOURCES } from './factoryMap';
import { RECIPES } from './recipes';
import { GameState } from '../state/GameState';
import { refuelCar } from '../garage/wearActions';
import { raceCarFor } from '../race/raceCar';
import { LOANER_SPEC, type CarInstance } from '../garage/assembly';

const kart = (fuel?: number): CarInstance => ({
  id: 'k1', name: 'Kart Oopi n°1', blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' }, ...(fuel ? { fuel } : {}),
});

describe('fuel: tank and gauge', () => {
  it('karts and Sportives have a tank, the loaner none', () => {
    expect(tankLiters('kart')).toBe(10);
    expect(tankLiters('sport')).toBe(30);
    expect(tankLiters('loaner')).toBe(0);
    expect(isDry({ blueprint: 'loaner', fuel: 1000 })).toBe(false);
    expect(fuelBlocked({ blueprint: 'loaner', fuel: 1000 })).toBe(false);
  });

  it('reads ‰ used: full without a key, the reserve above BLOCK_ABOVE, dry at MAX', () => {
    expect(fuelPct(0)).toBe(100);
    expect(litersLeft(kart())).toBe(10);
    expect(litersLeft(kart(380))).toBe(6.2);
    expect(fuelBlocked(kart(FUEL.BLOCK_ABOVE))).toBe(false);
    expect(fuelBlocked(kart(FUEL.BLOCK_ABOVE + 1))).toBe(true);
    expect(isDry(kart(999))).toBe(false);
    expect(isDry(kart(1000))).toBe(true);
  });

  it('sanitizes save data: integers 1..1000, only for cars with a tank', () => {
    expect(sanitizeFuel('kart', 412.6)).toBe(413);
    expect(sanitizeFuel('kart', 5000)).toBe(1000);
    expect(sanitizeFuel('kart', 0)).toBeUndefined();
    expect(sanitizeFuel('kart', 'x')).toBeUndefined();
    expect(sanitizeFuel('loaner', 500)).toBeUndefined();
    const s = new GameState();
    s.cars = [kart(640)];
    const back = GameState.fromSave(JSON.parse(JSON.stringify(s.serialize())));
    expect(back.cars[0]!.fuel).toBe(640);
  });
});

describe('fuel: the meter', () => {
  it('burns PER_KM ‰ per km at full throttle, IDLE_SHARE of it coasting, and stops at dry', () => {
    const car: FuelCar = { blueprint: 'kart' };
    const m = new FuelMeter(car);
    for (let i = 0; i < 60; i++) m.step(1 / 60, 50, 1); // 50 m at full throttle
    expect(m.exact()).toBeCloseTo(FUEL.PER_KM * 0.05, 6);
    const coast = new FuelMeter({ blueprint: 'kart' });
    for (let i = 0; i < 60; i++) coast.step(1 / 60, 50, 0);
    expect(coast.exact()).toBeCloseTo(FUEL.PER_KM * 0.05 * FUEL.IDLE_SHARE, 6);
    const low: FuelCar = { blueprint: 'kart', fuel: 999 };
    const end = new FuelMeter(low);
    for (let i = 0; i < 600; i++) end.step(1 / 60, 50, 1);
    expect(low.fuel).toBe(1000);
    expect(end.dry).toBe(true);
  });

  it('writes whole thousandths at once and rounds the rest at the end; garbage is ignored', () => {
    const car: FuelCar = { blueprint: 'sport' };
    const m = new FuelMeter(car);
    m.step(1, 20, 1); // 20 m: 1.4 ‰
    expect(car.fuel).toBe(1);
    m.step(1, Number.NaN, 1);
    m.step(-1, 20, 1);
    m.end();
    expect(car.fuel).toBe(1);
    const none: FuelCar = { blueprint: 'loaner' };
    new FuelMeter(none).step(1, 50, 1);
    expect(none.fuel).toBeUndefined();
  });
});

describe('fuel: filling up', () => {
  it('cans and credits for the liters missing; nothing when full', () => {
    expect(fillCans(kart())).toBe(0);
    expect(fillCredits(kart())).toBe(0);
    expect(fillCans(kart(1000))).toBe(1); // 10 L = one can
    expect(fillCans({ blueprint: 'sport', fuel: 1000 })).toBe(3);
    expect(fillCans({ blueprint: 'sport', fuel: 340 })).toBe(2); // 10.2 L
    expect(fillCredits(kart(1))).toBe(10); // never free
    // A whole can's worth costs its value with the dealer's margin.
    expect(fillCredits(kart(1000))).toBe(Math.ceil((PART_VALUES.fuel_can * 1.25) / 10) * 10);
  });

  it('a poured can adds CAN_L liters, capped at full (the key goes)', () => {
    const s = { blueprint: 'sport', fuel: 900 };
    expect(pourCans(s, 1)).toBe(333);
    expect(s.fuel).toBe(567);
    const k = kart(400);
    pourCans(k, 1);
    expect(k.fuel).toBeUndefined();
  });

  it('the garage fills up in cans (backpack then hub) or credits, all or nothing', () => {
    const state = new GameState();
    state.cars = [kart(950)];
    expect(refuelCar(state, 'k1', 'items')).toBeNull();
    state.sim.give({ fuel_can: 2 });
    expect(refuelCar(state, 'k1', 'items')).toEqual({ items: { fuel_can: 1 } });
    expect(state.cars[0]!.fuel).toBeUndefined();
    expect(state.sim.count('fuel_can')).toBe(1);
    expect(refuelCar(state, 'k1', 'items')).toBeNull(); // full
    state.cars[0]!.fuel = 500;
    state.sim.credits = 5;
    expect(refuelCar(state, 'k1', 'credits')).toBeNull();
    state.sim.credits = 10_000;
    const paid = refuelCar(state, 'k1', 'credits');
    expect(paid?.credits).toBeGreaterThan(0);
    expect(state.sim.credits).toBe(10_000 - paid!.credits!);
  });
});

describe('fuel: the race limit', () => {
  it('a car in the reserve does not start a race: the loaner instead, and the texts say « à ravitailler »', () => {
    const car = kart(950);
    expect(raceBlocker(car)).toEqual({ kind: 'fuel', car, slots: [], fuel: true });
    expect(needOf(car)).toBe('fuel');
    expect(blockText(car)).toBe('réservoir à 5 %');
    const r = raceCarFor({ cars: [car], selectedCar: car }, {});
    expect(r.spec).toEqual(LOANER_SPEC);
    expect(r.fallback?.kind).toBe('fuel');
    expect(raceBlocker(kart(FUEL.BLOCK_ABOVE))).toBeNull();
  });

  it('both: worn and in the reserve', () => {
    const car = { ...kart(990), wear: { wheels: 900 } };
    expect(raceBlocker(car)).toEqual({ kind: 'wear', car, slots: ['wheels'], fuel: true });
    expect(needOf(car)).toBe('both');
    expect(blockText(car)).toBe('roues à 10 %, réservoir à 1 %');
  });
});

describe('fuel: the economy', () => {
  it('oil is a raw resource; a fuel can is made of oil and a plate (constructor and bench)', () => {
    expect(RESOURCES.oil.item).toBe('crude_oil');
    const made = RECIPES.filter((r) => r.outputs.some((o) => o.item === 'fuel_can')).map((r) => r.machine).sort();
    expect(made).toEqual(['bench', 'press']);
    expect(PART_VALUES.fuel_can).toBeGreaterThan(PART_VALUES.plate);
  });
});
