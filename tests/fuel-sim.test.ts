import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { readFileSync } from 'node:fs';
import { parseTrack } from '../src/track/TrackData';
import { simulateRun } from './helpers/raceSim';
import type { CarSpec } from '../src/car/stats';
import { FUEL } from '../src/data/balance';

beforeAll(async () => {
  await RAPIER.init();
});

/*
 * Fuel on the bot (headless races, data/fuel.ts): what a lap burns, and a dry tank. The bot settings are those of the
 * medal calibration (docs/medal-calibration.tsv).
 */
const oval = parseTrack(JSON.parse(readFileSync('src/data/tracks/oval.json', 'utf8')));
const KART: CarSpec = { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } };
const SPORT: CarSpec = { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' } };

describe('fuel on the Ovale', () => {
  it('a clean lap burns about 36 ‰: some 25 laps from full to the reserve, for the kart and the Sportive', () => {
    for (const [spec, bot] of [[KART, { latAccel: 58, braking: 20 }], [SPORT, { latAccel: 58, braking: 12 }]] as const) {
      const r = simulateRun(oval, spec, { ...bot, fuel: true });
      expect(r.finished).toBe(true);
      const perLap = r.fuelExact!;
      expect(perLap).toBeGreaterThan(28);
      expect(perLap).toBeLessThan(42);
      const laps = FUEL.BLOCK_ABOVE / perLap;
      expect(laps).toBeGreaterThan(21);
      expect(laps).toBeLessThan(32);
    }
  });

  it('a dry tank: the engine gives nothing, the car never leaves the line', () => {
    const r = simulateRun(oval, KART, { latAccel: 58, braking: 20, fuel: true, startFuel: FUEL.MAX, maxSeconds: 15 });
    expect(r.finished).toBe(false);
    expect(r.checkpoints).toBe(0);
    expect(r.km).toBeLessThan(0.005);
  });

  it('running dry during the lap: the car coasts to a stop and does not finish', () => {
    const r = simulateRun(oval, KART, { latAccel: 58, braking: 20, fuel: true, startFuel: FUEL.MAX - 10, maxSeconds: 60 });
    expect(r.finished).toBe(false);
    expect(r.fuelExact).toBe(FUEL.MAX);
    expect(r.km).toBeLessThan(0.58);
  });
});
