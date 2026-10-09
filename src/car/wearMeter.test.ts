import { describe, expect, it } from 'vitest';
import { WearMeter, autoResetCause, type WearControls, type WearSource } from './wearMeter';
import { WEAR } from '../data/balance';
import type { WearCar } from '../data/wear';

const KART = (): WearCar => ({ blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } });
const SPORT = (spoiler = true): WearCar => ({
  blueprint: 'sport',
  parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel', ...(spoiler ? { spoiler: 'spoiler' } : {}) },
});

const DT = 1 / 60;
const COAST: WearControls = { throttle: 0, handbrake: false };

/** A vehicle reading: rolling straight at `speed` on four wheels, no shock. */
function src(o: Partial<WearSource> = {}): WearSource {
  return { speed: 20, lateralSpeed: 0, wheelsInContact: 4, impact: 0, impactX: 0, impactY: 0, impactZ: 0, ...o };
}

/** Drives `km` at 20 m/s (exact number of steps). */
function drive(m: WearMeter, km: number, s: WearSource = src(), c: WearControls = COAST): void {
  const steps = Math.round((km * 1000) / (Math.abs(s.speed) * DT));
  for (let i = 0; i < steps; i++) m.step(DT, s, c);
}

/** One shock window: these impacts (m/s) on consecutive steps, along −Z, then a calm step. */
function shock(m: WearMeter, ...impacts: number[]): void {
  for (const v of impacts) m.step(DT, src({ speed: 0, impact: v, impactZ: -v }), COAST);
  m.step(DT, src({ speed: 0 }), COAST);
}

describe('WearMeter: distance', () => {
  it('a km rolled straight wears the tires by TIRE_PER_KM and the engine by ENGINE_PER_KM (+ the throttle part)', () => {
    const car = KART();
    const m = new WearMeter(car);
    drive(m, 1);
    expect(m.exact('wheels')).toBeCloseTo(WEAR.TIRE_PER_KM, 6);
    expect(m.exact('engine')).toBeCloseTo(WEAR.ENGINE_PER_KM, 6);
    drive(m, 1, src(), { throttle: 1, handbrake: false });
    expect(m.exact('engine')).toBeCloseTo(2 * WEAR.ENGINE_PER_KM + WEAR.ENGINE_THROTTLE_PER_KM, 6);
    // Reverse wears like forward.
    const r = new WearMeter(KART());
    drive(r, 1, src({ speed: -20 }));
    expect(r.exact('wheels')).toBeCloseTo(WEAR.TIRE_PER_KM, 6);
    // Nothing else wears with the distance.
    expect(m.exact('chassis')).toBe(0);
  });

  it('the handbrake and the side slide beyond SLIP_FREE add to the tires', () => {
    const hb = new WearMeter(KART());
    drive(hb, 1, src(), { throttle: 0, handbrake: true });
    expect(hb.exact('wheels')).toBeCloseTo(WEAR.TIRE_PER_KM + WEAR.TIRE_HANDBRAKE_PER_KM, 6);
    const slide = new WearMeter(KART());
    // 1 km at 20 m/s = 50 s, sliding 2.3 m/s: 2 m/s beyond the free slide → 100 m slid.
    drive(slide, 1, src({ lateralSpeed: WEAR.SLIP_FREE + 2 }));
    expect(slide.exact('wheels')).toBeCloseTo(WEAR.TIRE_PER_KM + 0.1 * WEAR.TIRE_SLIDE_PER_KM, 6);
    // Under the free slide: nothing more.
    const grip = new WearMeter(KART());
    drive(grip, 1, src({ lateralSpeed: WEAR.SLIP_FREE }));
    expect(grip.exact('wheels')).toBeCloseTo(WEAR.TIRE_PER_KM, 6);
  });

  it('the tires wear with the wheels on the ground only (in part on two wheels), the engine always', () => {
    const air = new WearMeter(KART());
    drive(air, 1, src({ wheelsInContact: 0, lateralSpeed: 5 }), { throttle: 1, handbrake: true });
    expect(air.exact('wheels')).toBe(0);
    expect(air.exact('engine')).toBeCloseTo(WEAR.ENGINE_PER_KM + WEAR.ENGINE_THROTTLE_PER_KM, 6);
    const two = new WearMeter(KART());
    drive(two, 1, src({ wheelsInContact: 2 }));
    expect(two.exact('wheels')).toBeCloseTo(WEAR.TIRE_PER_KM / 2, 6);
  });
});

