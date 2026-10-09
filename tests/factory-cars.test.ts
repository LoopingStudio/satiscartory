import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { readGlb, worldTriangles, nodeBoxes } from '../scripts/lib/glb.mjs';
import { KIT, fakeAssets, kitMaterial } from './helpers/carAssets';
import type { Input } from '../src/core/Input';
import type { Action } from '../src/config/keybinds';
import { GRAVITY_FACTORY, GRAVITY_RACE, PHYS_DT, PLAYER_HEIGHT, PLAYER_RADIUS } from '../src/config/constants';
import { VEHICLE } from '../src/data/vehicle';
import { carGeometryFromBoxes, type CarGeometry } from '../src/car/geometry';
import { computeCarStats, type CarSpec } from '../src/car/stats';
import { tuningFromStats } from '../src/car/tuning';
import { FactoryWorld } from '../src/factory/FactoryWorld';
import { FactoryCars, carGroundOf } from '../src/factory/cars/FactoryCars';
import { CAR_GRAVITY_SCALE, FACTORY_CAR, distanceToBox, toLocal } from '../src/factory/cars/carMath';
import { bayPose } from '../src/garage/parking';
import type { CarInstance, CarPose } from '../src/garage/assembly';
import { GameState } from '../src/state/GameState';
import { FactorySim } from '../src/factory/sim/FactorySim';
import { Terrain } from '../src/factory/sim/terrain';
import { upYOfQuat } from '../src/factory/cars/carMath';
import { Vehicle, NO_CONTROLS, type VehicleControls, type VehicleOptions } from '../src/vehicle/Vehicle';
import { makeCarPreview } from '../src/car/CarModel';
import type { WearMeter } from '../src/car/wearMeter';
import { wornTuning } from '../src/car/wornTuning';
import { WEAR } from '../src/data/balance';

beforeAll(async () => {
  await RAPIER.init();
});

// ------------------------------------------------------------------ car layouts (fake assets: helpers/carAssets)

function geometry(model: string): CarGeometry {
  return carGeometryFromBoxes(nodeBoxes(worldTriangles(readGlb(`${KIT}/${model}.glb`)).tris));
}

// ------------------------------------------------------------------ factory setup

const KART: CarSpec = { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } };
const SPORT: CarSpec = { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' } };

function carAt(id: string, spec: CarSpec, pose: CarPose | null): CarInstance {
  return { id, name: id, blueprint: spec.blueprint, parts: { ...spec.parts } as CarInstance['parts'], pose };
}

/** The real map's nodes and hub on flat ground: the positions below assume a flat floor (slopes: terrain-cars tests). */
function setup(state = new GameState(FactorySim.newGame({ terrain: 'flat' })), events: string[] = []) {
  const fw = new FactoryWorld(state.sim);
  const scene = new THREE.Scene();
  const isConveyor = (c: RAPIER.Collider) => {
    const id = fw.buildingOf(c);
    return id !== null && state.sim.buildings.get(id)?.type === 'conveyor';
  };
  const cars = new FactoryCars(fakeAssets(), fw.physics, scene, state, { ground: carGroundOf(state.sim.terrain), isConveyor, onEvent: (k) => events.push(k) });
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1000);
  const held = new Set<Action>();
  const input = {
    isDown: (a: Action) => held.has(a),
    axis: (neg: Action, pos: Action) => (held.has(pos) ? 1 : 0) - (held.has(neg) ? 1 : 0),
    padStick: () => ({ x: 0, y: 0 }),
    padTrigger: () => 0,
  } as unknown as Input;
  const step = () => {
    cars.fixedUpdate(PHYS_DT, input);
    fw.physics.step(PHYS_DT);
  };
  const run = (seconds: number, keys: Action[] = []) => {
    held.clear();
    for (const k of keys) held.add(k);
    for (let i = 0; i < Math.round(seconds / PHYS_DT); i++) {
      step();
      if (i % 4 === 0) cars.update(PHYS_DT * 4, 1, camera);
    }
    held.clear();
    cars.update(PHYS_DT, 1, camera);
  };
  const car = (id: string) => state.cars.find((c) => c.id === id)!;
  /** Something solid (and enabled) touches a standing player capsule at these feet? Needs a step first. */
  const blocked = (p: THREE.Vector3) =>
    !!fw.physics.world.intersectionWithShape({ x: p.x, y: p.y + PLAYER_HEIGHT / 2 + 0.05, z: p.z }, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Capsule(PLAYER_HEIGHT / 2 - PLAYER_RADIUS, PLAYER_RADIUS));
  const wall = (x: number, z: number, hx: number, hz: number) => fw.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, 1.5, hz).setTranslation(x, 1.5, z));
  /** Brakes until (nearly) stopped (holding the brake once stopped would reverse), then coasts a bit. */
  const stop = () => {
    held.clear();
    held.add('brake');
    for (let i = 0; i < 600 && Math.abs(vehicleOf(cars).speed) > 0.8; i++) step();
    run(0.4);
  };
  return { state, fw, scene, cars, camera, input, held, run, step, stop, car, blocked, wall };
}

/** Driven vehicle (test-only peek at the private state). */
const vehicleOf = (cars: FactoryCars) => (cars as unknown as { driving: { vehicle: Vehicle } | null }).driving!.vehicle;
const carModels = (scene: THREE.Scene) => scene.children.filter((o) => o.children.some((c) => c.name.startsWith('car-kit/')));

// ------------------------------------------------------------------ Vehicle options (opt-in)

