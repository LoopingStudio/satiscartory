import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../../core/physics/PhysicsWorld';
import type { AssetLoader } from '../../core/assets/AssetLoader';
import type { Input } from '../../core/Input';
import type { GameState } from '../../state/GameState';
import { specOf, type CarInstance, type CarPose } from '../../garage/assembly';
import { buildLook, type CarBuild } from '../../garage/build';
import { bayPose } from '../../garage/parking';
import type { CarSpec } from '../../car/stats';
import type { Terrain } from '../sim/terrain';
import { BLUEPRINTS, type BlueprintId } from '../../data/blueprints';
import { VEHICLE } from '../../data/vehicle';
import { FACTORY_CELL, PLAYER_HEIGHT, PLAYER_RADIUS } from '../../config/constants';
import { CarModel } from '../../car/CarModel';
import { computeCarStats } from '../../car/stats';
import { tuningFromStats } from '../../car/tuning';
import { CAR_GROUPS } from '../collisionGroups';
import { Vehicle, NO_CONTROLS } from '../../vehicle/Vehicle';
import { ChaseCamera } from '../../vehicle/ChaseCamera';
import { readVehicleControls } from '../../vehicle/VehicleInput';
import {
  CAR_GRAVITY_SCALE, FACTORY_CAR, boxCorners, boxOverlapsRect, carBox, carModelKey, distanceToBox, exitCandidates,
  insideMap, keepInside, poseOf, samePose, terrainFit, toWorld, upYOfQuat, type CarBox, type TerrainFit,
} from './carMath';

/** The ground of the factory as the cars need it (the relief, or a flat floor at 0). */
export interface CarGround {
  /** Ground height (m) under (x, z). */
  heightAt(x: number, z: number): number;
  /** Lowest ground (m). */
  minY: number;
  /** Water over the ground at (x, z) (m, 0 when dry), and the water level (m, null without a lake). */
  waterDepthAt(x: number, z: number): number;
  waterLevel: number | null;
  /** Flat floor: cars park level, nothing else changes. */
  flat: boolean;
}

/** The cars' view of the factory's relief. */
export function carGroundOf(t: Terrain): CarGround {
  return {
    heightAt: (x, z) => t.heightAt(x, z),
    minY: t.minY,
    waterDepthAt: (x, z) => t.waterDepthAt(x, z),
    waterLevel: t.lake ? t.lake.level / 100 : null,
    flat: t.flat,
  };
}

export interface FactoryCarsOptions {
  ground: CarGround;
  /** Conveyor colliders: solid for the chassis, ignored by the wheel rays and by the floor probe. */
  isConveyor(collider: RAPIER.Collider): boolean;
  /** Something happened to the driven car worth a message (it drowned in the lake and was put back). */
  onEvent?(kind: 'water'): void;
  /** Trees and rocks: the chase camera looks through them, exit spots stand on the ground under them. */
  isDecor?(collider: RAPIER.Collider): boolean;
}

/** Where the player gets out: feet position and facing (the car's heading). */
export interface ExitSpot {
  position: THREE.Vector3;
  yaw: number;
}

interface CarEntry {
  /** Car id, or `build:<garage id>` for a car under construction (never driven). */
  id: string;
  build?: true;
  /** carModelKey() of what `model` shows. */
  key: string;
  model: CarModel;
  /** Car-local box of the whole car (parked collider, reach, exit spots). */
  box: CarBox;
  /** Pose the parked body and visual stand at (own copy). */
  placed: CarPose;
  /** Fixed body + box while parked; null while driven. */
  body: RAPIER.RigidBody | null;
  collider: RAPIER.Collider | null;
  /** Dynamic car while driven. */
  vehicle: Vehicle | null;
}

/** Lift (m) of a car body above its floor when it turns dynamic (getting in) and on a reset. */
const ENTER_LIFT = 0.05;
const RESET_LIFT = 0.4;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/**
 * The assembled cars standing in the factory and the one being driven.
 *
 * Parked car (every CarInstance with a pose): CarModel without its seated driver + a FIXED box collider
 * (the player walks around it, the driven car hits it). Driven car: the race Vehicle (same tuning as
 * RaceMode, race gravity through the body's gravity scale, soft speed cap, wheel rays that ignore
 * conveyors and parked cars) followed by a ChaseCamera. Its CarInstance.pose is written every step,
 * so a save may happen at any time.
 *
 * Per fixed step, call fixedUpdate() BEFORE the factory world steps (like CharacterController.step);
 * per frame, call update(). dispose() MUST run before FactoryWorld.dispose() (it frees the WASM world).
 */
