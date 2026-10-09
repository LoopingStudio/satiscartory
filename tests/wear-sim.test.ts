import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseTrack, type TrackData } from '../src/track/TrackData';
import { simulateRun, type SimOptions, type SimResult } from './helpers/raceSim';
import type { CarSpec } from '../src/car/stats';
import { WEAR } from '../src/data/balance';
import { BLUEPRINTS } from '../src/data/blueprints';
import type { CarWear } from '../src/data/wear';
import { LOANER_SPEC } from '../src/garage/assembly';
import { wearEffects } from '../src/car/wornTuning';
import { medalFor } from '../src/race/medals';

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

/** The medal calibration report: the best clean run of each car, `track/car` → its time (ms) and bot settings. */
const CALIBRATION = new Map(
  readFileSync('docs/medal-calibration.tsv', 'utf8').trim().split('\n').map((l) => {
    const [track, car, ms, lat, brake] = l.split('\t');
    return [`${track}/${car}`, { ms: Number(ms), bot: { latAccel: Number(lat!.slice(4)), braking: Number(brake!.slice(6)) } as SimOptions }] as const;
  }),
);
function lap(track: string, car: string, driver: 'clean' | 'sloppy'): SimResult {
  const bot = CALIBRATION.get(`${track}/${car}`)?.bot;
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

/*
 * Effects of the wear on a lap (car/wornTuning.ts). The Bot cannot measure them: its lap jumps by several % for a
 * 0.1 % change of the engine (a waypoint missed after a landing, a corner taken at its fixed speed with a little less
 * grip). The SteadyDriver (helpers/steadyDriver.ts) follows the line below every car's grip limit (28 m/s² where the
 * calibrated bots corner at 58 to 72 on the Ovale): there its lap time measures the engine, the drag and the brakes,
 * not the tires. Like a player who knows his car and drives it at its limit, it then assumes the worn car's grip and
 * brakes (slower corner speeds, earlier braking): that part of the loss is set by the test, not measured, which keeps
 * the upper bounds on the safe side. The lower bound and « it still finishes » are checked with the driver of the new
 * car (same assumptions, worn or not): only the physics slows the worn car down. That worn tires reach the wheels is
 * checked at the grip limit, on a skidpad (tests/vehicle-wear.test.ts).
 *
 * The Colline is a knife edge: the way the car lands after the first ramp sets its run up the steep one (up to 0.5 s
 * between two starts 5 cm apart), and up to one lap in four has a landing incident (+5 to +20 %). A lap time is the
 * mean of the fastest half of the laps (an incident is not the car's pace), over starts shifted back 5 cm each time:
 * still about ±0.3 % of noise there with 64 starts (over 400 starts, a tenth of wear costs the karts 0.43 %, the
 * Sportive 0.56 % and the full Sportive 0.69 %). The race limit costs ten times more: its first 16 starts do.
 */
const STEADY = { latAccel: 28, braking: 12 };
const SHIFTS: Record<string, number[]> = {
  oval: [0, 0.4, 0.8, 1.2, 1.6],
  hill: Array.from({ length: 64 }, (_, i) => i * 0.05),
};
/** The starts of a car worn `w` ‰ on `track` (the first ones of SHIFTS). */
const startsAt = (track: string, w: number) => SHIFTS[track]!.slice(0, w >= WEAR.BLOCK_ABOVE ? 16 : undefined);
/** Every installed slot worn `w` ‰. */
const everywhere = (spec: CarSpec, w: number): CarWear => Object.fromEntries(BLUEPRINTS[spec.blueprint].slots.filter((s) => spec.parts[s.id]).map((s) => [s.id, w]));

const steadyMemo = new Map<string, SimResult[]>();
/**
 * The steady driver's laps of `car` worn `w` ‰ everywhere, one per start shift (the first: the real start). `adapts`:
 * it assumes the worn car's grip and brakes; otherwise a new car's (the same driver as for the new car).
 */
function steadyLaps(track: string, car: string, w: number, adapts = true): SimResult[] {
  // New, both drivers are the same.
  const k = `${track}/${car}/${w}${w && !adapts ? '/new car driver' : ''}`;
  let laps = steadyMemo.get(k);
  if (!laps) {
    const spec = car === 'loaner' ? LOANER_SPEC : CARS[car]!;
    const wear = w ? everywhere(spec, w) : undefined;
    const e = adapts ? wearEffects(spec, wear) : { grip: 0, brake: 0 };
    const opts: SimOptions = { driver: 'steady', latAccel: STEADY.latAccel * (1 + e.grip), braking: STEADY.braking * (1 + Math.min(e.grip, e.brake)), wear };
    laps = startsAt(track, w).map((shift) => simulateRun(TRACKS[track]!, spec, { ...opts, shift }));
    steadyMemo.set(k, laps);
  }
  return laps;
}

/** Lap time (ms): the mean of the fastest half of the laps; a lap not finished cleanly counts as the slowest. */
function lapTime(laps: SimResult[]): number {
  const t = laps.map((r) => (r.finished && r.respawns === 0 && r.ms !== null ? r.ms : Infinity)).sort((a, b) => a - b);
  const fast = t.slice(0, Math.ceil(t.length / 2));
  return fast.reduce((a, b) => a + b, 0) / fast.length;
}
/** Lap time lost to the wear `w` (0.01 = 1 %), against the new car's laps from the same starts. */
function loss(track: string, car: string, w: number, adapts = true): number {
  const worn = steadyLaps(track, car, w, adapts);
  return lapTime(worn) / lapTime(steadyLaps(track, car, 0).slice(0, worn.length)) - 1;
}

/** How much slower than its calibrated clean run a player's car may get on `track` before it loses its medal: the least of them. */
function tightestMargin(track: string): number {
  const medals = TRACKS[track]!.medals!;
  return Math.min(...Object.keys(CARS).map((car) => {
    const ms = CALIBRATION.get(`${track}/${car}`)!.ms;
    const medal = medalFor(ms, medals);
    return medal ? medals[medal] / ms - 1 : Infinity;
  }));
}
/**
 * Most a tenth of wear everywhere may cost: half a percent (the medal margins are thin: the kart keeps the Ovale's
 * silver by 0.34 %), or a third of the track's tightest medal margin when that is more. That is the Colline (kart
 * racing's gold, 2.7 %: 0.89 %), whose measure is noisier than half a percent and where the Sportive loses more: its
 * engine pushes 7.8 m/s², less than the 8.9 m/s² the steep ramp (6 m up over 12) takes from the race's 20 m/s² of
 * gravity; it climbs on its momentum, and a worn engine slows it down there about twice as fast at the race limit.
 */
const tenthBound = (track: string) => Math.max(0.005, tightestMargin(track) / 3);
/** Most the race limit may cost: 15 %, 20 % for the Sportive on the Colline (its steep ramp, see tenthBound). */
const limitBound = (track: string, car: string) => (track === 'hill' && CARS[car]!.blueprint === 'sport' ? 0.2 : 0.15);
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

describe('wear effects (steady driver laps)', () => {
  it('a tenth of wear may cost half a percent of lap time on the Ovale, a third of kart racing\'s gold margin on the Colline', () => {
    expect(tenthBound('oval')).toBe(0.005);
    expect(tightestMargin('oval')).toBeLessThan(0.005);
    expect(tenthBound('hill')).toBeGreaterThan(0.005);
    expect(tenthBound('hill')).toBeLessThan(0.01);
  });

  it.each(cases(['oval', 'hill']))('%s, %s: a tenth of wear everywhere costs at most that much lap time', (track, car) => {
    expect(loss(track, car, 100)).toBeLessThanOrEqual(tenthBound(track));
  });

  it.each(cases(['oval', 'hill']))('%s, %s: at the race limit (800 ‰ everywhere) the car still finishes, at most 15 % slower (20 % for the Sportive on the Colline)', (track, car) => {
    for (const adapts of [true, false]) {
      const start = steadyLaps(track, car, WEAR.BLOCK_ABOVE, adapts)[0]!;
      expect([start.finished, start.respawns], adapts ? 'its driver' : 'the new car\'s driver').toEqual([true, 0]);
    }
    expect(loss(track, car, WEAR.BLOCK_ABOVE)).toBeLessThanOrEqual(limitBound(track, car));
  });

  it.each(cases(['oval', 'hill']))('%s, %s: at the race limit the physics alone (the new car\'s driver) makes the lap at least 3 % slower', (track, car) => {
    expect(loss(track, car, WEAR.BLOCK_ABOVE, false)).toBeGreaterThanOrEqual(0.03);
  });

  it.each(['oval', 'hill'])('%s: a kart at the race limit is still faster than the loaner', (track) => {
    const kart = steadyLaps(track, 'kart', WEAR.BLOCK_ABOVE);
    expect(lapTime(kart)).toBeLessThan(lapTime(steadyLaps(track, 'loaner', 0).slice(0, kart.length)));
  });
});
