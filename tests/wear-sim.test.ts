import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseTrack, type TrackData } from '../src/track/TrackData';
import { simulateRun, type SimOptions, type SimResult } from './helpers/raceSim';
import type { CarSpec } from '../src/car/stats';
import { WEAR } from '../src/data/balance';

beforeAll(async () => {
  await RAPIER.init();
});

/*
 * Wear calibration on the bot (headless races). A clean lap: the bot with the settings of the medal calibration
 * (docs/medal-calibration.tsv, the best clean run of each car); the sloppy driver pulls the handbrake in every tight
 * turn (tests/helpers/raceSim.ts). Report: CALIBRATE=1 npx vitest run tests/wear-sim.test.ts.
 */

const TRACKS: Record<string, TrackData> = {
  oval: parseTrack(JSON.parse(readFileSync('src/data/tracks/oval.json', 'utf8'))),
  hill: parseTrack(JSON.parse(readFileSync('src/data/tracks/hill.json', 'utf8'))),
};
/** The player's cars (the loaner never wears). */
const CARS: Record<string, CarSpec> = {
  kart: { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } },
  kartRacing: { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing' } },
  sport: { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' } },
  sportFull: { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' } },
};

/** Bot settings of each clean run: `track/car` → latAccel, braking (from the medal calibration report). */
const CLEAN = new Map<string, SimOptions>(
  readFileSync('docs/medal-calibration.tsv', 'utf8').trim().split('\n').map((l) => {
    const [track, car, , lat, brake] = l.split('\t');
    return [`${track}/${car}`, { latAccel: Number(lat!.slice(4)), braking: Number(brake!.slice(6)) }] as const;
  }),
);

function lap(track: string, car: string, driver: 'clean' | 'sloppy'): SimResult {
  const bot = CLEAN.get(`${track}/${car}`);
  if (!bot) throw new Error(`no calibrated bot for ${track}/${car}`);
  return simulateRun(TRACKS[track]!, CARS[car]!, { ...bot, meter: true, driver });
}

const memo = new Map<string, SimResult>();
const run = (track: string, car: string, driver: 'clean' | 'sloppy') => {
  const k = `${track}/${car}/${driver}`;
  let r = memo.get(k);
  if (!r) memo.set(k, (r = lap(track, car, driver)));
  return r;
};
const bodyWear = (r: SimResult) => r.wearExact!.chassis + r.wearExact!.panels + r.wearExact!.spoiler;
const cases = (tracks: string[]) => tracks.flatMap((t) => Object.keys(CARS).map((c) => [t, c] as const));

describe('wear calibration (bot laps)', () => {
  it.each(Object.keys(CARS))('%s: new tires last 28 to 45 clean laps of the Ovale before the race limit', (car) => {
    const r = run('oval', car, 'clean');
    expect([r.finished, r.respawns]).toEqual([true, 0]);
    const laps = WEAR.BLOCK_ABOVE / r.wearExact!.wheels;
    expect(laps).toBeGreaterThanOrEqual(28);
    expect(laps).toBeLessThanOrEqual(45);
  });

  it.each(Object.keys(CARS))('%s: an engine lasts 90 to 160 clean laps of the Ovale', (car) => {
    const laps = WEAR.BLOCK_ABOVE / run('oval', car, 'clean').wearExact!.engine;
    expect(laps).toBeGreaterThanOrEqual(90);
    expect(laps).toBeLessThanOrEqual(160);
  });

  it.each(cases(['oval', 'hill']))('%s, %s: a clean lap takes less than 5 ‰ of shocks (landings and ramps are free)', (track, car) => {
    const r = run(track, car, 'clean');
    expect([r.finished, r.respawns]).toEqual([true, 0]);
    expect(bodyWear(r)).toBeLessThan(5);
  });

  it.each(Object.keys(CARS))('%s: the sloppy driver wears the tires at least 1.5 times as fast (per km)', (car) => {
    const clean = run('oval', car, 'clean');
    const sloppy = run('oval', car, 'sloppy');
    expect(sloppy.wearExact!.wheels / sloppy.km).toBeGreaterThanOrEqual(1.5 * (clean.wearExact!.wheels / clean.km));
  });

  it('the rounded wear written into the car is the exact wear, rounded', () => {
    const r = run('oval', 'sportFull', 'clean');
    for (const s of ['wheels', 'engine'] as const) expect(r.wear![s]).toBe(Math.round(r.wearExact![s]));
  });

  // Report (CALIBRATE=1 npx vitest run tests/wear-sim.test.ts): ‰ per lap, laps to the race limit.
  it.runIf(process.env.CALIBRATE)('calibration report', () => {
    const lines = ['track\tcar\tdriver\tms\trespawns\tkm\twheels\tengine\tchassis\tpanels\tspoiler\ttire laps\tengine laps'];
    for (const [t, c] of cases(['oval', 'hill'])) {
      for (const d of ['clean', 'sloppy'] as const) {
        const r = run(t, c, d);
        const e = r.wearExact!;
        const laps = (w: number) => (w > 0 ? (WEAR.BLOCK_ABOVE / w).toFixed(1) : '-');
        lines.push([t, c, d, r.finished ? r.ms : 'DNF', r.respawns, r.km.toFixed(3), e.wheels.toFixed(2), e.engine.toFixed(2), e.chassis.toFixed(2), e.panels.toFixed(2), e.spoiler.toFixed(2), laps(e.wheels), laps(e.engine)].join('\t'));
      }
    }
    writeFileSync('docs/wear-calibration.tsv', lines.join('\n') + '\n');
  }, 600_000);
});