export class FactoryCars {
  private readonly entries = new Map<string, CarEntry>();
  /** Handles of the parked cars' colliders. */
  private readonly parkedHandles = new Set<number>();
  private driving: CarEntry | null = null;
  private chase: ChaseCamera | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  /** Camera fov before the chase camera took over (restored after driving). */
  private baseFov: number | null = null;
  private lastSafe: CarPose | null = null;
  private safeTimer = 0;
  /** Seconds the driven car has been under deep water. */
  private drownTime = 0;
  private readonly fit: TerrainFit = { y: 0, q: { x: 0, y: 0, z: 0, w: 1 } };
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly vel = new THREE.Vector3();
  private readonly capsule = new RAPIER.Capsule(PLAYER_HEIGHT / 2 - PLAYER_RADIUS, PLAYER_RADIUS);
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  /** Wheel rays: everything but the conveyors (low walls for the chassis) and the parked cars. */
  private readonly wheelFilter = (c: RAPIER.Collider) => !this.parkedHandles.has(c.handle) && !this.opts.isConveyor(c);

  constructor(
    private readonly assets: AssetLoader,
    private readonly physics: PhysicsWorld,
    private readonly scene: THREE.Scene,
    private readonly state: GameState,
    private readonly opts: FactoryCarsOptions,
  ) {
    this.sync();
  }

  private get world(): RAPIER.World {
    return this.physics.world;
  }

  private carOf(id: string): CarInstance | null {
    return this.state.cars.find((c) => c.id === id) ?? null;
  }

  // ------------------------------------------------------------------ parked cars

  /**
   * Matches the physical cars to state.cars: creates the cars that got a pose, removes the ones that are
   * gone (or lost their pose), rebuilds a car whose blueprint/parts changed (after the drive if it is
   * the driven one) and moves a parked car whose pose changed. Nothing is rebuilt when nothing changed,
   * so it may run every frame. If the driven car disappears, driving stops (check drivingId).
   */
  sync(): void {
    if (this.physics.disposed) return;
    const live = new Set<string>();
    // Cars under construction: their model in the garage's bay, solid like a parked car.
    for (const b of this.state.builds) {
      const g = this.state.sim.buildings.get(b.garage);
      if (g?.type !== 'garage') continue;
      const id = `build:${b.garage}`;
      live.add(id);
      const key = JSON.stringify([b.blueprint, b.parts]);
      const pose = bayPose(g);
      const e = this.entries.get(id);
      if (e && e.key === key && samePose(e.placed, pose)) continue;
      if (e) this.removeEntry(e);
      this.entries.set(id, this.createBuild(b, id, pose, key));
    }
    for (const car of this.state.cars) {
      if (!car.pose || !BLUEPRINTS[car.blueprint as BlueprintId]) continue;
      live.add(car.id);
      const key = carModelKey(car);
      let e = this.entries.get(car.id);
      if (e && !e.vehicle && e.key !== key) {
        this.removeEntry(e);
        e = undefined;
      }
      if (!e) this.entries.set(car.id, this.createParked(car, car.pose, key));
      else if (!e.vehicle && !samePose(e.placed, car.pose)) {
        this.unpark(e);
        this.park(e, car.pose);
      }
    }
    for (const e of [...this.entries.values()]) if (!live.has(e.id)) this.removeEntry(e);
  }

  private createParked(car: CarInstance, pose: CarPose, key: string): CarEntry {
    const model = new CarModel(this.assets, specOf(car));
    this.scene.add(model.root);
    const e: CarEntry = { id: car.id, key, model, box: carBox(model.geometry), placed: { ...pose }, body: null, collider: null, vehicle: null };
    this.park(e, pose);
    return e;
  }

  /** A car under construction: the model of the finished car (installed parts, defaults elsewhere) shown as built so far. */
  private createBuild(b: CarBuild, id: string, pose: CarPose, key: string): CarEntry {
    const parts: CarSpec['parts'] = {};
    for (const [slot, p] of Object.entries(b.parts)) if (p.n > 0) parts[slot] = p.item;
    const model = new CarModel(this.assets, { blueprint: b.blueprint, parts });
    model.setBuildLook(buildLook(b));
    this.scene.add(model.root);
    const e: CarEntry = { id, build: true, key, model, box: carBox(model.geometry), placed: { ...pose }, body: null, collider: null, vehicle: null };
    this.park(e, pose);
    return e;
  }