function vehicleIn(gravity: number, spec: CarSpec, model: string, opts?: VehicleOptions) {
  const world = new RAPIER.World({ x: 0, y: gravity, z: 0 });
  world.timestep = PHYS_DT;
  world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setFriction(1));
  const car = new Vehicle(world, geometry(model), tuningFromStats(computeCarStats(spec)), { position: new THREE.Vector3(0, 0.6, 0), yaw: 0 }, opts);
  const run = (seconds: number, c: VehicleControls = NO_CONTROLS) => {
    for (let i = 0; i < Math.round(seconds / PHYS_DT); i++) {
      car.step(PHYS_DT, c);
      world.step();
      car.afterWorldStep();
    }
  };
  return { world, car, run };
}

describe('Vehicle options', () => {
  it('defaults are the race behaviour, bit for bit', () => {
    const a = vehicleIn(GRAVITY_RACE, SPORT, 'sedan-sports');
    const b = vehicleIn(GRAVITY_RACE, SPORT, 'sedan-sports', { gravityScale: 1 });
    for (const s of [a, b]) {
      s.run(0.5);
      s.run(3, { ...NO_CONTROLS, throttle: 1, steer: 0.3 });
    }
    expect(b.car.curPos.toArray()).toEqual(a.car.curPos.toArray());
    expect(b.car.curQuat.toArray()).toEqual(a.car.curQuat.toArray());
    a.world.free();
    b.world.free();
  });

  it('with the gravity scale, a car in the factory world sits and grips like in the race', () => {
    const race = vehicleIn(GRAVITY_RACE, KART, 'kart-oopi');
    const factory = vehicleIn(GRAVITY_FACTORY, KART, 'kart-oopi', { gravityScale: CAR_GRAVITY_SCALE });
    for (const s of [race, factory]) {
      s.run(2);
      s.run(1.5, { ...NO_CONTROLS, throttle: 1, steer: 0.5 });
    }
    expect(factory.car.curPos.y).toBeCloseTo(race.car.curPos.y, 3);
    expect(factory.car.suspensionLength(0)).toBeCloseTo(race.car.suspensionLength(0), 3);
    expect(factory.car.curPos.distanceTo(race.car.curPos)).toBeLessThan(0.05);
    race.world.free();
    factory.world.free();
  });

  it.each([
    ['kart', KART, 'kart-oopi'],
    ['sport', SPORT, 'sedan-sports'],
  ] as const)('%s tops out near the soft speed cap', (_n, spec, model) => {
    const s = vehicleIn(GRAVITY_FACTORY, spec, model, { gravityScale: CAR_GRAVITY_SCALE, speedCap: FACTORY_CAR.SPEED_CAP });
    s.run(0.5);
    s.run(20, { ...NO_CONTROLS, throttle: 1 });
    expect(s.car.speed).toBeGreaterThan(FACTORY_CAR.SPEED_CAP * 0.9);
    expect(s.car.speed).toBeLessThan(FACTORY_CAR.SPEED_CAP * 1.02);
    s.world.free();
  });

  it('the wheel filter lets the wheel rays ignore a collider', () => {
    let slab: RAPIER.Collider | null = null;
    const plain = vehicleIn(GRAVITY_RACE, KART, 'kart-oopi');
    const filtered = vehicleIn(GRAVITY_RACE, KART, 'kart-oopi', { wheelFilter: (c) => c.handle !== slab?.handle });
    // A 20 cm slab under each car (below the chassis box): rested on normally, ignored with the filter.
    plain.world.createCollider(RAPIER.ColliderDesc.cuboid(5, 0.1, 5).setTranslation(0, 0.1, 0));
    slab = filtered.world.createCollider(RAPIER.ColliderDesc.cuboid(5, 0.1, 5).setTranslation(0, 0.1, 0));
    plain.run(2);
    filtered.run(2);
    expect(plain.car.groundY()).toBeCloseTo(0.2, 2);
    expect(filtered.car.groundY()).toBeCloseTo(0, 2);
    expect(filtered.car.wheelsInContact).toBe(4);
    plain.world.free();
    filtered.world.free();
  });
});

// ------------------------------------------------------------------ FactoryCars

