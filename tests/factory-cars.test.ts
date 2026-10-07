import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { readGlb, worldTriangles, nodeBoxes } from '../scripts/lib/glb.mjs';
import type { AssetLoader } from '../src/core/assets/AssetLoader';
import type { Input } from '../src/core/Input';
import type { Action } from '../src/config/keybinds';
import { GRAVITY_FACTORY, GRAVITY_RACE, PHYS_DT, PLAYER_HEIGHT, PLAYER_RADIUS } from '../src/config/constants';
import { VEHICLE } from '../src/data/vehicle';
import { carGeometryFromBoxes, type CarGeometry } from '../src/car/geometry';
import { computeCarStats, type CarSpec } from '../src/car/stats';
import { tuningFromStats } from '../src/car/tuning';
import { FactoryWorld } from '../src/factory/FactoryWorld';
import { FactoryCars } from '../src/factory/cars/FactoryCars';
import { CAR_GRAVITY_SCALE, FACTORY_CAR, distanceToBox, toLocal } from '../src/factory/cars/carMath';
import { bayPose } from '../src/garage/parking';
import type { CarInstance, CarPose } from '../src/garage/assembly';
import { GameState } from '../src/state/GameState';
import { Vehicle, NO_CONTROLS, type VehicleControls, type VehicleOptions } from '../src/vehicle/Vehicle';
import { makeCarPreview } from '../src/car/CarModel';

beforeAll(async () => {
  await RAPIER.init();
});

// ------------------------------------------------------------------ fake assets (GLB node boxes, no textures)

const KIT = 'public/assets/kenney/car-kit';
const kitMaterial = new THREE.MeshStandardMaterial();

/** The model's node hierarchy with one box mesh per top-level part, like the GLB as far as CarModel cares. */
function modelScene(name: string): THREE.Group {
  const glb = readGlb(`${KIT}/${name}.glb`);
  const boxes = new Map(nodeBoxes(worldTriangles(glb).tris).map((b) => [b.name, b]));
  const nodes = glb.json.nodes as { name: string; children?: number[] }[];
  const build = (i: number): THREE.Object3D => {
    const n = nodes[i]!;
    const b = boxes.get(n.name);
    let o: THREE.Object3D;
    if (b) {
      const size = b.max.map((v, k) => v - b.min[k]!) as [number, number, number];
      const center = b.max.map((v, k) => (v + b.min[k]!) / 2) as [number, number, number];
      o = new THREE.Mesh(new THREE.BoxGeometry(...size).translate(...center), kitMaterial);
    } else o = new THREE.Group();
    o.name = n.name;
    for (const c of n.children ?? []) o.add(build(c));
    return o;
  };
  const scene = new THREE.Group();
  for (const i of glb.json.scenes[glb.json.scene ?? 0].nodes as number[]) scene.add(build(i));
  scene.updateMatrixWorld(true);
  return scene;
}

function fakeAssets(): AssetLoader {
  const scenes = new Map<string, THREE.Group>();
  const scene = (key: string) => {
    let s = scenes.get(key);
    if (!s) scenes.set(key, (s = modelScene(key.split('/')[1]!)));
    return s;
  };
  return {
    instantiate: (key: string) => {
      const o = scene(key).clone(true);
      o.name = key;
      return o;
    },
    info: (key: string) => {
      const bbox = new THREE.Box3().setFromObject(scene(key));
      return { bbox, size: bbox.getSize(new THREE.Vector3()), nodes: new Map() };
    },
  } as unknown as AssetLoader;
}

function geometry(model: string): CarGeometry {
  return carGeometryFromBoxes(nodeBoxes(worldTriangles(readGlb(`${KIT}/${model}.glb`)).tris));
}

// ------------------------------------------------------------------ factory setup

const KART: CarSpec = { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } };
const SPORT: CarSpec = { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' } };

function carAt(id: string, spec: CarSpec, pose: CarPose | null): CarInstance {
  return { id, name: id, blueprint: spec.blueprint, parts: { ...spec.parts } as CarInstance['parts'], pose };
}

function setup(state = new GameState()) {
  const fw = new FactoryWorld(state.sim);
  const scene = new THREE.Scene();
  const isConveyor = (c: RAPIER.Collider) => {
    const id = fw.buildingOf(c);
    return id !== null && state.sim.buildings.get(id)?.type === 'conveyor';
  };
  const cars = new FactoryCars(fakeAssets(), fw.physics, scene, state, { ground: fw.ground, isConveyor });
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