  /**
   * How a car stands at `pose`: level at its height, or, on the relief when it stands on the ground (not on
   * something else), tilted to the slope at the ground's height. In `this.fit`.
   */
  private standing(pose: CarPose, box: CarBox): TerrainFit {
    const f = this.fit;
    const g = this.opts.ground;
    if (!g.flat) {
      terrainFit(pose, box, (x, z) => g.heightAt(x, z), f);
      if (Math.abs(pose.y - f.y) < 0.3) return f;
    }
    f.y = pose.y;
    const h = pose.yaw / 2;
    f.q.x = 0;
    f.q.y = Math.sin(h);
    f.q.z = 0;
    f.q.w = Math.cos(h);
    return f;
  }

  /** Fixed body + box at `pose` (tilted to the slope it stands on), visual at rest there, seated driver hidden. */
  private park(e: CarEntry, pose: CarPose): void {
    const fit = this.standing(pose, e.box);
    const q = new THREE.Quaternion(fit.q.x, fit.q.y, fit.q.z, fit.q.w);
    const b = e.box;
    e.body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(pose.x, fit.y, pose.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
    );
    e.collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid((b.maxX - b.minX) / 2, (b.maxY - b.minY) / 2, (b.maxZ - b.minZ) / 2)
        .setTranslation((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2)
        .setFriction(0.6),
      e.body,
    );
    this.parkedHandles.add(e.collider.handle);
    e.placed = { ...pose };
    e.model.root.position.set(pose.x, fit.y, pose.z);
    e.model.root.quaternion.copy(q);
    e.model.update(0, 0, 0);
    e.model.setDriver(false);
  }

  private unpark(e: CarEntry): void {
    if (e.collider) this.parkedHandles.delete(e.collider.handle);
    if (e.body) this.world.removeRigidBody(e.body);
    e.body = null;
    e.collider = null;
  }

  private removeEntry(e: CarEntry): void {
    if (this.driving === e) this.stopDriving();
    this.unpark(e);
    e.model.dispose();
    this.entries.delete(e.id);
  }

  /**
   * Closest parked car whose box is within `maxDist` (m, horizontally) of `pos` (the player's feet), for
   * « E : monter ». With maxDist = PLAYER_RADIUS it tells whether the player stands inside a car's box.
   */
  carNear(pos: THREE.Vector3, maxDist: number = FACTORY_CAR.NEAR_DIST, opts: { builds?: boolean } = {}): string | null {
    let best: string | null = null;
    let bestD = maxDist;
    for (const e of this.entries.values()) {
      if (e.vehicle || (e.build && !opts.builds) || Math.abs(pos.y - e.placed.y) > 3) continue;
      const d = distanceToBox(e.placed, e.box, pos.x, pos.z);
      if (d <= bestD) {
        bestD = d;
        best = e.id;
      }
    }
    return best;
  }

  /** Does any car (parked or driven) cover part of this world rectangle (m)? For build placement checks. */
  overlapsArea(minX: number, minZ: number, maxX: number, maxZ: number): boolean {
    return this.carOverlapping(minX, minZ, maxX, maxZ, { builds: true }) !== null;
  }

  /** First car (parked or driven; cars under construction with `builds`) whose body covers part of the rectangle (world meters). */
  carOverlapping(minX: number, minZ: number, maxX: number, maxZ: number, opts: { builds?: boolean } = {}): string | null {
    for (const e of this.entries.values()) {
      if (e.build && !opts.builds) continue;
      const pose = e.vehicle ? poseOf(e.vehicle.curPos, e.vehicle.curQuat, e.placed.y) : e.placed;
      if (boxOverlapsRect(pose, e.box, minX, minZ, maxX, maxZ)) return e.id;
    }
    return null;
  }

  // ------------------------------------------------------------------ driving

  /** Car being driven (null on foot). */
  get drivingId(): string | null {
    return this.driving?.id ?? null;
  }

  /** Interpolated position of the driven car at the last update() (null on foot): light rig, HUD. */
  get drivingPosition(): THREE.Vector3 | null {
    return this.driving ? this.pos : null;
  }