describe('FactoryCars: parked cars', () => {
  it('sync parks the placed cars only, reuses unchanged ones, rebuilds on new parts, follows poses, removes gone cars', () => {
    const f = setup();
    f.state.cars.push(carAt('a', KART, { x: 30, y: 0, z: 30, yaw: 0 }), carAt('b', SPORT, { x: 40, y: 0, z: 30, yaw: 1 }), carAt('c', KART, null));
    f.cars.sync();
    expect(carModels(f.scene)).toHaveLength(2);
    const before = carModels(f.scene);
    f.cars.sync();
    expect(carModels(f.scene)).toEqual(before);

    f.car('a').parts.wheels = 'wheel_racing';
    f.cars.sync();
    const after = carModels(f.scene);
    expect(after).toHaveLength(2);
    expect(after.filter((o) => before.includes(o))).toHaveLength(1);

    f.car('b').pose = { x: 60, y: 0, z: 30, yaw: 0 };
    f.cars.sync();
    const b = carModels(f.scene).find((o) => Math.abs(o.position.x - 60) < 1e-6);
    expect(b).toBeDefined();
    f.step();
    expect(f.blocked(new THREE.Vector3(60, 0, 30))).toBe(true);
    expect(f.blocked(new THREE.Vector3(40, 0, 30))).toBe(false);

    f.state.cars = f.state.cars.filter((c) => c.id !== 'a');
    f.cars.sync();
    expect(carModels(f.scene)).toHaveLength(1);
    f.cars.dispose();
    expect(f.scene.children.filter((o) => o.children.length)).toHaveLength(0);
    f.fw.dispose();
  });

  it('sync skips a placed car of a blueprint named after an Object property (kept by the loader)', () => {
    const f = setup();
    f.state.cars.push(carAt('a', KART, { x: 30, y: 0, z: 30, yaw: 0 }));
    for (const [i, blueprint] of ['constructor', '__proto__', 'toString'].entries()) {
      f.state.cars.push({ ...carAt(blueprint, KART, { x: 40 + 10 * i, y: 0, z: 30, yaw: 0 }), blueprint });
    }
    f.cars.sync();
    expect(carModels(f.scene)).toHaveLength(1);
    f.step();
    expect(f.blocked(new THREE.Vector3(40, 0, 30))).toBe(false);
    f.cars.dispose();
    f.fw.dispose();
  });

  it('a parked car is solid for the player and hides its seated driver', () => {
    const f = setup();
    f.state.cars.push(carAt('a', KART, { x: 30, y: 0, z: 30, yaw: 0 }));
    f.cars.sync();
    f.step();
    expect(f.blocked(new THREE.Vector3(30, 0, 30))).toBe(true);
    const driver = carModels(f.scene)[0]!.getObjectByName('character')!;
    expect(driver.visible).toBe(false);
    expect(f.cars.enter('a')).toBe(true);
    expect(driver.visible).toBe(true);
    f.cars.dispose();
    f.fw.dispose();
  });

  it('carNear: closest parked car within reach of its box', () => {
    const f = setup();
    f.state.cars.push(carAt('a', KART, { x: 30, y: 0, z: 30, yaw: 0 }), carAt('b', KART, { x: 36, y: 0, z: 30, yaw: 0 }));
    f.cars.sync();
    expect(f.cars.carNear(new THREE.Vector3(32, 0, 30))).toBe('a');
    expect(f.cars.carNear(new THREE.Vector3(34.5, 0, 30))).toBe('b');
    expect(f.cars.carNear(new THREE.Vector3(30, 0, 36))).toBeNull();
    // Standing inside a box (e.g. a car assembled on top of the player).
    expect(f.cars.carNear(new THREE.Vector3(30, 0, 30), PLAYER_RADIUS)).toBe('a');
    f.cars.enter('a');
    expect(f.cars.carNear(new THREE.Vector3(32, 0, 30))).toBeNull();
    f.cars.dispose();
    f.fw.dispose();
  });

  it('overlapsArea reports the cars under a build footprint', () => {
    const f = setup();
    f.state.cars.push(carAt('a', SPORT, { x: 30, y: 0, z: 30, yaw: 0 }));
    f.cars.sync();
    expect(f.cars.overlapsArea(28, 28, 32, 32)).toBe(true);
    expect(f.cars.overlapsArea(34, 28, 38, 32)).toBe(false);
    f.cars.dispose();
    f.fw.dispose();
  });
});

describe('FactoryCars: driving', () => {
  it('drives out of a garage bay, is capped near 90 km/h, writes its pose, and only exits once slow', () => {
    const f = setup();
    expect(f.state.sim.place('garage', 8, 8, 0, { free: true }).ok).toBe(true);
    f.state.cars.push(carAt('k', KART, null));
    f.state.parkCars();
    const bay = bayPose({ x: 8, z: 8, rot: 0 });
    expect(f.car('k').pose).toEqual(bay);
    f.cars.sync();
    f.step();

    expect(f.cars.enter('k')).toBe(true);
    expect(f.cars.drivingId).toBe('k');
    expect(f.cars.enter('k')).toBe(false);
    f.run(1);
    // At rest in the bay: same place, on the floor.
    expect(Math.hypot(f.car('k').pose!.x - bay.x, f.car('k').pose!.z - bay.z)).toBeLessThan(0.1);
    expect(f.car('k').pose!.y).toBeCloseTo(0, 2);

    // Out through the door (+Z) and on: the walls do not stop it, the speed cap does.
    f.run(8, ['throttle']);
    const pose = f.car('k').pose!;
    expect(pose.z).toBeGreaterThan(bay.z + 60);
    expect(Math.abs(pose.x - bay.x)).toBeLessThan(2);
    expect(f.cars.speedKmh()).toBeGreaterThan(FACTORY_CAR.SPEED_CAP * 3.6 * 0.85);
    expect(f.cars.speedKmh()).toBeLessThan(FACTORY_CAR.SPEED_CAP * 3.6 * 1.03);
    expect(f.camera.fov).toBeGreaterThan(62.5);
    // A save now keeps the live pose.
    const saved = GameState.fromSave(JSON.parse(JSON.stringify(f.state.serialize())));
    const live = vehicleOf(f.cars).curPos;
    expect(Math.abs(saved.cars[0]!.pose!.z - live.z)).toBeLessThan(1);

    expect(f.cars.canExit()).toBe(false);
    expect(f.cars.exit()).toBeNull();
    expect(f.cars.drivingId).toBe('k');

    f.stop();
    expect(f.cars.canExit()).toBe(true);
    const spot = f.cars.exit()!;
    expect(spot).not.toBeNull();
    expect(f.cars.drivingId).toBeNull();
    expect(f.camera.fov).toBe(62);
    const parked = f.car('k').pose!;
    expect(parked.y).toBeCloseTo(0, 2);
    // Player on the car's left, clear of its box, facing the car's heading.
    const local = toLocal(parked, spot.position.x, spot.position.z);
    expect(local.x).toBeGreaterThan(0.5);
    expect(spot.yaw).toBeCloseTo(parked.yaw, 6);
    f.step();
    expect(f.blocked(spot.position)).toBe(false);
    expect(f.blocked(new THREE.Vector3(parked.x, parked.y, parked.z))).toBe(true);
    expect(f.cars.carNear(spot.position)).toBe('k');
    f.cars.dispose();
    f.fw.dispose();
  });

  it('cars cross belt lines on the ground (machines stay solid)', () => {
    const f = setup();
    for (let x = 12; x <= 18; x++) expect(f.state.sim.place('conveyor', x, 30, 1, { free: true }).ok).toBe(true);
    f.state.cars.push(carAt('k', SPORT, { x: 30, y: 0, z: 40, yaw: 0 }));
    f.cars.sync();
    f.cars.enter('k');
    let maxY = -Infinity;
    for (let i = 0; i < 6; i++) {
      f.run(0.5, ['throttle']);
      maxY = Math.max(maxY, vehicleOf(f.cars).curPos.y);
    }
    // The belt spans z 60..62 m: the car drives through it without climbing onto it.
    expect(vehicleOf(f.cars).curPos.z).toBeGreaterThan(62);
    expect(maxY).toBeLessThan(0.4);
    f.cars.dispose();
    f.fw.dispose();
  });

  it('stays inside the map and comes back after a fall or a flip', () => {
    const f = setup();
    f.state.cars.push(carAt('k', KART, { x: 10, y: 0, z: 100, yaw: -Math.PI / 2 }));
    f.cars.sync();
    f.cars.enter('k');
    f.run(1);
    f.run(5, ['throttle']);
    expect(vehicleOf(f.cars).curPos.x).toBeGreaterThan(0);
    f.run(2, ['brake']);

    const v = vehicleOf(f.cars);
    v.body.setTranslation({ x: 50, y: -20, z: 50 }, true);
    f.run(0.1);
    expect(vehicleOf(f.cars).curPos.y).toBeGreaterThan(-1);
    expect(Math.abs(vehicleOf(f.cars).curPos.z - 100)).toBeLessThan(3);

    const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
    vehicleOf(f.cars).body.setRotation({ x: flip.x, y: flip.y, z: flip.z, w: flip.w }, true);
    f.run(VEHICLE.FLIP_RESPAWN_S + 1.5);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(vehicleOf(f.cars).curQuat);
    expect(up.y).toBeGreaterThan(0.9);
    f.cars.dispose();
    f.fw.dispose();
  });
});


