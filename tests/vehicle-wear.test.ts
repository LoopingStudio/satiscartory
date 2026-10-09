import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { readGlb, worldTriangles, nodeBoxes } from '../scripts/lib/glb.mjs';
import { KIT } from './helpers/carAssets';
import { GRAVITY_FACTORY, GRAVITY_RACE, PHYS_DT } from '../src/config/constants';
import { carGeometryFromBoxes } from '../src/car/geometry';
import { computeCarStats, type CarSpec } from '../src/car/stats';
import { tuningFromStats } from '../src/car/tuning';
import { Vehicle, NO_CONTROLS, type VehicleControls, type VehicleOptions, type VehicleSpawn } from '../src/vehicle/Vehicle';
import { CAR_GRAVITY_SCALE, FACTORY_CAR } from '../src/factory/cars/carMath';
import { WearMeter } from '../src/car/wearMeter';
import { wearEffects, wornTuning } from '../src/car/wornTuning';
import { WEAR } from '../src/data/balance';

beforeAll(async () => {
  await RAPIER.init();
});

/*
 * The wear readings of the Vehicle (lateralSpeed, impact), headless: what counts as a shock and what does not, in the
 * race world and in the factory world (its own gravity, the car's gravity scale and the factory options). And worn
 * tires at the grip limit: the friction of the worn tuning reaches the wheels.
 */

const KART: CarSpec = { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } };
const SPORT: CarSpec = { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel', spoiler: 'spoiler' } };
const CARS = [['kart', KART, 'kart-oopi'], ['sport', SPORT, 'sedan-sports']] as const;
const WORLDS = ['race', 'factory'] as const;
const FACTORY_OPTS: VehicleOptions = { gravityScale: CAR_GRAVITY_SCALE, speedCap: FACTORY_CAR.SPEED_CAP, holdBrake: true, slopeSpeedCap: true };

const geometry = (model: string) => carGeometryFromBoxes(nodeBoxes(worldTriangles(readGlb(`${KIT}/${model}.glb`)).tris));

/** A car on a flat floor (y = 0) in the race or factory world; `run` steps it like RaceMode and keeps the impact peak. */
function bench(world: 'race' | 'factory', spec: CarSpec, model: string, spawn: VehicleSpawn = { position: new THREE.Vector3(0, 0.6, 0), yaw: 0 }) {
  const w = new RAPIER.World({ x: 0, y: world === 'race' ? GRAVITY_RACE : GRAVITY_FACTORY, z: 0 });
  w.timestep = PHYS_DT;
  w.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setFriction(1));
  const car = new Vehicle(w, geometry(model), tuningFromStats(computeCarStats(spec)), spawn, world === 'factory' ? FACTORY_OPTS : {});
  const worn = { blueprint: spec.blueprint, parts: { ...spec.parts } as Record<string, string>, wear: undefined as Record<string, number> | undefined };
  const meter = new WearMeter(worn);
  let peak = 0;
  /** Sums of the impacts above the shock floor over consecutive steps (the meter's windows, uncapped in length). */
  const windows: number[] = [];
  let open = 0;
  /** The body's speed right after the last car step: what the world step changes next (see planeDv). */
  const out = new THREE.Vector3();
  const gravityY = w.gravity.y * (world === 'factory' ? CAR_GRAVITY_SCALE : 1);
  const step = (c: VehicleControls = NO_CONTROLS) => {
    car.step(PHYS_DT, c);
    const o = car.body.linvel();
    out.set(o.x, o.y, o.z);
    meter.step(PHYS_DT, car, c);
    peak = Math.max(peak, car.impact);
    if (car.impact > WEAR.SHOCK_FLOOR) open += car.impact;
    else if (open > 0) {
      windows.push(open);
      open = 0;
    }
    w.step();
    car.afterWorldStep();
  };
  const run = (seconds: number, c: VehicleControls = NO_CONTROLS) => {
    for (let i = 0; i < Math.round(seconds / PHYS_DT); i++) step(c);
  };
  /** Highest impact since the last call. */
  const takePeak = () => {
    const p = peak;
    peak = 0;
    return p;
  };
  const wall = (x: number, z: number, hx: number, hz: number) => w.createCollider(RAPIER.ColliderDesc.cuboid(hx, 2, hz).setTranslation(x, 2, z));
  /**
   * The speed change the last world step gave the body in the car's plane, with no ground tilt taken out: the speed now
   * minus the speed after the last car step and minus gravity, without its part along the car's up axis. The next
   * step's impact when nothing is taken for a tilted ground (not right after a scriptVelocity).
   */
  const planeDv = () => {
    const lv = car.body.linvel();
    const r = car.body.rotation();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    const d = new THREE.Vector3(lv.x, lv.y - gravityY * PHYS_DT, lv.z).sub(out);
    return d.addScaledVector(up, -d.dot(up)).length();
  };
  return { w, car, meter, worn, step, run, takePeak, windows, wall, planeDv };
}

