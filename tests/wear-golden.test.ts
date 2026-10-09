import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { readFileSync } from 'node:fs';
import { parseTrack, type TrackData } from '../src/track/TrackData';
import { simulateRun, type SimOptions } from './helpers/raceSim';
import { fakeAssets } from './helpers/carAssets';
import type { CarSpec } from '../src/car/stats';
import type { Input } from '../src/core/Input';
import type { Action } from '../src/config/keybinds';
import { PHYS_DT } from '../src/config/constants';
import { FactoryWorld } from '../src/factory/FactoryWorld';
import { FactoryCars, carGroundOf } from '../src/factory/cars/FactoryCars';
import type { CarInstance, CarPose } from '../src/garage/assembly';
import { GameState } from '../src/state/GameState';
import { FactorySim } from '../src/factory/sim/FactorySim';
import { Terrain } from '../src/factory/sim/terrain';
import type { Vehicle } from '../src/vehicle/Vehicle';

beforeAll(async () => {
  await RAPIER.init();
});

// Golden runs: pinned on the commit before the wear measurements touched Vehicle.ts (7e4ed69). A new car (no wear),
// an old save, the wear meter running alongside: the race drive must stay the same, bit for bit. Never update these
// numbers to make a change pass: a difference here means the physics moved.

const TRACKS: Record<string, TrackData> = {
  oval: parseTrack(JSON.parse(readFileSync('src/data/tracks/oval.json', 'utf8'))),
  hill: parseTrack(JSON.parse(readFileSync('src/data/tracks/hill.json', 'utf8'))),
};
const CARS: Record<string, CarSpec> = {
  kart: { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } },
  sportFull: { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' } },
};
/** Bot settings: the default one, and the fast one of the medal calibration. */
const BOTS = { default: {}, fast: { latAccel: 58, braking: 20 } } as const;

/** [track, car, bot, finish ms, respawns, final pose (x, y, z, qx, qy, qz, qw)] */
const GOLDEN: [string, string, keyof typeof BOTS, number, number, number[]][] = [
  ['oval', 'kart', 'default', 23973, 0, [30.26050567626953, 0.03939315676689148, 3.0910677909851074, -0.02366356924176216, 0.649982750415802, 0.005850889720022678, 0.7595579028129578]],
  ['oval', 'kart', 'fast', 19125, 0, [30.255327224731445, 0.03949159383773804, 7.308426380157471, 0.02831104025244713, -0.68541419506073, -0.013657237403094769, -0.727474570274353]],
  ['oval', 'sportFull', 'default', 18966, 0, [30.015058517456055, 0.026393413543701172, 7.749655246734619, 0.01986571028828621, -0.7248417735099792, 0.003475962905213237, -0.6886202096939087]],
  ['oval', 'sportFull', 'fast', 18563, 0, [30.116954803466797, 0.02502727508544922, 5.988112449645996, 0.0040088919922709465, -0.8034298419952393, -0.015294273383915424, -0.5951895117759705]],
  ['hill', 'kart', 'default', 14806, 0, [161.70228576660156, 0.04025310277938843, 54.24295425415039, -0.028651703149080276, -0.6680883169174194, -0.0209640022367239, 0.7432345151901245]],
  ['hill', 'kart', 'fast', 14913, 0, [161.90692138671875, 0.040268898010253906, 53.8875732421875, -0.03230441361665726, -0.6533663272857666, -0.014248855412006378, 0.7562181949615479]],
  ['hill', 'sportFull', 'default', 14957, 0, [161.70614624023438, 0.02769947052001953, 54.117488861083984, -0.015177865512669086, -0.6757782101631165, -0.0028641698881983757, 0.736943244934082]],
  ['hill', 'sportFull', 'fast', 14572, 0, [161.62911987304688, 0.0270727276802063, 53.66144561767578, -0.007962977513670921, -0.7340015769004822, -0.010014969855546951, 0.6790271401405334]],
];

/** The same drive whatever the wear bookkeeping: none, the meter counting alongside, a car without wear (`wear: {}`). */
const VARIANTS: Record<string, SimOptions> = { plain: {}, meter: { meter: true }, 'no wear': { wear: {} }, 'meter, no wear': { meter: true, wear: {} } };