describe('FactoryCars: getting out', () => {
  function parkedAndEntered() {
    const f = setup();
    f.state.cars.push(carAt('k', KART, { x: 30, y: 0, z: 100, yaw: 0 }));
    f.cars.sync();
    f.cars.enter('k');
    f.run(1);
    return f;
  }

  it('left first; a car parked there since the last step sends the player to the right', () => {
    const f = parkedAndEntered();
    f.state.cars.push(carAt('n', KART, { x: 32.3, y: 0, z: 100, yaw: 0 }));
    f.cars.sync(); // no world step after this: the new box is not in the query tree yet
    const spot = f.cars.exit()!;
    expect(spot.position.x).toBeLessThan(30 - 0.5);
    expect(Math.abs(spot.position.z - 100)).toBeLessThan(0.5);
    f.cars.dispose();
    f.fw.dispose();
  });

  it('both sides walled: behind; boxed in: on the roof', () => {
    const f = parkedAndEntered();
    // Side walls 12 cm from the box, deep enough to cover the far candidates too.
    f.wall(32.9, 100, 2, 5);
    f.wall(27.1, 100, 2, 5);
    f.run(0.2);
    const pose = f.car('k').pose!;
    const spot = f.cars.exit()!;
    const local = toLocal(pose, spot.position.x, spot.position.z);
    expect(local.z).toBeLessThan(-1);
    expect(Math.abs(local.x)).toBeLessThan(0.3);

    expect(f.cars.enter('k')).toBe(true);
    f.wall(30, 97.5, 0.8, 1.4);
    f.wall(30, 102.7, 0.8, 1.3);
    f.run(0.2);
    const roof = f.cars.exit()!;
    expect(roof.position.y).toBeGreaterThan(0.9);
    expect(distanceToBox(f.car('k').pose!, { minX: -0.5, maxX: 0.5, minY: 0, maxY: 1, minZ: -0.5, maxZ: 0.5 }, roof.position.x, roof.position.z)).toBe(0);
    f.cars.dispose();
    f.fw.dispose();
  });

  it('a reloaded save parks the car where it was left', () => {
    const f = parkedAndEntered();
    f.run(1.5, ['throttle', 'steerLeft']);
    f.stop();
    f.cars.exit();
    const pose = { ...f.car('k').pose! };
    f.cars.dispose();
    f.fw.dispose();

    const g = setup(GameState.fromSave(JSON.parse(JSON.stringify(f.state.serialize()))));
    expect(g.car('k').pose).toEqual(pose);
    const model = carModels(g.scene)[0]!;
    expect(model.position.x).toBeCloseTo(pose.x, 6);
    expect(model.position.z).toBeCloseTo(pose.z, 6);
    g.cars.dispose();
    g.fw.dispose();
  });

  it('dispose after the world was freed only drops the cars', () => {
    const f = parkedAndEntered();
    f.fw.dispose();
    expect(() => f.cars.dispose()).not.toThrow();
  });
});