/**
 * Steps `b` `seconds` with `c` and sums, over the steps where the contacts changed the speed by more than the shock
 * floor in the car's plane, that change (planeDv) and the impact measured; `least`: the lowest impact / change.
 */
function shocks(b: ReturnType<typeof bench>, seconds: number, c: VehicleControls) {
  let plane = 0;
  let measured = 0;
  let least = Infinity;
  for (let i = 0; i < Math.round(seconds / PHYS_DT); i++) {
    const dv = b.planeDv();
    b.step(c);
    if (dv <= WEAR.SHOCK_FLOOR) continue;
    plane += dv;
    measured += b.car.impact;
    least = Math.min(least, b.car.impact / dv);
  }
  return { plane, measured, least };
}

const quatX = (deg: number) => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (deg * Math.PI) / 180);
  return { x: q.x, y: q.y, z: q.z, w: q.w };
};

describe.each(WORLDS)('Vehicle wear readings (%s world)', (world) => {
  it.each(CARS)('%s on flat ground: no impact (< 0.05 m/s) for throttle, turns, handbrake and brakes; the side slide is read', (_n, spec, model) => {
    const b = bench(world, spec, model);
    b.run(1);
    b.takePeak();
    const drives: VehicleControls[] = [
      { ...NO_CONTROLS, throttle: 1 },
      { ...NO_CONTROLS, throttle: 1, steer: 1 },
      { ...NO_CONTROLS, throttle: 1, steer: -1, handbrake: true },
      { ...NO_CONTROLS, brake: 1 },
      { ...NO_CONTROLS, brake: 1, steer: 0.5 },
    ];
    let slide = 0;
    for (const c of drives) {
      for (let i = 0; i < 90; i++) {
        b.step(c);
        slide = Math.max(slide, b.car.lateralSpeed);
      }
      expect(b.takePeak()).toBeLessThan(0.05);
    }
    // A handbrake turn slides: the tires feel it.
    expect(slide).toBeGreaterThan(WEAR.SLIP_FREE);
    expect(b.worn.wear?.chassis).toBeUndefined();
    b.w.free();
  });

  it.each(CARS)('%s steering 2 s into a wall at full throttle stays under the shock floor', (_n, spec, model) => {
    /** The car's box: half width (x) and front (z) from the car's origin. */
    const extents = (car: Vehicle) => {
      const he = (car.collider.shape as RAPIER.Cuboid).halfExtents;
      return { side: he.x, front: car.collider.translation().z - car.curPos.z + he.z };
    };
    // Side 5 cm from a long wall on its left (+X), then steering into it.
    const b = bench(world, spec, model);
    b.wall(extents(b.car).side + 0.55, 0, 0.5, 60);
    b.run(1);
    b.takePeak();
    b.run(2, { ...NO_CONTROLS, throttle: 1, steer: 1 });
    const side = b.takePeak();
    expect(side).toBeGreaterThan(0.05);
    expect(side).toBeLessThan(WEAR.SHOCK_FLOOR);
    b.w.free();
    // Nose 5 cm from a wall, pushing and steering both ways.
    const n = bench(world, spec, model);
    n.wall(0, extents(n.car).front + 0.55, 30, 0.5);
    n.run(1);
    n.takePeak();
    n.run(2, { ...NO_CONTROLS, throttle: 1, steer: 1 });
    n.run(2, { ...NO_CONTROLS, throttle: 1, steer: -1 });
    const nose = n.takePeak();
    expect(nose).toBeGreaterThan(0.05);
    expect(nose).toBeLessThan(WEAR.SHOCK_FLOOR);
    n.meter.end();
    expect(n.worn.wear?.chassis).toBeUndefined();
    n.w.free();
  });

  it.each(CARS)('%s landing pitched 20 to 30° (nose up or down) from up to 2 m: under the shock floor, no wear', (_n, spec, model) => {
    for (const deg of [20, 25, 30, -20, -25, -30]) {
      for (const h of [1, 2]) {
        const b = bench(world, spec, model, { position: new THREE.Vector3(0, h, 0), yaw: 0, quat: quatX(-deg) });
        b.car.scriptVelocity(0, 0, 15);
        b.run(2.5, { ...NO_CONTROLS, throttle: 1 });
        expect(b.takePeak(), `${deg}° from ${h} m`).toBeLessThan(WEAR.SHOCK_FLOOR);
        b.meter.end();
        expect(b.worn.wear?.chassis, `${deg}° from ${h} m`).toBeUndefined();
        b.w.free();
      }
    }
  });

  it.each(CARS)('%s landing flat or pitched up to 30° from 4 to 8 m: a shock now and then, under 5 ‰ of body per jump', (_n, spec, model) => {
    let peak = 0;
    for (const deg of [0, 15, -15, 25, -25, 30, -30]) {
      for (const h of [4, 6, 8]) {
        for (const speed of [15, 30]) {
          const b = bench(world, spec, model, { position: new THREE.Vector3(0, h, 0), yaw: 0, quat: quatX(-deg) });
          b.car.scriptVelocity(0, 0, speed);
          b.run(2.5, { ...NO_CONTROLS, throttle: 1 });
          peak = Math.max(peak, b.takePeak());
          b.meter.closeShock();
          for (const s of ['chassis', 'panels', 'spoiler'] as const) expect(b.meter.exact(s), `${s}, ${deg}° from ${h} m at ${speed} m/s`).toBeLessThan(5);
          b.w.free();
        }
      }
    }
    // Higher than 2 m, a landing does cross the shock floor (see WEAR.SHOCK_FLOOR).
    expect(peak).toBeGreaterThan(WEAR.SHOCK_FLOOR);
  });

  it.each(CARS)('%s head-on into a wall at 20 m/s: a shock window of more than 15 m/s, charged to the body', (_n, spec, model) => {
    const b = bench(world, spec, model);
    b.wall(0, 30, 10, 0.5);
    b.run(0.5);
    b.car.scriptVelocity(0, 0, 20);
    b.run(2);
    expect(Math.max(...b.windows)).toBeGreaterThan(15);
    expect(b.meter.last.cause).toBe('shock');
    expect(b.meter.last.slot).toBe(spec === SPORT ? 'panels' : 'chassis');
    // Away from the wall (−Z).
    expect(b.meter.last.dz).toBeLessThan(-0.9);
    expect(b.worn.wear!.chassis).toBeGreaterThan(30);
    b.w.free();
  });

  // The hit rolls the car 5 to 7° during its world step: read against the pose after it, the flat ground would look
  // tilted, and the wall's push along that roll would be taken for the ground's.
  it.each(CARS)('%s into a wall at 45° at 25 m/s on flat ground, full throttle: the whole speed change in the plane of the car counts', (_n, spec, model) => {
    const full = { ...NO_CONTROLS, throttle: 1 };
    const b = bench(world, spec, model, { position: new THREE.Vector3(0, 0.6, 0), yaw: Math.PI / 4 });
    b.wall(0, 18, 60, 0.5);
    b.run(0.5);
    b.car.scriptVelocity(25 * Math.SQRT1_2, 0, 25 * Math.SQRT1_2);
    b.step(full);
    const s = shocks(b, 2, full);
    expect(s.plane).toBeGreaterThan(15);
    expect(s.least).toBeGreaterThan(0.999);
    expect(Math.max(...b.windows)).toBeGreaterThan(15);
    b.w.free();
  });

  it.each(CARS)('%s: nothing is measured across a reset or a hold', (_n, spec, model) => {
    const b = bench(world, spec, model);
    b.run(0.5);
    b.car.scriptVelocity(0, 0, 25);
    b.step();
    // Teleported (respawn): the speed jumps to 0, no shock.
    b.car.reset(new THREE.Vector3(50, 0.6, 0), 0);
    b.step();
    expect(b.car.impact).toBe(0);
    b.car.scriptVelocity(0, 0, 25);
    b.step();
    // Held on the line (countdown), after the world step.
    b.car.hold();
    b.step();
    expect(b.car.impact).toBe(0);
    b.run(1);
    expect(b.takePeak()).toBeLessThan(0.05);
    b.w.free();
  });

  it.each(CARS)('%s: a scripted speed (water drag, soft map edge) is no shock, a hit during it still is', (_n, spec, model) => {
    const b = bench(world, spec, model);
    b.run(0.5);
    b.car.scriptVelocity(0, 0, 22);
    b.run(0.2);
    b.takePeak();
    // The water's drag every step, then the soft edge stopping it dead.
    for (let i = 0; i < 60; i++) {
      const lv = b.car.body.linvel();
      b.car.scriptVelocity(lv.x * 0.9, lv.y, lv.z * 0.9);
      b.step({ ...NO_CONTROLS, throttle: 1 });
    }
    const lv = b.car.body.linvel();
    b.car.scriptVelocity(lv.x, lv.y, 0);
    b.run(0.5);
    expect(b.takePeak()).toBeLessThan(0.05);
    // Still scripted, now into a wall.
    b.wall(0, b.car.curPos.z + 6, 10, 0.5);
    b.car.scriptVelocity(0, 0, 18);
    for (let i = 0; i < 60; i++) {
      const v = b.car.body.linvel();
      b.car.scriptVelocity(v.x * 0.99, v.y, v.z * 0.99);
      b.step();
    }
    expect(b.takePeak()).toBeGreaterThan(10);
    b.w.free();
  });

  it.each(CARS)('%s hitting a parked car (a fixed box) at 15 m/s counts as a shock', (_n, spec, model) => {
    const b = bench(world, spec, model);
    const parked = b.w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 25));
    b.w.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.7, 2).setTranslation(0, 0.7, 0).setFriction(0.6), parked);
    b.run(0.5);
    b.car.scriptVelocity(0, 0, 15);
    b.run(2);
    expect(Math.max(...b.windows)).toBeGreaterThan(10);
    expect(b.worn.wear!.chassis).toBeGreaterThan(10);
    b.w.free();
  });

  it.each(CARS)('%s: skipImpact(2) drops the measure of the step the car was moved, and of the world step after it', (_n, spec, model) => {
    const moved = (skip: boolean) => {
      const b = bench(world, spec, model);
      b.wall(0, 40, 10, 0.5);
      b.run(0.5);
      b.car.scriptVelocity(0, 0, 20);
      b.step();
      // Moved 5 cm into the wall (like a car lifted into a risen bank): the next world step pushes it out.
      const p = b.car.curPos;
      const front = b.car.collider.translation().z + (b.car.collider.shape as RAPIER.Cuboid).halfExtents.z - p.z;
      b.car.body.setTranslation({ x: p.x, y: p.y, z: 39.5 - front + 0.05 }, true);
      b.car.afterWorldStep();
      if (skip) b.car.skipImpact(2);
      const seen: number[] = [];
      for (let i = 0; i < 3; i++) {
        b.step();
        seen.push(b.car.impact);
      }
      b.w.free();
      return seen;
    };
    expect(moved(false)[1]).toBeGreaterThan(15);
    const [first, second] = moved(true);
    expect([first, second]).toEqual([0, 0]);
  });

  // The steady driver of tests/wear-sim.test.ts stays below the grip limit: worn tires must be checked at the limit.
  it.each(CARS)('%s on a skidpad (full lock from 20 m/s): worn tires (800 ‰) reach the wheels, the car corners as much less hard as its grip', (_n, spec, model) => {
    const wear = { wheels: WEAR.BLOCK_ABOVE };
    /** Mean lateral acceleration (m/s²) over the last 2 of 3 s at full lock, with the tuning applied like RaceMode and FactoryCars do. */
    const cornering = (worn: boolean) => {
      const b = bench(world, spec, model);
      if (worn) b.car.applyTuning(wornTuning(b.car.tuning, wear, spec.parts));
      b.run(0.5);
      b.car.scriptVelocity(0, 0, 20);
      b.run(1 / 6);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 180; i++) {
        const v = b.car.body.linvel();
        const [vx, vz] = [v.x, v.z];
        b.step({ ...NO_CONTROLS, steer: 1, throttle: 0.6 });
        const after = b.car.body.linvel();
        if (i < 60) continue;
        // The part of the speed change across the direction of travel.
        sum += Math.abs((after.x - vx) * -vz + (after.z - vz) * vx) / Math.hypot(vx, vz) / PHYS_DT;
        n++;
      }
      b.w.free();
      return sum / n;
    };
    // Both ways from the frictions of the tuning: −17 % at the race limit (WEAR.EFFECT.grip on the wear curve).
    expect(cornering(true) / cornering(false)).toBeCloseTo(1 + wearEffects(spec, wear).grip, 1);
  });
});