describe('WearMeter: shocks', () => {
  const cost = (k: number, dv: number) => Math.min(WEAR.SHOCK_MAX, k * Math.max(0, dv - WEAR.SHOCK_FREE) ** 2);

  it('a 10 m/s shock costs the same in one step or spread over four', () => {
    const one = new WearMeter(SPORT());
    shock(one, 10);
    const four = new WearMeter(SPORT());
    shock(four, 2.5, 2.5, 2.5, 2.5);
    for (const s of ['chassis', 'panels', 'spoiler'] as const) {
      expect(one.exact(s)).toBeCloseTo(cost(WEAR.SHOCK_K[s], 10), 9);
      expect(four.exact(s)).toBeCloseTo(one.exact(s), 9);
    }
    // Only the body parts.
    expect([one.exact('wheels'), one.exact('engine')]).toEqual([0, 0]);
  });

  it('grazes are free: under the floor nothing adds up, up to SHOCK_FREE nothing is charged', () => {
    const m = new WearMeter(KART());
    // Pushing a wall (0.19 m/s a step), steering into it (1 to 2 m/s a step): never a window.
    for (let i = 0; i < 600; i++) m.step(DT, src({ speed: 0, impact: WEAR.SHOCK_FLOOR, impactZ: -WEAR.SHOCK_FLOOR }), COAST);
    shock(m, WEAR.SHOCK_FREE);
    m.end();
    expect(car(m).wear).toBeUndefined();
    expect(m.last.seq).toBe(0);
  });

  it('a window closes after SHOCK_WINDOW steps, at the first calm step, or on closeShock', () => {
    const long = new WearMeter(KART());
    shock(long, 5, 5, 5, 5, 5);
    expect(long.exact('chassis')).toBeCloseTo(cost(0.33, 20) + cost(0.33, 5), 9);
    const open = new WearMeter(KART());
    open.step(DT, src({ impact: 12, impactZ: -12 }), COAST);
    expect(open.exact('chassis')).toBe(0);
    open.closeShock();
    expect(open.exact('chassis')).toBeCloseTo(cost(0.33, 12), 9);
    // Nothing left to charge.
    open.closeShock();
    expect(open.exact('chassis')).toBeCloseTo(cost(0.33, 12), 9);
  });

  it('a shock is capped at SHOCK_MAX per part', () => {
    const m = new WearMeter(SPORT());
    shock(m, 60);
    expect(m.exact('panels')).toBe(WEAR.SHOCK_MAX);
    expect(m.exact('chassis')).toBe(WEAR.SHOCK_MAX);
  });

  it('last: the most hit part, its ‰ and the direction; seq grows from 1 ‰ only', () => {
    const m = new WearMeter(SPORT());
    shock(m, 4); // 0.5 × 1² = 0.5 ‰ on the panels: no flash
    expect(m.last.seq).toBe(0);
    shock(m, 10);
    expect(m.last).toEqual({ seq: 1, cause: 'shock', slot: 'panels', permille: cost(0.5, 10), dx: 0, dy: 0, dz: -1 });
    const kart = new WearMeter(KART());
    shock(kart, 10);
    expect([kart.last.slot, kart.last.seq]).toEqual(['chassis', 1]);
  });
});

/** The car a meter writes to (test-only peek). */
const car = (m: WearMeter) => (m as unknown as { car: WearCar }).car;