describe('CarModel preview', () => {
  it('ghost preview: one owned material, shared kit material untouched, freed on dispose', () => {
    const assets = fakeAssets();
    const p = makeCarPreview(assets, KART);
    const mats = new Set<THREE.Material>();
    p.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) mats.add(m.material as THREE.Material);
    });
    expect(mats.size).toBe(1);
    expect(mats.has(kitMaterial)).toBe(false);
    p.model.setGhost(0.2);
    const [ghost] = [...mats];
    expect(ghost!.opacity).toBe(0.2);
    let disposed = false;
    ghost!.addEventListener('dispose', () => (disposed = true));
    const parent = new THREE.Group();
    parent.add(p.root);
    p.dispose();
    expect(disposed).toBe(true);
    expect(p.root.parent).toBeNull();
    expect(kitMaterial.opacity).toBe(1);
    expect(p.root.getObjectByName('character')!.visible).toBe(false);
  });
});


// ------------------------------------------------------------------ on the relief

/** A 64×64-cell factory (128 m) on a relief fixture: corner heights in cm from `f(gi, gj)`, optional water level (cm). */
function reliefState(f: (gi: number, gj: number) => number, water: number | null = null): GameState {
  const W = 64;
  const M = 4;
  const n = W + 2 * M + 1;
  const cm: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) cm.push(Math.round(f(i - M, j - M)));
  return new GameState(new FactorySim({ width: W, height: W, terrain: Terrain.fromHeights(W, W, M, cm, water), hub: null }));
}
/** Rise in cm per 2 m cell of a slope of `deg` degrees. */
const rise = (deg: number) => Math.tan((deg * Math.PI) / 180) * 200;
/** Flat until x = 16 cells, then up along +x at `deg`. */
const rampX = (deg: number) => (gi: number) => Math.max(0, gi - 16) * rise(deg);