  /** The kart models show their own seated driver while driven; other cars hide the player entirely. */
  drivenHasDriver(): boolean {
    return !!this.driving?.model.hasDriver;
  }

  /**
   * Gets in a parked car: its fixed body becomes the race Vehicle (RaceMode tuning) at the parked pose.
   * False if the car is not parked here or another car is already driven. The chase camera starts at the
   * next update(). The caller hides the avatar and disables the player's collider while driving.
   */
  enter(carId: string): boolean {
    if (this.driving || this.physics.disposed) return false;
    this.sync();
    const e = this.entries.get(carId);
    const car = this.carOf(carId);
    if (!e || !car) return false;
    const p = e.placed;
    this.unpark(e);
    const tuning = tuningFromStats(computeCarStats(specOf(car)));
    // As parked: tilted on a slope (a level spawn there would start inside the hill and jolt).
    const fit = this.standing(p, e.box);
    e.vehicle = new Vehicle(
      this.world,
      e.model.geometry,
      tuning,
      { position: new THREE.Vector3(p.x, fit.y + ENTER_LIFT, p.z), yaw: p.yaw, quat: { ...fit.q } },
      { gravityScale: CAR_GRAVITY_SCALE, speedCap: FACTORY_CAR.SPEED_CAP, wheelFilter: this.wheelFilter, holdBrake: true, slopeSpeedCap: true },
    );
    // The chassis crosses belt lines (see collisionGroups).
    e.vehicle.collider.setCollisionGroups(CAR_GROUPS);
    e.model.setDriver(true);
    this.driving = e;
    this.pos.copy(e.vehicle.curPos);
    this.lastSafe = { ...p };
    this.safeTimer = 0;
    this.drownTime = 0;
    this.chase = null;
    return true;
  }

  /** Slow enough (< FACTORY_CAR.EXIT_SPEED) and level enough to get out. False on foot. */
  canExit(): boolean {
    return this.exitBlocker() === null;
  }

  /** Why the driver cannot get out now: too fast, or the car leans too much (a steep slope); null if they can. */
  exitBlocker(): 'speed' | 'tilt' | 'driving' | null {
    const v = this.driving?.vehicle;
    if (!v) return 'driving';
    const lv = v.body.linvel();
    if (Math.hypot(lv.x, lv.y, lv.z) >= FACTORY_CAR.EXIT_SPEED) return 'speed';
    return upYOfQuat(v.curQuat) < FACTORY_CAR.EXIT_UP ? 'tilt' : null;
  }

  /**
   * Gets out: the car parks where it stands (pose saved, height settled on the floor) and the player gets
   * a free spot beside it (left, else right, behind, in front, farther, else on the roof). Null (nothing
   * changes) when too fast or on foot. `ignore`: the player's own collider, if still enabled.
   */
  exit(ignore?: RAPIER.Collider | null): ExitSpot | null {
    const e = this.driving;
    const v = e?.vehicle;
    if (!e || !v || !this.canExit()) return null;
    v.afterWorldStep();
    const pose = poseOf(v.curPos, v.curQuat, this.floorUnder(v.curPos, v.body, ignore));
    const exclude = new Set<number>([v.collider.handle]);
    if (ignore) exclude.add(ignore.handle);
    const spot = this.spotFor(pose, e.box, exclude);
    const car = this.carOf(e.id);
    if (car) car.pose = { ...pose };
    this.stopDriving();
    this.park(e, pose);
    // Parts changed during the drive: rebuild now that it is parked.
    this.sync();
    return spot;
  }

  /**
   * A free spot for the player beside a car (its current pose when driven), e.g. to move the player out of
   * a car just assembled on top of them. `ignore`: the player's own collider.
   */
  spotBeside(carId: string, ignore?: RAPIER.Collider | null): ExitSpot | null {
    const e = this.entries.get(carId);
    if (!e || this.physics.disposed) return null;
    const pose = e.vehicle ? poseOf(e.vehicle.curPos, e.vehicle.curQuat, e.vehicle.groundY() ?? this.opts.ground.heightAt(e.vehicle.curPos.x, e.vehicle.curPos.z)) : e.placed;
    const exclude = new Set<number>();
    if (e.vehicle) exclude.add(e.vehicle.collider.handle);
    if (ignore) exclude.add(ignore.handle);
    return this.spotFor(pose, e.box, exclude);
  }

