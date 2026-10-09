import { describe, expect, it } from 'vitest';
import { GameState } from '../state/GameState';
import { FactorySim } from '../factory/sim/FactorySim';
import { WEAR } from '../data/balance';
import { PHYS_DT } from '../config/constants';
import { LOANER_SPEC, type CarInstance } from '../garage/assembly';
import type { CarSpec } from '../car/stats';
import { WearMeter } from '../car/wearMeter';
import { attemptGate, endAttempt, raceCarFor } from './raceCar';

const KART_PARTS = { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } as const;
const SPORT_FULL = { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' } as const;
const DEV_SPORT: CarSpec = { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' } };

/** A game with a kart (car-1, the race car) and a full Sportive (car-2), worn as given. */
function garage(kartWear?: CarInstance['wear'], sportWear?: CarInstance['wear']): { s: GameState; kart: CarInstance; sport: CarInstance } {
  const s = new GameState(FactorySim.newGame({ terrain: 'flat' }));
  const kart: CarInstance = { id: 'car-1', name: 'Kart Oopi n°1', blueprint: 'kart', parts: { ...KART_PARTS }, ...(kartWear ? { wear: { ...kartWear } } : {}) };
  const sport: CarInstance = { id: 'car-2', name: 'Sportive n°2', blueprint: 'sport', parts: { ...SPORT_FULL }, ...(sportWear ? { wear: { ...sportWear } } : {}) };
  s.cars.push(kart, sport);
  s.selectedCarId = kart.id;
  return { s, kart, sport };
}

describe('raceCarFor: which car races', () => {
  it('the car asked for (or the selected one) races and wears; at 800 ‰ it still starts', () => {
    const { s, kart, sport } = garage({ wheels: WEAR.BLOCK_ABOVE });
    expect(raceCarFor(s, {})).toEqual({ car: kart, spec: { blueprint: 'kart', parts: kart.parts }, wears: true, fallback: null });
    expect(raceCarFor(s, {}).car).toBe(kart);
    const r = raceCarFor(s, { carId: 'car-2' });
    expect(r.car).toBe(sport);
    expect([r.spec.blueprint, r.wears, r.fallback]).toEqual(['sport', true, null]);
  });

  it('801 ‰ blocks it: the loaner races instead, the blocked car and its slots in fallback', () => {
    const { s, kart } = garage({ wheels: WEAR.BLOCK_ABOVE + 1, engine: 900 });
    const r = raceCarFor(s, { carId: kart.id });
    expect(r).toEqual({ car: null, spec: LOANER_SPEC, wears: false, fallback: { kind: 'wear', car: kart, slots: ['engine', 'wheels'] } });
    expect(r.fallback?.car).toBe(kart);
    // The default choice (the selected car) falls back alike.
    expect(raceCarFor(s, {}).fallback?.car).toBe(kart);
  });

  it('the spoiler counts; taking it off (« Aucun ») lifts the block', () => {
    const { s, sport } = garage(undefined, { spoiler: 801 });
    expect(raceCarFor(s, { carId: sport.id }).fallback?.slots).toEqual(['spoiler']);
    delete (sport.parts as Record<string, unknown>).spoiler;
    const r = raceCarFor(s, { carId: sport.id });
    expect([r.car, r.wears, r.fallback]).toEqual([sport, true, null]);
  });

  it('the editor’s test drive: the selected car as new, never worn nor blocked (checked before the block)', () => {
    const { s, kart } = garage({ wheels: WEAR.MAX, chassis: WEAR.MAX });
    const r = raceCarFor(s, { test: true });
    expect(r.car).toBe(kart);
    expect([r.spec.blueprint, r.wears, r.fallback]).toEqual(['kart', false, null]);
    expect(raceCarFor(s, { test: true, carId: kart.id }).fallback).toBeNull();
  });

  it('a forced spec (?car=) drives as new: never worn, never blocked, the car asked for keeps its records', () => {
    const { s, kart } = garage({ wheels: WEAR.MAX });
    expect(raceCarFor(s, { spec: DEV_SPORT })).toEqual({ car: null, spec: DEV_SPORT, wears: false, fallback: null });
    const r = raceCarFor(s, { spec: DEV_SPORT, carId: kart.id });
    expect([r.car, r.spec, r.wears, r.fallback]).toEqual([kart, DEV_SPORT, false, null]);
  });

  it('the loaner (carId null), a car gone, no car at all: the loaner, which never wears and is never a fallback', () => {
    const { s } = garage({ wheels: WEAR.MAX });
    const loaner = { car: null, spec: LOANER_SPEC, wears: false, fallback: null };
    expect(raceCarFor(s, { carId: null })).toEqual(loaner);
    expect(raceCarFor(s, { carId: 'car-404' })).toEqual(loaner);
    const empty = new GameState(FactorySim.newGame({ terrain: 'flat' }));
    expect(raceCarFor(empty, {})).toEqual(loaner);
  });
});

describe('attemptGate: another attempt with the raced car', () => {
  it('a car that wore past the limit during the session is stopped; at 800 ‰ it goes on', () => {
    const { s, kart } = garage({ wheels: 790 });
    const raced = raceCarFor(s, {});
    expect(attemptGate(raced)).toBeNull();
    // The meter writes the wear into the car itself.
    kart.wear!.wheels = WEAR.BLOCK_ABOVE;
    expect(attemptGate(raced)).toBeNull();
    kart.wear!.wheels = WEAR.BLOCK_ABOVE + 1;
    expect(attemptGate(raced)).toEqual({ kind: 'wear', car: kart, slots: ['wheels'] });
  });

  it('never for what does not wear: the loaner (a fallback included), the test drive, a forced spec', () => {
    const { s, kart } = garage({ wheels: WEAR.MAX });
    expect(attemptGate(raceCarFor(s, { carId: null }))).toBeNull();
    expect(attemptGate(raceCarFor(s, { carId: kart.id }))).toBeNull();
    expect(attemptGate(raceCarFor(s, { test: true }))).toBeNull();
    expect(attemptGate(raceCarFor(s, { spec: DEV_SPORT, carId: kart.id }))).toBeNull();
  });
});

describe('endAttempt: the line or « Recommencer » ends an attempt', () => {
  /** One step hitting a wall: the meter opens a shock window and charges it only when the window closes. */
  const wallHit = (dv: number) => ({ speed: 0, lateralSpeed: 0, wheelsInContact: 4, impact: dv, impactX: -dv, impactY: 0, impactZ: 0 });
  const noControls = { throttle: 0, handbrake: false };

  it('a shock still open at the end counts before the gate: a car it takes past the limit gets no other attempt', () => {
    const { s, kart } = garage({ chassis: WEAR.BLOCK_ABOVE - 5 });
    const raced = raceCarFor(s, {});
    const meter = new WearMeter(kart);
    // 0.33 × 4.5² ≈ 6.7 ‰ of chassis, still in the open window after this step.
    meter.step(PHYS_DT, wallHit(WEAR.SHOCK_FREE + 4.5), noControls);
    expect(kart.wear!.chassis).toBe(WEAR.BLOCK_ABOVE - 5);
    expect(attemptGate(raced)).toBeNull();
    expect(endAttempt(raced, meter)).toEqual({ kind: 'wear', car: kart, slots: ['chassis'] });
    expect(kart.wear!.chassis).toBe(WEAR.BLOCK_ABOVE + 1);
    expect([meter.last.seq, meter.last.cause, meter.last.slot]).toEqual([1, 'shock', 'chassis']);
    // Closed: ending again charges nothing more.
    expect(endAttempt(raced, meter)?.slots).toEqual(['chassis']);
    expect([kart.wear!.chassis, meter.last.seq]).toEqual([WEAR.BLOCK_ABOVE + 1, 1]);
  });

  it('a small shock leaves the car under the limit; what does not wear is never gated', () => {
    const { s, kart } = garage({ chassis: WEAR.BLOCK_ABOVE - 5 });
    const raced = raceCarFor(s, {});
    const meter = new WearMeter(kart);
    meter.step(PHYS_DT, wallHit(WEAR.SHOCK_FREE + 1), noControls);
    expect(endAttempt(raced, meter)).toBeNull();
    expect(kart.wear!.chassis).toBe(WEAR.BLOCK_ABOVE - 5);
    expect(meter.exact('chassis')).toBeCloseTo(WEAR.BLOCK_ABOVE - 5 + WEAR.SHOCK_K.chassis, 9);
    kart.wear!.chassis = WEAR.MAX;
    expect(endAttempt(raceCarFor(s, { carId: null }), null)).toBeNull();
    expect(endAttempt(raceCarFor(s, { test: true }), null)).toBeNull();
  });
});