describe('FactoryCars on the relief', () => {
  it('a car parked on a 15° slope stands tilted to it and gets in without a jolt', () => {
    const state = reliefState(rampX(15));
    const t = state.sim.terrain;
    const x = 70;
    state.cars = [carAt('s', SPORT, { x, y: t.heightAt(x, 64), z: 64, yaw: Math.PI / 2 })]; // facing +X, up the slope
    const f = setup(state);
    const body = (f.cars as unknown as { entries: Map<string, { body: RAPIER.RigidBody }> }).entries.get('s')!.body;
    expect(upYOfQuat(body.rotation())).toBeCloseTo(Math.cos((15 * Math.PI) / 180), 2);
    expect(f.cars.enter('s')).toBe(true);
    const y0 = vehicleOf(f.cars).curPos.y;
    let worst = 0;
    for (let i = 0; i < 30; i++) {
      f.step();
      worst = Math.max(worst, Math.abs(vehicleOf(f.cars).curPos.y - y0));
    }
    expect(worst).toBeLessThan(0.15);
  });

  it('the hold brake keeps a car still on 20° with no input', () => {
    const state = reliefState(rampX(20));
    const t = state.sim.terrain;
    state.cars = [carAt('s', SPORT, { x: 70, y: t.heightAt(70, 64), z: 64, yaw: 0 })]; // across the slope
    const f = setup(state);
    f.cars.enter('s');
    f.run(0.5);
    const p0 = vehicleOf(f.cars).curPos.clone();
    f.run(3);
    expect(vehicleOf(f.cars).curPos.distanceTo(p0)).toBeLessThan(0.3);
  });

  it('down a 25° slope at full throttle, the speed stays near the cap', () => {
    const state = reliefState(rampX(25));
    const t = state.sim.terrain;
    state.cars = [carAt('s', SPORT, { x: 120, y: t.heightAt(120, 64), z: 64, yaw: -Math.PI / 2 })]; // facing -X, downhill
    const f = setup(state);
    f.cars.enter('s');
    let top = 0;
    for (let i = 0; i < Math.round(3.5 / PHYS_DT); i++) {
      f.held.clear();
      f.held.add('throttle');
      f.step();
      const v = vehicleOf(f.cars);
      if (v.curPos.x > 40) top = Math.max(top, v.body.linvel().x * -1);
    }
    expect(top).toBeGreaterThan(15);
    expect(top).toBeLessThanOrEqual(27);
  });

  it('drives down into a valley 6 m deep without being put back, the camera above the ground', () => {
    // A bowl 6 m deep around (64, 64) m.
    const state = reliefState((gi, gj) => {
      const d = Math.hypot(gi - 32, gj - 32);
      return d < 6 ? -600 : d < 24 ? -600 * (1 - (d - 6) / 18) ** 2 : 0;
    });
    const t = state.sim.terrain;
    state.cars = [carAt('s', SPORT, { x: 64, y: t.heightAt(64, 10), z: 10, yaw: 0 })]; // facing +Z, toward the bowl
    const f = setup(state);
    f.cars.enter('s');
    let lowest = Infinity;
    let worstCam = Infinity;
    for (let i = 0; i < Math.round(5 / PHYS_DT); i++) {
      f.held.clear();
      if (i < 120) f.held.add('throttle');
      f.step();
      if (i % 4 === 0) {
        f.cars.update(PHYS_DT * 4, 1, f.camera);
        const c = f.camera.position;
        worstCam = Math.min(worstCam, c.y - t.heightAt(c.x, c.z));
      }
      lowest = Math.min(lowest, vehicleOf(f.cars).curPos.y);
    }
    expect(lowest).toBeLessThan(-5);
    expect(vehicleOf(f.cars).curPos.y).toBeLessThan(-4);
    expect(worstCam).toBeGreaterThan(0.5);
  });

  it('gets out on a side slope with the feet on the ground', () => {
    const state = reliefState(rampX(14));
    const t = state.sim.terrain;
    state.cars = [carAt('s', SPORT, { x: 70, y: t.heightAt(70, 64), z: 64, yaw: 0 })]; // facing +Z: the slope rises to its right
    const f = setup(state);
    f.cars.enter('s');
    f.run(1);
    const spot = f.cars.exit();
    expect(spot).not.toBeNull();
    expect(Math.abs(spot!.position.y - t.heightAt(spot!.position.x, spot!.position.z))).toBeLessThan(0.15);
  });

  it('a parked car follows the ground down when the pad beside it goes', () => {
    const state = reliefState(rampX(13));
    const t = state.sim.terrain;
    const f = setup(state);
    const r = state.sim.place('garage', 30, 30, 0, { free: true });
    expect(r.ok).toBe(true);
    f.cars.onTerrain(f.fw.flush()!);
    // On the garage's downhill (fill) bank.
    const x = 57.4;
    const z = 64;
    const before = t.heightAt(x, z);
    state.cars = [carAt('s', SPORT, { x, y: before, z, yaw: 0 })];
    f.cars.sync();
    if (r.ok) state.sim.remove(r.building.id);
    f.cars.onTerrain(f.fw.flush()!);
    const after = t.heightAt(x, z);
    expect(before - after).toBeGreaterThan(0.3);
    const body = (f.cars as unknown as { entries: Map<string, { body: RAPIER.RigidBody }> }).entries.get('s')!.body;
    expect(Math.abs(body.translation().y - after)).toBeLessThan(0.15);
    expect(upYOfQuat(body.rotation())).toBeLessThan(0.995); // still tilted to the slope
    expect(f.car('s').pose!.y).toBeCloseTo(body.translation().y, 3);
  });

  it('a car parked under the ground (an old save) stands on it', () => {
    const state = reliefState(rampX(13));
    const t = state.sim.terrain;
    state.cars = [carAt('s', SPORT, { x: 70, y: 0, z: 64, yaw: 0 })];
    const f = setup(state);
    const body = (f.cars as unknown as { entries: Map<string, { body: RAPIER.RigidBody }> }).entries.get('s')!.body;
    expect(t.heightAt(70, 64)).toBeGreaterThan(2);
    expect(Math.abs(body.translation().y - t.heightAt(70, 64))).toBeLessThan(0.15);
  });

  it('no getting out in deep water: the car would drown again on every re-entry', () => {
    // A pond east of x = 34 cells, deepening to 2 m, water level -40 cm: 0.7 m deep at x ≈ 74.6 m.
    const state = reliefState((gi) => (gi > 40 ? -200 : gi > 34 ? -200 * ((gi - 34) / 6) : 0), -40);
    const t = state.sim.terrain;
    const x = 74.6;
    state.cars = [carAt('s', SPORT, { x, y: t.heightAt(x, 64), z: 64, yaw: 0 })];
    const f = setup(state);
    expect(t.waterDepthAt(x, 64)).toBeGreaterThan(FACTORY_CAR.EXIT_WATER);
    f.cars.enter('s');
    f.run(0.8);
    expect(f.cars.exitBlocker()).toBe('water');
    expect(f.cars.exit()).toBeNull();
  });

  it('a dismantle never brings a trunk back inside a parked car', () => {
    const state = new GameState(FactorySim.newGame({ terrain: 'vallonne-1' }));
    const f = setup(state);
    f.fw.blocksDecor = (c) => f.cars.overlaps(c);
    f.fw.flush();
    const world = f.fw as unknown as { decor: { items: { kind: string; x: number; z: number; solid: boolean }[] }; decorColliders: Map<number, RAPIER.Collider> };
    // A tree under a placeable smelter.
    let found: { i: number; cx: number; cz: number } | null = null;
    world.decor.items.forEach((it, i) => {
      if (found || !it.solid || it.kind === 'rock') return;
      const cx = Math.floor(it.x / 2);
      const cz = Math.floor(it.z / 2);
      if (state.sim.check('smelter', cx, cz, 0, { free: true }).ok) found = { i, cx, cz };
    });
    expect(found).not.toBeNull();
    const { i, cx, cz } = found!;
    const trunk = world.decorColliders.get(i)!;
    const it = world.decor.items[i]!;
    const r = state.sim.place('smelter', cx, cz, 0, { free: true });
    expect(trunk.isEnabled()).toBe(false);
    // A car parked where the trunk stood (beside the smelter, say), then the smelter goes.
    state.cars = [carAt('s', SPORT, { x: it.x, y: state.sim.terrain.heightAt(it.x, it.z), z: it.z, yaw: 0 })];
    f.cars.sync();
    if (r.ok) state.sim.remove(r.building.id);
    f.cars.onTerrain(f.fw.flush()!);
    f.fw.flush();
    expect(trunk.isEnabled()).toBe(false);
    // The car leaves: the trunk is back.
    state.cars = [];
    f.cars.sync();
    f.fw.flush();
    expect(trunk.isEnabled()).toBe(true);
  });

  it('in the lake, the water slows the car, then puts it back on dry ground with a message', () => {
    // A pond 2 m deep east of x = 40 cells, water level -40 cm.
    const state = reliefState((gi) => (gi > 40 ? -200 : gi > 34 ? -200 * ((gi - 34) / 6) : 0), -40);
    const t = state.sim.terrain;
    const events: string[] = [];
    state.cars = [carAt('s', SPORT, { x: 50, y: t.heightAt(50, 64), z: 64, yaw: Math.PI / 2 })]; // facing +X, into the pond
    const f = setup(state, events);
    f.cars.enter('s');
    let entered = 0;
    for (let i = 0; i < Math.round(8 / PHYS_DT) && !events.length; i++) {
      f.held.clear();
      f.held.add('throttle');
      f.step();
      const p = vehicleOf(f.cars).curPos;
      if (t.waterDepthAt(p.x, p.z) > 0.5) entered++;
    }
    expect(entered).toBeGreaterThan(0);
    expect(events).toEqual(['water']);
    const p = vehicleOf(f.cars).curPos;
    expect(t.waterDepthAt(p.x, p.z)).toBeLessThan(0.05);
  });
});