  private stopDriving(): void {
    const e = this.driving;
    if (!e) return;
    e.vehicle?.dispose();
    e.vehicle = null;
    this.driving = null;
    this.chase = null;
    this.lastSafe = null;
    this.restoreCamera();
  }

  private restoreCamera(): void {
    if (this.camera && this.baseFov !== null && this.camera.fov !== this.baseFov) {
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }
    this.baseFov = null;
  }

  /** Height of the floor under a point: first hit straight down (not conveyors, cars, `ignore`), else the ground. */
  private floorUnder(p: THREE.Vector3, body: RAPIER.RigidBody | null, ignore?: RAPIER.Collider | null): number {
    this.ray.origin = { x: p.x, y: p.y + 1, z: p.z };
    this.ray.dir = { x: 0, y: -1, z: 0 };
    const hit = this.world.castRay(this.ray, 5, true, undefined, undefined, ignore ?? undefined, body ?? undefined, (c) => !this.parkedHandles.has(c.handle) && !this.opts.isConveyor(c));
    if (hit) return p.y + 1 - hit.timeOfImpact;
    return this.opts.ground.heightAt(p.x, p.z);
  }

  /**
   * First free exit candidate for the player's capsule, each tested on its own floor (on a side slope the
   * uphill and downhill spots stand higher and lower than the car), else the car's roof.
   */
  private spotFor(pose: CarPose, box: CarBox, exclude: Set<number>): ExitSpot {
    const w = this.state.sim.width * FACTORY_CELL;
    const h = this.state.sim.height * FACTORY_CELL;
    for (const c of exitCandidates(pose, box)) {
      if (!insideMap(c.x, c.z, w, h, PLAYER_RADIUS)) continue;
      const floor = this.floorAt(c.x, pose.y + 3, c.z, exclude);
      if (Math.abs(floor - pose.y) > FACTORY_CAR.EXIT_STEP) continue;
      if (this.capsuleFree(c.x, floor + 0.05, c.z, exclude)) return { position: new THREE.Vector3(c.x, floor + 0.02, c.z), yaw: pose.yaw };
    }
    const top = toWorld(pose, (box.minX + box.maxX) / 2, (box.minZ + box.maxZ) / 2);
    const roof = Math.max(pose.y, this.opts.ground.heightAt(top.x, top.z)) + box.maxY + 0.05;
    return { position: new THREE.Vector3(top.x, roof, top.z), yaw: pose.yaw };
  }

  /** Floor under (x, z) from `fromY` down (no cars, no conveyors, nor `exclude`); else the ground. */
  private floorAt(x: number, fromY: number, z: number, exclude: Set<number>): number {
    this.ray.origin = { x, y: fromY, z };
    this.ray.dir = { x: 0, y: -1, z: 0 };
    const hit = this.world.castRay(this.ray, 6, true, undefined, undefined, undefined, undefined, (c) => !exclude.has(c.handle) && !this.parkedHandles.has(c.handle) && !this.opts.isConveyor(c) && !this.opts.isDecor?.(c));
    return hit ? fromY - hit.timeOfImpact : this.opts.ground.heightAt(x, z);
  }

  /** Player capsule standing on `floorY` at (x, z) touches nothing (but `exclude`)? */
  private capsuleFree(x: number, floorY: number, z: number, exclude: Set<number>): boolean {
    const center = { x, y: floorY + PLAYER_HEIGHT / 2 + 0.05, z };
    // Colliders known to the query tree (it is rebuilt by world.step(): buildings, walls, the ground)…
    const hit = this.world.intersectionWithShape(center, IDENTITY, this.capsule, undefined, undefined, undefined, undefined, (c) => !exclude.has(c.handle));
    if (hit) return false;
    // …and the parked boxes tested one by one: one created since the last step is not in the tree yet.
    for (const e of this.entries.values()) {
      if (e.collider && !exclude.has(e.collider.handle) && e.collider.intersectsShape(this.capsule, center, IDENTITY)) return false;
    }
    return true;
  }

