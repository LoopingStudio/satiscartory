import { describe, expect, it } from 'vitest';
import { WEAR } from '../data/balance';
import type { CarWear } from '../data/wear';
import { computeCarStats, type CarSpec } from './stats';
import { tuningFromStats, type VehicleTuning } from './tuning';
import { wearCurve, wearEffects, wornTuning } from './wornTuning';

const KART: CarSpec = { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } };
const SPORT_FULL: CarSpec = { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' } };
const SPORT: CarSpec = { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' } };
const tuning = (spec: CarSpec) => tuningFromStats(computeCarStats(spec));

/** Fields baked into the body when it is created, or that the effects never touch. */
const FROZEN: (keyof VehicleTuning)[] = [
  'massKg', 'comY', 'suspensionRest', 'suspensionTravel', 'suspensionStiffness', 'suspensionCompression', 'suspensionRelaxation',
  'topSpeedMs', 'rearBias', 'rollingK', 'steerAtTopSpeed', 'steerSpeed', 'airControl',
];

describe('wear effects on the tuning', () => {
  it('the curve: 0 when new, 1 worn out, slope 1/4 at the start, 0.68 at the race limit', () => {
    expect([wearCurve(0), wearCurve(WEAR.MAX)]).toEqual([0, 1]);
    expect(wearCurve(100)).toBeCloseTo(0.0325, 12);
    expect(wearCurve(250)).toBeCloseTo(0.109375, 12);
    expect(wearCurve(500)).toBeCloseTo(0.3125, 12);
    expect(wearCurve(WEAR.BLOCK_ABOVE)).toBeCloseTo(0.68, 12);
    expect(wearCurve(1) / 0.001).toBeCloseTo(0.25, 2);
    // Garbage clamps: never NaN.
    expect([wearCurve(NaN), wearCurve(-50), wearCurve(5000)]).toEqual([0, 0, 1]);
  });

  it('without wear, the very same tuning object comes back (a new car drives bit for bit as before)', () => {
    for (const spec of [KART, SPORT, SPORT_FULL]) {
      const t = tuning(spec);
      expect(wornTuning(t, undefined, spec.parts)).toBe(t);
      expect(wornTuning(t, {}, spec.parts)).toBe(t);
      expect(wornTuning(t, { wheels: 0, engine: 0 }, spec.parts)).toBe(t);
      expect(wornTuning(t, { wheels: NaN }, spec.parts)).toBe(t);
    }
    // Wear of a slot without its part (no panels on a kart, the spoiler taken off) changes nothing.
    const k = tuning(KART);
    expect(wornTuning(k, { panels: 900, spoiler: 900 }, KART.parts)).toBe(k);
    const s = tuning(SPORT);
    expect(wornTuning(s, { spoiler: 1000 }, SPORT.parts)).toBe(s);
  });

  it('a worn part changes its own fields only, by its effect through the curve; the input is never mutated', () => {
    const t = tuning(SPORT_FULL);
    const copy = { ...t };
    const L = wearCurve(WEAR.BLOCK_ABOVE);
    const at = (wear: CarWear) => wornTuning(t, wear, SPORT_FULL.parts);
    const changed = (w: VehicleTuning) => (Object.keys(t) as (keyof VehicleTuning)[]).filter((k) => w[k] !== t[k]).sort();

    const wheels = at({ wheels: WEAR.BLOCK_ABOVE });
    expect(changed(wheels)).toEqual(['driftSideFriction', 'frictionSlip', 'sideFrictionStiffness']);
    expect(wheels.frictionSlip).toBeCloseTo(t.frictionSlip * (1 - WEAR.EFFECT.grip * L), 12);
    expect(wheels.sideFrictionStiffness).toBeCloseTo(t.sideFrictionStiffness * (1 - WEAR.EFFECT.grip * L), 12);
    expect(wheels.driftSideFriction).toBeCloseTo(t.driftSideFriction * (1 - WEAR.EFFECT.grip * L), 12);

    const engine = at({ engine: WEAR.MAX });
    expect(changed(engine)).toEqual(['engineN', 'reverseN']);
    expect(engine.engineN).toBeCloseTo(t.engineN * (1 - WEAR.EFFECT.engine), 9);
    expect(engine.reverseN).toBeCloseTo(t.reverseN * (1 - WEAR.EFFECT.engine), 9);

    const chassis = at({ chassis: WEAR.MAX });
    expect(changed(chassis)).toEqual(['brakeN', 'steerMaxRad']);
    expect(chassis.steerMaxRad).toBeCloseTo(t.steerMaxRad * (1 - WEAR.EFFECT.steer), 12);
    expect(chassis.brakeN).toBeCloseTo(t.brakeN * (1 - WEAR.EFFECT.brake), 9);

    const panels = at({ panels: WEAR.MAX });
    expect(changed(panels)).toEqual(['dragK']);
    expect(panels.dragK).toBeCloseTo(t.dragK * (1 + WEAR.EFFECT.drag), 12);

    expect(t).toEqual(copy);
  });

  it('a worn spoiler loses its own share of the downforce only, not the body’s', () => {
    const t = tuning(SPORT_FULL);
    const w = wornTuning(t, { spoiler: WEAR.MAX }, SPORT_FULL.parts);
    // The spoiler's share: 2.4 (parts.ts) × mass / 1000; half of it goes at WEAR.MAX.
    const share = (2.4 * t.massKg) / 1000;
    expect(w.downforceK).toBeCloseTo(t.downforceK - WEAR.EFFECT.spoiler * share, 12);
    // The body keeps its own downforce: a worn-out spoiler leaves more than a car without one minus the spoiler's share.
    const bare = tuning(SPORT);
    expect(w.downforceK).toBeGreaterThan(t.downforceK - share);
    expect(t.downforceK - share).toBeCloseTo((bare.downforceK * t.massKg) / bare.massKg, 9);
    for (const k of Object.keys(t) as (keyof VehicleTuning)[]) if (k !== 'downforceK') expect(w[k], k).toBe(t[k]);
  });

  it('never touches the mass, center of mass, suspensions or top speed, whatever the wear', () => {
    const t = tuning(SPORT_FULL);
    for (const w of [1, 100, 500, 801, 1000]) {
      const worn = wornTuning(t, { chassis: w, engine: w, wheels: w, panels: w, spoiler: w }, SPORT_FULL.parts);
      for (const k of FROZEN) expect(worn[k], `${k} at ${w}`).toBe(t[k]);
    }
  });

  it('is monotone: more wear, less grip, power, steering, brakes and downforce, more drag', () => {
    for (const spec of [KART, SPORT_FULL]) {
      const t = tuning(spec);
      let prev = t;
      for (let w = 0; w <= WEAR.MAX; w += 50) {
        const cur = wornTuning(t, { chassis: w, engine: w, wheels: w, panels: w, spoiler: w }, spec.parts);
        for (const k of ['frictionSlip', 'sideFrictionStiffness', 'driftSideFriction', 'engineN', 'reverseN', 'steerMaxRad', 'brakeN', 'downforceK'] as const) {
          expect(cur[k], `${spec.blueprint} ${k} at ${w}`).toBeLessThanOrEqual(prev[k]);
        }
        expect(cur.dragK).toBeGreaterThanOrEqual(prev.dragK);
        prev = cur;
      }
      expect(prev.frictionSlip).toBeLessThan(t.frictionSlip);
    }
  });

  it('wearEffects: none when new, the same ratios as the tuning, monotone; nothing for an odd blueprint', () => {
    expect(wearEffects(SPORT_FULL, undefined)).toEqual({ grip: 0, power: 0, topSpeed: 0, steer: 0, brake: 0, downforce: 0 });
    expect(wearEffects(KART, { panels: 500 })).toEqual({ grip: 0, power: 0, topSpeed: 0, steer: 0, brake: 0, downforce: 0 });
    const wear = { chassis: 300, engine: 400, wheels: 540, panels: 200, spoiler: 600 };
    const t = tuning(SPORT_FULL);
    const w = wornTuning(t, wear, SPORT_FULL.parts);
    const e = wearEffects(SPORT_FULL, wear);
    expect(e.grip).toBeCloseTo(w.frictionSlip / t.frictionSlip - 1, 12);
    expect(e.power).toBeCloseTo(w.engineN / t.engineN - 1, 12);
    expect(e.steer).toBeCloseTo(w.steerMaxRad / t.steerMaxRad - 1, 12);
    expect(e.brake).toBeCloseTo(w.brakeN / t.brakeN - 1, 12);
    expect(e.downforce).toBeCloseTo(w.downforceK / t.downforceK - 1, 12);
    expect(e.topSpeed).toBeCloseTo(Math.sqrt(w.engineN / w.dragK / (t.engineN / t.dragK)) - 1, 12);
    for (const v of Object.values(e)) expect(v).toBeLessThan(0);
    // A tenth of wear everywhere: each feel moves by about 1 % or less.
    for (const v of Object.values(wearEffects(SPORT_FULL, { chassis: 100, engine: 100, wheels: 100, panels: 100, spoiler: 100 }))) expect(Math.abs(v)).toBeLessThan(0.02);
    let prev = 0;
    for (let x = 0; x <= WEAR.MAX; x += 100) {
      const g = wearEffects(KART, { wheels: x }).grip;
      expect(g).toBeLessThanOrEqual(prev);
      prev = g;
    }
    expect(wearEffects({ blueprint: 'constructor' as CarSpec['blueprint'], parts: {} }, { wheels: 500 }).grip).toBe(0);
  });
});