describe('golden runs: the race drive is pinned bit for bit', () => {
  it.each(GOLDEN.flatMap(([track, car, bot, ...pinned]) => Object.keys(VARIANTS).map((v) => [track, car, bot, v, ...pinned] as const)))('%s, %s, %s bot (%s)', (track, car, bot, variant, ms, respawns, pose) => {
    const r = simulateRun(TRACKS[track]!, CARS[car]!, { ...BOTS[bot], ...VARIANTS[variant] });
    expect(r.finished).toBe(true);
    expect(r.ms).toBe(ms);
    expect(r.respawns).toBe(respawns);
    expect(r.pose).toStrictEqual(pose);
    // The meter did count: a lap wears the tires.
    if (VARIANTS[variant]!.meter) expect(r.wear!.wheels).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------ the factory drive (gravity scale, speed cap, scripted velocities)

const KART: CarSpec = CARS.kart!;
const SPORT: CarSpec = { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' } };
const carAt = (id: string, spec: CarSpec, pose: CarPose): CarInstance => ({ id, name: id, blueprint: spec.blueprint, parts: { ...spec.parts } as CarInstance['parts'], pose });

/** A 128 m factory with a pond east of x = 68 m, 2 m deep, water level −40 cm (as in factory-cars.test). */
function pondState(): GameState {
  const W = 64;
  const M = 4;
  const n = W + 2 * M + 1;
  const cm: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) cm.push(Math.round(i - M > 40 ? -200 : i - M > 34 ? -200 * ((i - M - 34) / 6) : 0));
  return new GameState(new FactorySim({ width: W, height: W, terrain: Terrain.fromHeights(W, W, M, cm, -40), hub: null }));
}

/** Drives `car` through FactoryCars with a key script ([seconds, keys held]); walls are [x, z, half x, half z]. */
function factoryDrive(state: GameState, car: CarInstance, script: [number, Action[]][], walls: [number, number, number, number][] = []) {
  state.cars = [car];
  const fw = new FactoryWorld(state.sim);
  for (const [x, z, hx, hz] of walls) fw.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, 1.5, hz).setTranslation(x, 1.5, z));
  const events: string[] = [];
  const cars = new FactoryCars(fakeAssets(), fw.physics, new THREE.Scene(), state, { ground: carGroundOf(state.sim.terrain), isConveyor: () => false, onEvent: (k) => events.push(k) });
  const held = new Set<Action>();
  const input = {
    isDown: (a: Action) => held.has(a),
    axis: (neg: Action, pos: Action) => (held.has(pos) ? 1 : 0) - (held.has(neg) ? 1 : 0),
    padStick: () => ({ x: 0, y: 0 }),
    padTrigger: () => 0,
  } as unknown as Input;
  cars.enter(car.id);
  for (const [seconds, keys] of script) {
    held.clear();
    for (const k of keys) held.add(k);
    for (let i = 0; i < Math.round(seconds / PHYS_DT); i++) {
      cars.fixedUpdate(PHYS_DT, input);
      fw.physics.step(PHYS_DT);
    }
  }
  const v = (cars as unknown as { driving: { vehicle: Vehicle } }).driving.vehicle;
  v.afterWorldStep();
  const pose = [...v.curPos.toArray(), ...v.curQuat.toArray()];
  cars.dispose();
  fw.dispose();
  return { pose, events, car };
}

// FactoryCars always counts the wear of the driven car: these drives pin the meter (and scriptVelocity) too.

describe('golden factory drives: pinned bit for bit', () => {
  it('into a wall, handbrake, brake and away', () => {
    const r = factoryDrive(
      new GameState(FactorySim.newGame({ terrain: 'flat' })),
      carAt('k', KART, { x: 30, y: 0, z: 100, yaw: 0 }),
      [[1, []], [3, ['throttle']], [1, ['throttle', 'steerLeft', 'handbrake']], [1, ['brake']], [2, ['throttle', 'steerRight']], [1, []]],
      [[30, 125, 6, 0.5]],
    );
    // The wall was hit hard (the scenario still means something): the chassis took it.
    expect(r.car.wear?.chassis).toBeGreaterThan(10);
    expect(r.pose).toStrictEqual([31.21556282043457, -0.08113691210746765, 111.21408081054688, -0.0007014695438556373, -0.9266703128814697, 0.0017376343021169305, -0.37587034702301025]);
  });

  it('against the soft map edge', () => {
    const r = factoryDrive(new GameState(FactorySim.newGame({ terrain: 'flat' })), carAt('k', KART, { x: 10, y: 0, z: 100, yaw: -Math.PI / 2 }), [[1, []], [5, ['throttle']], [2, ['brake']]]);
    expect(r.pose).toStrictEqual([12.228046417236328, -0.08191472291946411, 100, 0.011496476829051971, -0.7070133090019226, 0.01149648055434227, 0.7070133090019226]);
  });

  it('into the pond: water drag, drowned twice and put back', () => {
    const r = factoryDrive(pondState(), carAt('s', SPORT, { x: 50, y: 0, z: 64, yaw: Math.PI / 2 }), [[8, ['throttle']], [1, []]]);
    expect(r.events).toEqual(['water', 'water']);
    expect(r.pose).toStrictEqual([70.54531860351562, -0.5049480199813843, 64, 0.058985162526369095, 0.7046423554420471, -0.0589851550757885, 0.7046422958374023]);
  });
});