  /** Puts the driven car back on its last safe pose (respawn key, falls, flips), tilted to the ground there. */
  resetToLastSafe(): void {
    const e = this.driving;
    const v = e?.vehicle;
    const s = this.lastSafe;
    if (!e || !v || !s) return;
    const fit = this.standing(s, e.box);
    // Lift clear of the ground under every corner of the box.
    let lift = 0;
    if (!this.opts.ground.flat) for (const c of boxCorners(s, e.box)) lift = Math.max(lift, this.opts.ground.heightAt(c.x, c.z) - fit.y);
    v.reset(new THREE.Vector3(s.x, fit.y + Math.min(lift, 1.5) + RESET_LIFT, s.z), s.yaw, { ...fit.q });
    this.safeTimer = 0;
    this.drownTime = 0;
    this.chase?.snap();
  }

  /**
   * The ground changed over [x0, z0, x1, z1] (m): parked cars there stand again on it (refitted, lifted if
   * it rose under them), the driven car is lifted out if the ground now crosses it.
   */
  onTerrain(area: [number, number, number, number]): void {
    if (this.physics.disposed) return;
    const g = this.opts.ground;
    const [x0, z0, x1, z1] = area;
    for (const e of this.entries.values()) {
      if (e.vehicle) continue;
      const p = e.placed;
      if (p.x < x0 - 6 || p.x > x1 + 6 || p.z < z0 - 6 || p.z > z1 + 6) continue;
      const y = Math.max(p.y, g.heightAt(p.x, p.z));
      const pose = { ...p, y };
      this.unpark(e);
      this.park(e, pose);
      const car = this.carOf(e.id);
      if (car?.pose && Math.abs(car.pose.y - y) > 0.01) car.pose.y = y;
    }
    const v = this.driving?.vehicle;
    if (v) {
      const p = v.curPos;
      const under = g.heightAt(p.x, p.z) - p.y;
      if (under > -0.05 && p.x > x0 - 6 && p.x < x1 + 6 && p.z > z0 - 6 && p.z < z1 + 6) {
        v.body.setTranslation({ x: p.x, y: p.y + under + 0.1, z: p.z }, true);
        v.afterWorldStep();
      }
    }
  }

  /**
   * Adds what the cars push aside in the grass to `out` (x, z, radius), up to `max` entries in all: the
   * driven car, then the parked ones nearest to `from`.
   */
  pushers(from: THREE.Vector3, out: { x: number; z: number; r: number }[], max: number): void {
    if (this.driving && out.length < max) out.push({ x: this.pos.x, z: this.pos.z, r: 2.2 });
    const parked: { x: number; z: number; d: number }[] = [];
    for (const e of this.entries.values()) {
      if (e.vehicle) continue;
      parked.push({ x: e.placed.x, z: e.placed.z, d: (e.placed.x - from.x) ** 2 + (e.placed.z - from.z) ** 2 });
    }
    parked.sort((a, b) => a.d - b.d);
    for (const p of parked) {
      if (out.length >= max) break;
      out.push({ x: p.x, z: p.z, r: 2 });
    }
  }

  /** Speed of the driven car (km/h, 0 on foot). */
  speedKmh(): number {
    const v = this.driving?.vehicle;
    return v ? Math.abs(v.speed) * 3.6 : 0;
  }

  /**
   * One fixed step of the driven car; call it every physics step BEFORE the factory world steps
   * (`input` null = no controls: menu, panel, pointer released). Reads the last step's result, puts the
   * car back when it fell or flipped, keeps it in the map, writes its pose, then applies the controls.
   */
  fixedUpdate(dt: number, input: Input | null): void {
    const e = this.driving;
    const v = e?.vehicle;
    if (!e || !v) return;
    v.afterWorldStep();
    const w = this.state.sim.width * FACTORY_CELL;
    const h = this.state.sim.height * FACTORY_CELL;
    const p = v.curPos;
    const g = this.opts.ground;
    // Fell through the ground (or far under the lowest ground).
    const fell = p.y < g.heightAt(p.x, p.z) - FACTORY_CAR.FALL_DEPTH || p.y < g.minY - 10;
    // In the lake: the water slows the car down; deep in it for a while, it is put back on dry ground.
    const level = g.waterLevel;
    const wet = level !== null && g.waterDepthAt(p.x, p.z) > 0 && p.y < level - FACTORY_CAR.WET_DEPTH;
    this.drownTime = wet && p.y < level! - FACTORY_CAR.DROWN_DEPTH ? this.drownTime + dt : 0;
    if (this.drownTime > FACTORY_CAR.DROWN_S) {
      this.resetToLastSafe();
      this.opts.onEvent?.('water');
    } else if (fell || v.flippedTime > VEHICLE.FLIP_RESPAWN_S || !insideMap(p.x, p.z, w, h, -FACTORY_CAR.MAP_LOST)) {
      this.resetToLastSafe();
    } else {
      if (wet) {
        const lv = v.body.linvel();
        const k = Math.exp(-FACTORY_CAR.WATER_DRAG * dt);
        v.body.setLinvel({ x: lv.x * k, y: lv.y, z: lv.z * k }, true);
      }
      const lv = v.body.linvel();
      const vx = keepInside(p.x, lv.x, w);
      const vz = keepInside(p.z, lv.z, h);
      if (vx !== lv.x || vz !== lv.z) v.body.setLinvel({ x: vx, y: lv.y, z: vz }, true);
    }
    this.trackSafe(v, dt, w, h);
    this.writePose(e, v);
    v.step(dt, input ? readVehicleControls(input) : NO_CONTROLS);
  }

