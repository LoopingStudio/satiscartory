import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { readGlb, worldTriangles, nodeBoxes } from '../scripts/lib/glb.mjs';
import { carGeometryFromBoxes, type CarGeometry } from '../src/car/geometry';
import { computeCarStats, type CarSpec } from '../src/car/stats';
import { tuningFromStats } from '../src/car/tuning';
import { Vehicle, NO_CONTROLS, type VehicleControls } from '../src/vehicle/Vehicle';
import { GRAVITY_RACE, PHYS_DT } from '../src/config/constants';

beforeAll(async () => {
  await RAPIER.init();
});

function geometry(model: string): CarGeometry {
  const { tris } = worldTriangles(readGlb(`public/assets/kenney/car-kit/${model}.glb`));
  return carGeometryFromBoxes(nodeBoxes(tris));
}

const KART: CarSpec = { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } };
const SPORT: CarSpec = { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel', spoiler: 'spoiler' } };

function setup(spec: CarSpec, model: string) {
  const world = new RAPIER.World({ x: 0, y: GRAVITY_RACE, z: 0 });
  world.timestep = PHYS_DT;
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setFriction(1));
  const stats = computeCarStats(spec);
  const car = new Vehicle(world, geometry(model), tuningFromStats(stats), { position: new THREE.Vector3(0, 0.6, 0), yaw: 0 });
  const run = (seconds: number, c: VehicleControls = NO_CONTROLS) => {
    for (let i = 0; i < Math.round(seconds / PHYS_DT); i++) {
      car.step(PHYS_DT, c);
      world.step();
      car.afterWorldStep();
    }
  };
  return { world, car, stats, run };
}

describe('vehicle (headless Rapier)', () => {
  it('car geometry finds 4 wheels front/left tagged', () => {
    const g = geometry('race');
    expect(g.wheels).toHaveLength(4);
    expect(g.wheels.filter((w) => w.front)).toHaveLength(2);
    expect(g.wheels.filter((w) => w.left)).toHaveLength(2);
    const fl = g.wheels.find((w) => w.front && w.left)!;
    expect(fl.center[0]).toBeGreaterThan(0); // left = +X
    expect(fl.center[2]).toBeGreaterThan(0); // front = +Z
  });

  it('settles at rest on flat ground without drifting', () => {
    const { car, run } = setup(KART, 'kart-oopi');
    run(2);
    const a = car.curPos.clone();
    run(1);
    const p = car.curPos;
    expect(Math.abs(p.x)).toBeLessThan(0.05);
    expect(Math.abs(p.z)).toBeLessThan(0.05);
    expect(p.distanceTo(a)).toBeLessThan(0.01);
    expect(car.wheelsInContact).toBe(4);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(car.curQuat);
    expect(up.y).toBeGreaterThan(0.999);
  });

  it('throttle drives the car forward along +Z (axle/forward-axis convention)', () => {
    const { car, run } = setup(KART, 'kart-oopi');
    run(1);
    run(2, { ...NO_CONTROLS, throttle: 1 });
    expect(car.curPos.z).toBeGreaterThan(10);
    expect(Math.abs(car.curPos.x)).toBeLessThan(1);
    expect(car.speed).toBeGreaterThan(10);
  });

  it.each([
    ['kart', KART, 'kart-oopi'],
    ['sport', SPORT, 'sedan-sports'],
  ] as const)('%s reaches its stat top speed (±10%%)', (_n, spec, model) => {
    const { car, run, stats } = setup(spec, model);
    run(0.5);
    run(40, { ...NO_CONTROLS, throttle: 1 });
    expect(car.speed).toBeGreaterThan(stats.topSpeedMs * 0.9);
    expect(car.speed).toBeLessThan(stats.topSpeedMs * 1.1);
  });

  it('steering left turns toward +X (car left) and the car stays upright', () => {
    const { car, run } = setup(SPORT, 'sedan-sports');
    run(0.5);
    run(3, { ...NO_CONTROLS, throttle: 1 });
    run(0.4, { ...NO_CONTROLS, throttle: 0.6, steer: 1 });
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(car.curQuat);
    const heading = Math.atan2(fwd.x, fwd.z);
    expect(heading).toBeGreaterThan(0.3); // turned toward +X (left) without spinning past 90°
    expect(heading).toBeLessThan(Math.PI / 2);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(car.curQuat);
    expect(up.y).toBeGreaterThan(0.8);
  });

  it('brakes to a stop from speed, then reverses', () => {
    const { car, run } = setup(KART, 'kart-oopi');
    run(0.5);
    run(4, { ...NO_CONTROLS, throttle: 1 });
    run(3, { ...NO_CONTROLS, brake: 1 });
    expect(car.speed).toBeLessThan(1.5);
    run(1.5, { ...NO_CONTROLS, brake: 1 });
    expect(car.speed).toBeLessThan(-1);
  });

  it('kart accelerates harder off the line; sport has the higher top speed', () => {
    const k = setup(KART, 'kart-oopi');
    const s = setup(SPORT, 'sedan-sports');
    k.run(0.5);
    s.run(0.5);
    k.run(1.5, { ...NO_CONTROLS, throttle: 1 });
    s.run(1.5, { ...NO_CONTROLS, throttle: 1 });
    expect(k.car.speed).toBeGreaterThan(s.car.speed);
    expect(s.stats.topSpeedMs).toBeGreaterThan(k.stats.topSpeedMs * 1.4);
  });
});

describe('vehicle robustness (review regressions)', () => {
  it.each([
    ['kart', KART, 'kart-oopi'],
    ['loaner', { blueprint: 'loaner', parts: {} } as CarSpec, 'kart-oobi'],
    ['sport', SPORT, 'sedan-sports'],
  ] as const)('%s lying on its side either rights itself or triggers the auto-respawn timer', (_n, spec, model) => {
    const world = new RAPIER.World({ x: 0, y: GRAVITY_RACE, z: 0 });
    world.timestep = PHYS_DT;
    world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setFriction(1));
    const car = new Vehicle(world, geometry(model), tuningFromStats(computeCarStats(spec)), { position: new THREE.Vector3(0, 1.5, 0), yaw: 0 });
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (100 * Math.PI) / 180);
    car.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    let max = 0;
    for (let i = 0; i < 60 * 4; i++) {
      car.step(PHYS_DT, NO_CONTROLS);
      world.step();
      car.afterWorldStep();
      max = Math.max(max, car.flippedTime);
    }
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(car.curQuat);
    const recovered = up.y > 0.9 && car.wheelsInContact >= 3;
    expect(recovered || max > 1.6).toBe(true);
    world.free();
  });

  it('handbrake adds to the foot brake instead of replacing it', () => {
    const a = setup(SPORT, 'sedan-sports');
    const b = setup(SPORT, 'sedan-sports');
    for (const s of [a, b]) {
      s.run(0.5);
      s.run(4, { ...NO_CONTROLS, throttle: 1 });
    }
    a.run(1.2, { ...NO_CONTROLS, brake: 1 });
    b.run(1.2, { ...NO_CONTROLS, brake: 1, handbrake: true });
    expect(b.car.speed).toBeLessThanOrEqual(a.car.speed + 0.5);
  });
});