describe('Vehicle wear readings: a hit while the body leans', () => {
  // The racing tires corner hardest: in a hard turn at 45 m/s this body rolls about 7° on flat ground.
  const SPORT_FULL: CarSpec = { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' } };

  it('the full Sportive leaning out of a hard turn at 45 m/s, pushed into a wall on that side: the whole speed change counts', () => {
    const turn = { ...NO_CONTROLS, throttle: 1, steer: -0.6 };
    const b = bench('race', SPORT_FULL, 'sedan-sports');
    b.run(0.5);
    b.car.scriptVelocity(0, 0, 45);
    b.run(1, turn);
    // Turning right, the body leans out to its left (+X).
    const q = b.car.curQuat;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const left = new THREE.Vector3(1, 0, 0).applyQuaternion(q).setY(0).normalize();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    expect(THREE.MathUtils.radToDeg(Math.acos(up.y))).toBeGreaterThan(6);
    expect(up.dot(left)).toBeGreaterThan(0);
    // A wall along the car 30 cm off its left side, and a push into it (scripted: no shock by itself).
    const he = (b.car.collider.shape as RAPIER.Cuboid).halfExtents;
    const at = b.car.curPos.clone().addScaledVector(left, he.x + 0.3 + 0.5);
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(fwd.x, fwd.z));
    b.w.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 2, 40).setTranslation(at.x, 2, at.z).setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w }));
    const v = b.car.body.linvel();
    b.car.scriptVelocity(v.x + left.x * 12, v.y, v.z + left.z * 12);
    b.step(turn);
    const s = shocks(b, 0.5, turn);
    expect(s.plane).toBeGreaterThan(4);
    expect(s.measured / s.plane).toBeGreaterThan(0.999);
    b.w.free();
  });
});
