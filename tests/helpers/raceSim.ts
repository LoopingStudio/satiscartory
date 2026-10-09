import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { readGlb, worldTriangles, nodeBoxes, type Tri } from '../../scripts/lib/glb.mjs';
import { TRACK_PIECES } from '../../src/data/trackPieces';
import { pieceMatrix, trackGates, trackSpawn, centerline, finishDirections } from '../../src/track/layout';
import type { TrackData } from '../../src/track/TrackData';
import { carGeometryFromBoxes } from '../../src/car/geometry';
import { computeCarStats, type CarSpec } from '../../src/car/stats';
import { tuningFromStats } from '../../src/car/tuning';
import { Vehicle, NO_CONTROLS, type VehicleControls } from '../../src/vehicle/Vehicle';
import { RaceSession } from '../../src/race/RaceSession';
import { crossGate } from '../../src/race/crossing';
import { Bot } from '../../src/race/bot';
import { BLUEPRINTS, type SlotId } from '../../src/data/blueprints';
import { GRAVITY_RACE, PHYS_DT } from '../../src/config/constants';
import type { CarWear, WearCar } from '../../src/data/wear';
import { WearMeter, autoResetCause } from '../../src/car/wearMeter';

const triCache = new Map<string, Tri[]>();
function tris(model: string): Tri[] {
  let t = triCache.get(model);
  if (!t) {
    const [kit, name] = model.split('/');
    t = worldTriangles(readGlb(`public/assets/kenney/${kit}/${name}.glb`)).tris;
    triCache.set(model, t);
  }
  return t;
}

/** Road trimesh of a track, built from the GLB files like TrackBuilder does in the browser. */
export function roadCollider(world: RAPIER.World, track: TrackData): void {
  const verts: number[] = [];
  const v = new THREE.Vector3();
  for (const p of track.pieces) {
    const def = TRACK_PIECES[p.t];
    if (!def) continue;
    const m = pieceMatrix(p);
    const parts: { model: string; rot?: number }[] = [{ model: def.model }, ...(def.extras ?? [])];
    for (const part of parts) {
      const extra = new THREE.Matrix4().makeRotationY((part.rot ?? 0) * (Math.PI / 2));
      const full = m.clone().multiply(extra);
      for (const t of tris(part.model)) for (const q of [t.a, t.b, t.c]) {
        v.set(q[0]!, q[1]!, q[2]!).applyMatrix4(full);
        verts.push(v.x, v.y, v.z);
      }
    }
  }
  if (!verts.length) return;
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(new Float32Array(verts), Uint32Array.from({ length: verts.length / 3 }, (_, i) => i), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(1),
  );
}

export interface SimResult {
  finished: boolean;
  ms: number | null;
  checkpoints: number;
  respawns: number;
  simSeconds: number;
  /** Final pose of the car: position x, y, z then rotation x, y, z, w (exact floats, for the golden test). */
  pose: number[];
  /** Distance driven while racing (km). */
  km: number;
  /** With `meter`: the car's wear at the end (‰, rounded like RaceMode.exit), and before rounding (fractions in). */
  wear?: CarWear;
  wearExact?: Record<SlotId, number>;
}

export interface SimOptions {
  maxSeconds?: number;
  /** Bot cornering (m/s² of lateral grip it assumes) and braking (m/s²). */
  latAccel?: number;
  braking?: number;
  /** Wear of the car at the start (‰ per slot; a new car by default). */
  wear?: CarWear;
  /** Counts the wear like RaceMode (WearMeter while racing, respawns by cause, end at the finish). */
  meter?: boolean;
  /**
   * 'clean' (default): the bot as it is. 'sloppy': the same line, but the handbrake pulled in every tight turn
   * (steering more than half way above 12 m/s) and the throttle kept on through it: a player drifting everywhere.
   */
  driver?: 'clean' | 'sloppy';
}

/** The sloppy driver's controls over the bot's (see SimOptions.driver). */
function sloppy(c: VehicleControls, speed: number): VehicleControls {
  if (Math.abs(c.steer) <= 0.5 || speed <= 12) return c;
  return { ...c, throttle: 1, brake: 0, handbrake: true };
}