describe('WearMeter: put back on the road', () => {
  it('charges the cause on the installed body parts only', () => {
    for (const cause of ['key', 'stuck', 'flip', 'fall', 'water'] as const) {
      const sport = new WearMeter(SPORT());
      sport.putBack(cause);
      expect([sport.exact('chassis'), sport.exact('panels'), sport.exact('spoiler')]).toEqual([WEAR.RESET[cause].chassis, WEAR.RESET[cause].panels, WEAR.RESET[cause].spoiler]);
      const kart = new WearMeter(KART());
      kart.putBack(cause);
      expect([kart.exact('chassis'), kart.exact('panels'), kart.exact('spoiler')]).toEqual([WEAR.RESET[cause].chassis, 0, 0]);
      const bare = new WearMeter(SPORT(false));
      bare.putBack(cause);
      expect(bare.exact('spoiler')).toBe(0);
    }
    const m = new WearMeter(SPORT());
    m.putBack('flip');
    expect(m.last).toEqual({ seq: 1, cause: 'flip', slot: 'spoiler', permille: WEAR.RESET.flip.spoiler, dx: 0, dy: 0, dz: 0 });
  });

  it('closes the open shock first', () => {
    const m = new WearMeter(KART());
    m.step(DT, src({ impact: 12, impactZ: -12 }), COAST);
    m.putBack('key');
    expect(m.exact('chassis')).toBeCloseTo(0.33 * 81 + WEAR.RESET.key.chassis, 9);
  });

  it('autoResetCause: a fall first, then a flip (up axis under 0.5), else stuck', () => {
    const roll = (deg: number) => ({ x: 0, z: Math.sin((deg * Math.PI) / 360) });
    expect(autoResetCause(true, roll(180))).toBe('fall');
    expect(autoResetCause(false, roll(180))).toBe('flip');
    expect(autoResetCause(false, roll(65))).toBe('flip');
    expect(autoResetCause(false, roll(55))).toBe('stuck');
    expect(autoResetCause(false, roll(0))).toBe('stuck');
  });
});

describe('WearMeter: writing into the car', () => {
  it('whole thousandths go into car.wear as they come (the key with the first one), the fractions wait', () => {
    const c = KART();
    const m = new WearMeter(c);
    drive(m, 0.02); // 0.72 ‰ of tires, 0.06 ‰ of engine
    expect(c.wear).toBeUndefined();
    drive(m, 0.02);
    expect(c.wear).toEqual({ wheels: 1 });
    drive(m, 1);
    expect(Number.isInteger(c.wear!.wheels)).toBe(true);
    expect(c.wear!.wheels).toBe(Math.floor(m.exact('wheels')));
    expect(c.wear!.engine).toBe(Math.floor(m.exact('engine')));
  });

  it('end() rounds the fractions (half a thousandth counts) and closes the shock', () => {
    const c = KART();
    const m = new WearMeter(c);
    drive(m, 0.02); // 0.72 ‰ of tires, 0.06 ‰ of engine
    m.step(DT, src({ speed: 0, impact: 6, impactZ: -6 }), COAST);
    m.end();
    expect(c.wear).toEqual({ wheels: 1, chassis: 3 });
    // Nothing is counted twice.
    m.end();
    expect(c.wear).toEqual({ wheels: 1, chassis: 3 });
  });

  it('adds to the wear the car came with, up to WEAR.MAX', () => {
    const c = { ...KART(), wear: { wheels: 990, chassis: 400 } };
    const m = new WearMeter(c);
    drive(m, 1);
    expect(c.wear).toEqual({ wheels: WEAR.MAX, chassis: 400, engine: 3 });
    shock(m, 60);
    expect(c.wear.chassis).toBe(400 + WEAR.SHOCK_MAX);
  });

  it('a step whose readings are not finite numbers is ignored: no NaN reaches the car', () => {
    const c = SPORT();
    const m = new WearMeter(c);
    const bad: Partial<WearSource>[] = [{ speed: NaN }, { speed: Infinity }, { lateralSpeed: NaN }, { wheelsInContact: NaN }, { impact: NaN }, { impact: Infinity, impactZ: -Infinity }, { impactX: NaN, impact: 5 }];
    for (const o of bad) for (let i = 0; i < 100; i++) m.step(DT, src(o), COAST);
    for (const dt of [NaN, Infinity, 0, -1]) m.step(dt, src(), COAST);
    m.step(DT, src(), { throttle: NaN, handbrake: false });
    m.end();
    expect(c.wear).toBeUndefined();
    // A good step after them still counts.
    drive(m, 1);
    expect(m.exact('wheels')).toBeCloseTo(WEAR.TIRE_PER_KM, 6);
  });

  it('an unknown blueprint or an empty slot never wears', () => {
    const odd: WearCar = { blueprint: 'constructor', parts: { wheels: 'wheel', chassis: 'chassis' } };
    const m = new WearMeter(odd);
    drive(m, 2);
    shock(m, 20);
    m.putBack('fall');
    m.end();
    expect(odd.wear).toBeUndefined();
  });
});