// ------------------------------------------------------------------ wear of the driven car

/** The driven car's wear meter (test-only peek at the private state). */
const meterOf = (cars: FactoryCars) => (cars as unknown as { meter: WearMeter | null }).meter!;

describe('FactoryCars: wear while driving', () => {
  it('the drive wears the tires and the engine into state.cars as it goes (whole thousandths), the pause nothing', () => {
    const f = setup();
    f.state.cars.push(carAt('k', KART, { x: 30, y: 0, z: 40, yaw: 0 }));
    f.cars.sync();
    f.cars.enter('k');
    f.run(1);
    expect(f.car('k').wear).toBeUndefined();
    f.run(6, ['throttle']);
    const wear = { ...f.car('k').wear };
    expect(wear.wheels).toBeGreaterThan(0);
    expect(wear.engine).toBeGreaterThan(0);
    expect(Number.isInteger(wear.wheels)).toBe(true);
    expect(wear.chassis).toBeUndefined();
    // A save now keeps it.
    const saved = GameState.fromSave(JSON.parse(JSON.stringify(f.state.serialize())));
    expect(saved.cars[0]!.wear).toEqual(wear);
    // Pause, a panel open (no controls): the car rolls on, nothing wears.
    const exact = meterOf(f.cars).exact('wheels');
    for (let i = 0; i < 180; i++) {
      f.cars.fixedUpdate(PHYS_DT, null);
      f.fw.physics.step(PHYS_DT);
    }
    expect(vehicleOf(f.cars).speed).toBeGreaterThan(5);
    expect(meterOf(f.cars).exact('wheels')).toBe(exact);
    // Getting out rounds the fractions in.
    f.stop();
    const before = meterOf(f.cars).exact('engine');
    f.cars.exit();
    expect(f.car('k').wear!.engine).toBe(Math.round(before));
    f.cars.dispose();
    f.fw.dispose();
  });

  it('a put-back costs its cause: the key, a fall, a flip; nothing while the controls are off', () => {
    const f = setup();
    f.state.cars.push(carAt('s', SPORT, { x: 30, y: 0, z: 100, yaw: 0 }));
    f.cars.sync();
    f.cars.enter('s');
    f.run(1);
    const body = () => [f.car('s').wear?.chassis ?? 0, f.car('s').wear?.panels ?? 0];
    f.cars.resetToLastSafe('key');
    expect(body()).toEqual([WEAR.RESET.key.chassis, WEAR.RESET.key.panels]);
    f.run(0.5);
    vehicleOf(f.cars).body.setTranslation({ x: 50, y: -20, z: 50 }, true);
    f.run(0.1);
    expect(body()).toEqual([WEAR.RESET.key.chassis + WEAR.RESET.fall.chassis, WEAR.RESET.key.panels + WEAR.RESET.fall.panels]);
    f.run(0.5);
    // Dropped on its roof from 2 m.
    const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
    const p = vehicleOf(f.cars).curPos;
    vehicleOf(f.cars).body.setTranslation({ x: p.x, y: p.y + 2, z: p.z }, true);
    vehicleOf(f.cars).body.setRotation({ x: flip.x, y: flip.y, z: flip.z, w: flip.w }, true);
    f.run(VEHICLE.FLIP_RESPAWN_S + 1.5);
    const [chassis, panels] = body();
    // The roof hits the floor too (a shock at most), then the flat cost of the flip.
    expect(chassis).toBeGreaterThanOrEqual(WEAR.RESET.key.chassis + WEAR.RESET.fall.chassis + WEAR.RESET.flip.chassis);
    expect(panels).toBeGreaterThanOrEqual(WEAR.RESET.key.panels + WEAR.RESET.fall.panels + WEAR.RESET.flip.panels);
    expect(meterOf(f.cars).last.cause).toBe('flip');
    // Paused: a fall is put back for free.
    vehicleOf(f.cars).body.setTranslation({ x: 50, y: -20, z: 50 }, true);
    for (let i = 0; i < 6; i++) {
      f.cars.fixedUpdate(PHYS_DT, null);
      f.fw.physics.step(PHYS_DT);
    }
    expect(vehicleOf(f.cars).curPos.y).toBeGreaterThan(-1);
    expect(body()).toEqual([chassis, panels]);
    f.cars.dispose();
    f.fw.dispose();
  });

  it('a machine hit at full speed wears the body; the soft map edge does not', () => {
    const f = setup();
    expect(f.state.sim.place('smelter', 15, 70, 0, { free: true }).ok).toBe(true);
    f.state.cars.push(carAt('s', SPORT, { x: 31, y: 0, z: 70, yaw: 0 }), carAt('k', KART, { x: 10, y: 0, z: 200, yaw: -Math.PI / 2 }));
    f.cars.sync();
    f.cars.enter('s');
    f.run(5, ['throttle']);
    expect(f.car('s').wear!.chassis).toBeGreaterThan(10);
    expect(f.car('s').wear!.panels).toBeGreaterThan(f.car('s').wear!.chassis!);
    expect(meterOf(f.cars).last.cause).toBe('shock');
    f.stop();
    f.cars.exit();
    // Into the west edge at full throttle: held back softly, no shock.
    f.cars.enter('k');
    f.run(1);
    f.run(6, ['throttle']);
    f.run(2, ['brake']);
    expect(vehicleOf(f.cars).curPos.x).toBeGreaterThan(0);
    expect(meterOf(f.cars).exact('chassis')).toBe(0);
    f.cars.dispose();
    f.fw.dispose();
  });

  it('a worn car drives worn from the start; the frame after a shown percentage changes, with its new wear', () => {
    const f = setup();
    f.state.cars.push(carAt('w', KART, { x: 30, y: 0, z: 40, yaw: 0 }), carAt('n', KART, { x: 60, y: 0, z: 40, yaw: 0 }));
    f.car('w').wear = { wheels: 600, engine: 300 };
    f.cars.sync();
    const fresh = tuningFromStats(computeCarStats(KART));
    f.cars.enter('w');
    const t0 = vehicleOf(f.cars).tuning;
    expect(t0).toEqual(wornTuning(fresh, { wheels: 600, engine: 300 }, KART.parts));
    expect(t0.frictionSlip).toBeLessThan(fresh.frictionSlip);
    // A step that adds no whole percent keeps the tuning; driving on wears the tires by a percent: the next frame applies it.
    f.run(0.2);
    expect(vehicleOf(f.cars).tuning).toBe(t0);
    let applied = false;
    for (let i = 0; i < 40 && !applied; i++) {
      f.run(0.5, ['throttle']);
      applied = vehicleOf(f.cars).tuning !== t0;
    }
    expect(applied).toBe(true);
    const w = f.car('w').wear!;
    expect(vehicleOf(f.cars).tuning).toEqual(wornTuning(fresh, w, KART.parts));
    expect(w.wheels).toBeGreaterThan(600);
    f.stop();
    f.cars.exit();
    // A new car: the tuning of a new car, the same object all along, until it gets its first whole percent of wear.
    f.cars.enter('n');
    const n0 = vehicleOf(f.cars).tuning;
    expect(n0).toEqual(fresh);
    f.run(0.5);
    expect(vehicleOf(f.cars).tuning).toBe(n0);
    f.cars.dispose();
    f.fw.dispose();
  });
});

