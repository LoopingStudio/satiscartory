import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseTrack } from '../src/track/TrackData';
import { simulateRun } from './helpers/raceSim';
import type { CarSpec } from '../src/car/stats';
import { LOANER_SPEC } from '../src/garage/assembly';
import { medalFor } from '../src/race/medals';

beforeAll(async () => {
  await RAPIER.init();
});

const tracks = readdirSync('src/data/tracks')
  .filter((f) => f.endsWith('.json'))
  .map((f) => parseTrack(JSON.parse(readFileSync(`src/data/tracks/${f}`, 'utf8'))));

const CARS: Record<string, CarSpec> = {
  loaner: LOANER_SPEC,
  kart: { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } },
  kartRacing: { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing' } },
  sport: { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' } },
  sportFull: { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' } },
};

describe('headless races (bot)', () => {
  it.each(tracks.map((t) => [t.id, t] as const))('%s can be finished by the bot with the loaner kart', (_id, track) => {
    const r = simulateRun(track, LOANER_SPEC);
    expect(r.finished).toBe(true);
    expect(r.respawns).toBe(0);
  });

  it.each(tracks.map((t) => [t.id, t] as const))('%s: the bot earns at least bronze with the loaner (medals reachable)', (_id, track) => {
    if (!track.medals) return;
    const times = [20, 36].map((lat) => simulateRun(track, LOANER_SPEC, { latAccel: lat, braking: 20 }).ms ?? Infinity);
    expect(medalFor(Math.min(...times), track.medals)).not.toBeNull();
  });

  // Calibration report (CALIBRATE=1 npx vitest run tests/race-sim.test.ts)
  it.runIf(process.env.CALIBRATE)('calibration report', () => {
    const lines: string[] = [];
    for (const t of tracks) {
      for (const [name, spec] of Object.entries(CARS)) {
        let best: { ms: number; lat: number; brk: number } | null = null;
        for (const lat of [20, 28, 36, 46, 58, 72]) {
          for (const brk of [12, 20]) {
            const r = simulateRun(t, spec, { latAccel: lat, braking: brk });
            if (r.finished && r.respawns === 0 && r.ms !== null && (!best || r.ms < best.ms)) best = { ms: r.ms, lat, brk };
          }
        }
        lines.push(`${t.id}\t${name}\t${best ? best.ms.toFixed(0) : 'DNF'}\tlat=${best?.lat}\tbrake=${best?.brk}`);
      }
    }
    writeFileSync('docs/medal-calibration.tsv', lines.join('\n') + '\n');
  }, 600_000);
});