  /** Snapshots the pose every SAFE_INTERVAL while the car stands upright on all wheels inside the map. */
  private trackSafe(v: Vehicle, dt: number, w: number, h: number): void {
    this.safeTimer += dt;
    if (this.safeTimer < FACTORY_CAR.SAFE_INTERVAL) return;
    this.safeTimer = 0;
    const ground = v.groundY();
    const p = v.curPos;
    if (ground === null || v.wheelsInContact < v.controller.numWheels() || upYOfQuat(v.curQuat) < FACTORY_CAR.SAFE_UP) return;
    if (!insideMap(p.x, p.z, w, h, FACTORY_CAR.MAP_MARGIN) || this.opts.ground.waterDepthAt(p.x, p.z) > 0.05) return;
    this.lastSafe = poseOf(p, v.curQuat, ground);
  }

  /** Live pose into the CarInstance (height = floor under the wheels, kept while airborne). */
  private writePose(e: CarEntry, v: Vehicle): void {
    const car = this.carOf(e.id);
    if (!car) return;
    const pose = poseOf(v.curPos, v.curQuat, v.groundY() ?? car.pose?.y ?? e.placed.y);
    if (car.pose) Object.assign(car.pose, pose);
    else car.pose = pose;
  }

  // ------------------------------------------------------------------ frame

  /**
   * Per frame: interpolated driven car (wheels steer, spin and suspension) and the chase camera, which
   * occludes against the factory world (garage walls) and owns `camera` while driving. On foot: nothing
   * (the fov was restored on exit).
   */
  update(dt: number, alpha: number, camera: THREE.PerspectiveCamera): void {
    this.camera = camera;
    const e = this.driving;
    const v = e?.vehicle;
    if (!e || !v) return;
    v.afterWorldStep();
    v.interpolate(alpha, this.pos, this.quat);
    e.model.root.position.copy(this.pos);
    e.model.root.quaternion.copy(this.quat);
    const t = v.tuning;
    const susp = e.model.geometry.wheels.map((_, i) => t.suspensionRest - v.suspensionLength(i));
    e.model.update(dt, v.steerAngle, v.speed, susp);
    if (!this.chase) {
      this.baseFov ??= camera.fov;
      const g = this.opts.ground;
      const decor = this.opts.isDecor;
      this.chase = new ChaseCamera(camera, this.world, v.collider, g.flat ? {} : { groundAt: (x, z) => g.heightAt(x, z), filter: decor ? (c) => !decor(c) : undefined });
    }
    const lv = v.body.linvel();
    this.vel.set(lv.x, lv.y, lv.z);
    this.chase.update(dt, this.pos, this.quat, this.vel, Math.min(t.topSpeedMs, FACTORY_CAR.SPEED_CAP));
  }

  /**
   * Removes every car body and model. MUST run before FactoryWorld.dispose() / PhysicsWorld.dispose():
   * the bodies live in that WASM world (after it is freed they are only dropped, never touched).
   */
  dispose(): void {
    const alive = !this.physics.disposed;
    for (const e of this.entries.values()) {
      if (alive) {
        e.vehicle?.dispose();
        if (e.body) this.world.removeRigidBody(e.body);
      }
      e.vehicle = null;
      e.body = null;
      e.collider = null;
      e.model.dispose();
    }
    this.entries.clear();
    this.parkedHandles.clear();
    this.driving = null;
    this.chase = null;
    this.lastSafe = null;
    this.restoreCamera();
  }
}