describe('FactoryCars: wear on the relief', () => {
  it('the lake: its drag is no shock, each drowning costs the water put-back', () => {
    const state = reliefState((gi) => (gi > 40 ? -200 : gi > 34 ? -200 * ((gi - 34) / 6) : 0), -40);
    const t = state.sim.terrain;
    const events: string[] = [];
    state.cars = [carAt('s', SPORT, { x: 50, y: t.heightAt(50, 64), z: 64, yaw: Math.PI / 2 })];
    const f = setup(state, events);
    f.cars.enter('s');
    f.run(8, ['throttle']);
    expect(events).toEqual(['water', 'water']);
    const m = meterOf(f.cars);
    expect(m.exact('chassis')).toBe(2 * WEAR.RESET.water.chassis);
    expect(m.exact('panels')).toBe(2 * WEAR.RESET.water.panels);
    expect(m.last.cause).toBe('water');
  });

  it('the ground rising under the driven car (a pad placed) is no shock', () => {
    const state = reliefState(rampX(13));
    const t = state.sim.terrain;
    // On the slope where a garage's pad will rise (see « a parked car follows the ground »).
    const x = 57.4;
    state.cars = [carAt('s', SPORT, { x, y: t.heightAt(x, 64), z: 64, yaw: 0 })];
    const f = setup(state);
    f.cars.enter('s');
    f.run(1);
    const before = meterOf(f.cars).exact('chassis');
    const y0 = vehicleOf(f.cars).curPos.y;
    expect(state.sim.place('garage', 30, 30, 0, { free: true }).ok).toBe(true);
    f.cars.onTerrain(f.fw.flush()!);
    f.run(2);
    expect(vehicleOf(f.cars).curPos.y).toBeGreaterThan(y0 + 0.3);
    expect(meterOf(f.cars).exact('chassis')).toBe(before);
  });

  it('across hills of 21° (the steepest belts) at 90 km/h, crests flown over: slopes and landings are no shocks', () => {
    // Waves 3 m high every 24 m across the way (+X).
    const state = reliefState((gi) => 150 - 150 * Math.cos((gi / 12) * 2 * Math.PI));
    const t = state.sim.terrain;
    state.cars = [carAt('s', SPORT, { x: 8, y: t.heightAt(8, 64), z: 64, yaw: Math.PI / 2 }), carAt('k', KART, { x: 8, y: t.heightAt(8, 40), z: 40, yaw: Math.PI / 2 })];
    const f = setup(state);
    for (const id of ['s', 'k']) {
      f.cars.enter(id);
      let airborne = 0;
      for (let i = 0; i < Math.round(7 / PHYS_DT); i++) {
        f.held.clear();
        f.held.add('throttle');
        f.step();
        if (vehicleOf(f.cars).wheelsInContact === 0) airborne++;
      }
      expect(vehicleOf(f.cars).curPos.x).toBeGreaterThan(70);
      expect(airborne).toBeGreaterThan(30);
      const m = meterOf(f.cars);
      expect(m.exact('chassis') + m.exact('panels')).toBe(0);
      f.stop();
      f.cars.exit();
    }
  });
});