/** Drives a full run with the bot, headless. */
export function simulateRun(track: TrackData, spec: CarSpec, opts: SimOptions = {}): SimResult {
  const maxSeconds = opts.maxSeconds ?? 180;
  const world = new RAPIER.World({ x: 0, y: GRAVITY_RACE, z: 0 });
  world.timestep = PHYS_DT;
  roadCollider(world, track);
  const ground = world.createCollider(RAPIER.ColliderDesc.cuboid(4000, 1, 4000).setTranslation(0, -1.02, 0).setFriction(0.8));
  const gates = trackGates(track);
  const spawn = trackSpawn(track, gates);
  const model = BLUEPRINTS[spec.blueprint].model;
  const geo = carGeometryFromBoxes(nodeBoxes(tris(model)));
  const car = new Vehicle(world, geo, tuningFromStats(computeCarStats(spec)), spawn);
  car.offroad = ground;
  const cps = gates.filter((g) => g.kind === 'checkpoint').length;
  const finishDir = finishDirections(track, gates);
  const session = new RaceSession(cps, PHYS_DT * 1000, 90);
  const bot = new Bot(centerline(track), Math.sqrt((opts.latAccel ?? 32) / 32), opts.braking ?? 14);
  const worn: WearCar = { blueprint: spec.blueprint, parts: spec.parts, ...(opts.wear ? { wear: { ...opts.wear } } : {}) };
  const meter = opts.meter ? new WearMeter(worn) : null;
  const prev = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  let respawnPoint = spawn;
  let respawns = 0;
  let km = 0;
  let t = 0;
  while (t < maxSeconds && session.phase !== 'finished') {
    session.step();
    fwd.set(0, 0, 1).applyQuaternion(car.curQuat);
    const running = session.phase === 'running';
    let controls = running ? bot.controls({ x: car.curPos.x, z: car.curPos.z, heading: Math.atan2(fwd.x, fwd.z), speed: car.speed }, PHYS_DT) : NO_CONTROLS;
    if (running && opts.driver === 'sloppy') controls = sloppy(controls, car.speed);
    prev.copy(car.curPos);
    car.step(PHYS_DT, controls);
    if (running) {
      km += (Math.abs(car.speed) * PHYS_DT) / 1000;
      meter?.step(PHYS_DT, car, controls);
    } else meter?.closeShock();
    world.step();
    car.afterWorldStep();
    if (session.phase === 'countdown') car.hold();
    if (session.phase === 'running') {
      for (const g of gates) {
        if (g.kind === 'start') continue;
        const hit = crossGate(prev, car.curPos, g);
        if (!hit) continue;
        const forward = hit.dir === (finishDir.get(g.piece) ?? hit.dir);
        for (const e of session.cross(g.kind, g.piece, hit.t, forward)) {
          if (e.type === 'checkpoint') {
            const f = g.forward.clone().multiplyScalar(hit.dir);
            respawnPoint = { position: g.center.clone().addScaledVector(f, 3).add(new THREE.Vector3(0, 0.6, 0)), yaw: Math.atan2(f.x, f.z) };
          }
        }
      }
    }
    if (car.curPos.y < -25 || car.flippedTime > 1.6) {
      const cause = autoResetCause(car.curPos.y < -25, car.curQuat);
      car.reset(respawnPoint.position, respawnPoint.yaw);
      respawns++;
      if (session.phase === 'running') meter?.putBack(cause);
    }
    t += PHYS_DT;
  }
  const pose = [...car.curPos.toArray(), ...car.curQuat.toArray()];
  world.free();
  const r: SimResult = { finished: session.phase === 'finished', ms: session.finishMs, checkpoints: session.passed.size, respawns, simSeconds: +t.toFixed(1), pose, km };
  if (meter) {
    meter.closeShock();
    r.wearExact = { chassis: meter.exact('chassis'), engine: meter.exact('engine'), wheels: meter.exact('wheels'), panels: meter.exact('panels'), spoiler: meter.exact('spoiler') };
    meter.end();
    r.wear = { ...worn.wear };
  }
  return r;
}
