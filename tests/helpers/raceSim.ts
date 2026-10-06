import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { readGlb, worldTriangles, nodeBoxes, type Tri } from '../../scripts/lib/glb.mjs';
import { TRACK_PIECES } from '../../src/data/trackPieces';
import { pieceMatrix, trackGates, trackSpawn, centerline } from '../../src/track/layout';
import type { TrackData } from '../../src/track/TrackData';
import { carGeometryFromBoxes } from '../../src/car/geometry';
import { computeCarStats, type CarSpec } from '../../src/car/stats';
import { tuningFromStats } from '../../src/car/tuning';
import { Vehicle, NO_CONTROLS } from '../../src/vehicle/Vehicle';
import { RaceSession } from '../../src/race/RaceSession';
import { crossGate } from '../../src/race/crossing';
import { Bot } from '../../src/race/bot';
import { BLUEPRINTS } from '../../src/data/blueprints';
import { GRAVITY_RACE, PHYS_DT } from '../../src/config/constants';

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
}

/** Drives a full run with the bot, headless. */
export function simulateRun(track: TrackData, spec: CarSpec, opts: { maxSeconds?: number; latAccel?: number; braking?: number } = {}): SimResult {
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
  const session = new RaceSession(cps, PHYS_DT * 1000, 90);
  const bot = new Bot(centerline(track), Math.sqrt((opts.latAccel ?? 32) / 32), opts.braking ?? 14);
  const prev = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  let respawnPoint = spawn;
  let respawns = 0;
  let t = 0;
  while (t < maxSeconds && session.phase !== 'finished') {
    session.step();
    fwd.set(0, 0, 1).applyQuaternion(car.curQuat);
    const controls =
      session.phase === 'running'
        ? bot.controls({ x: car.curPos.x, z: car.curPos.z, heading: Math.atan2(fwd.x, fwd.z), speed: car.speed }, PHYS_DT)
        : NO_CONTROLS;
    prev.copy(car.curPos);
    car.step(PHYS_DT, controls);
    world.step();
    car.afterWorldStep();
    if (session.phase === 'countdown') car.hold();
    if (session.phase === 'running') {
      for (const g of gates) {
        if (g.kind === 'start') continue;
        const hit = crossGate(prev, car.curPos, g);
        if (!hit) continue;
        for (const e of session.cross(g.kind, g.piece, hit.t)) {
          if (e.type === 'checkpoint') {
            const f = g.forward.clone().multiplyScalar(hit.dir);
            respawnPoint = { position: g.center.clone().addScaledVector(f, 3).add(new THREE.Vector3(0, 0.6, 0)), yaw: Math.atan2(f.x, f.z) };
          }
        }
      }
    }
    if (car.curPos.y < -25 || car.flippedTime > 1.6) {
      car.reset(respawnPoint.position, respawnPoint.yaw);
      respawns++;
    }
    t += PHYS_DT;
  }
  world.free();
  return { finished: session.phase === 'finished', ms: session.finishMs, checkpoints: session.passed.size, respawns, simSeconds: +t.toFixed(1) };
}
