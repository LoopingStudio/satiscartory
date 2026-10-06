import * as THREE from 'three';
import { LEVEL_H, TRACK_CELL } from '../config/constants';
import { TRACK_PIECES, type GateKind } from '../data/trackPieces';
import { DX, DZ, type Rot } from '../factory/sim/dirs';
import { gateForwardSide, pieceConnectors, pieceSize } from './connectors';
import type { TrackData, TrackPiece } from './TrackData';
import { analyzeTrack } from './validate';

/** Road surface height above the tile base (city-kit-roads tiles are 0.02 tall). */
export const ROAD_SURFACE = 0.02 * TRACK_CELL;

export interface Gate {
  kind: GateKind;
  piece: number;
  center: THREE.Vector3;
  /** Unit horizontal direction a car drives through the gate. */
  forward: THREE.Vector3;
  halfWidth: number;
  height: number;
}

/** World transform of a piece model (model pivot = footprint center, scale = TRACK_CELL). */
export function pieceMatrix(p: TrackPiece, out = new THREE.Matrix4()): THREE.Matrix4 {
  const [rw, rh] = pieceSize(p);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (p.r as Rot) * (Math.PI / 2));
  return out.compose(
    new THREE.Vector3((p.x + rw / 2) * TRACK_CELL, p.y * LEVEL_H, (p.z + rh / 2) * TRACK_CELL),
    q,
    new THREE.Vector3(TRACK_CELL, TRACK_CELL, TRACK_CELL),
  );
}

export function trackGates(track: TrackData): Gate[] {
  const gates: Gate[] = [];
  track.pieces.forEach((p, i) => {
    const kind = TRACK_PIECES[p.t]?.gate;
    if (!kind) return;
    const [rw, rh] = pieceSize(p);
    const side = gateForwardSide(p);
    gates.push({
      kind,
      piece: i,
      center: new THREE.Vector3((p.x + rw / 2) * TRACK_CELL, p.y * LEVEL_H + ROAD_SURFACE, (p.z + rh / 2) * TRACK_CELL),
      forward: new THREE.Vector3(DX[side], 0, DZ[side]),
      halfWidth: TRACK_CELL / 2,
      height: 7,
    });
  });
  return gates;
}

/** Spawn on the start piece, a quarter tile behind its center, facing forward. */
export function trackSpawn(track: TrackData, gates = trackGates(track)): { position: THREE.Vector3; yaw: number } {
  const start = gates.find((g) => g.kind === 'start');
  if (!start) return { position: new THREE.Vector3(0, 2, 0), yaw: 0 };
  return {
    position: start.center.clone().addScaledVector(start.forward, -TRACK_CELL * 0.25).add(new THREE.Vector3(0, 0.6, 0)),
    yaw: Math.atan2(start.forward.x, start.forward.z),
  };
}

/**
 * Road centerline along the validated route: shared edge midpoints between
 * consecutive pieces, plus the arc middle in quarter turns with a speed hint
 * (km/h) — used by the test bot and the automated checks.
 */
export function centerline(track: TrackData): [number, number, number?][] {
  const a = analyzeTrack(track);
  const order = a.path.length > 1 ? a.path : track.pieces.map((_, i) => i);
  const conns = order.map((i) => pieceConnectors(track.pieces[i]!, i));
  const mid = (c: { cx: number; cz: number; side: number }) =>
    [(c.cx + 0.5 + DX[c.side as 0] * 0.5) * TRACK_CELL, (c.cz + 0.5 + DZ[c.side as 0] * 0.5) * TRACK_CELL] as [number, number];
  const pts: [number, number, number?][] = [];
  for (let k = 0; k < order.length; k++) {
    const list = conns[k]!;
    const next = conns[k + 1];
    const prev = conns[k - 1];
    const links = (c: { cx: number; cz: number; side: number }, other: typeof list | undefined) =>
      !!other && other.some((n) => n.cx === c.cx + DX[c.side as 0] && n.cz === c.cz + DZ[c.side as 0]);
    let exit = next ? list.find((c) => links(c, next)) : undefined;
    let entry = prev ? list.find((c) => links(c, prev)) : undefined;
    if (!exit) exit = list.find((c) => c !== entry) ?? list[1];
    if (!entry) entry = list.find((c) => c !== exit) ?? list[0]!;
    if (!exit) continue;
    const E = mid(entry);
    const X = mid(exit);
    if ((entry.side & 1) !== (exit.side & 1)) {
      // Quarter turn: arc center at the inner corner.
      const dInX = entry.side === 1 || entry.side === 3;
      const C: [number, number] = [dInX ? E[0] : X[0], dInX ? X[1] : E[1]];
      const r = Math.hypot(E[0] - C[0], E[1] - C[1]);
      const vx = E[0] - C[0] + X[0] - C[0];
      const vz = E[1] - C[1] + X[1] - C[1];
      const l = Math.hypot(vx, vz) || 1;
      pts.push([C[0] + (vx / l) * r, C[1] + (vz / l) * r, Math.sqrt(32 * r) * 3.6]);
    }
    pts.push([X[0], X[1]]);
  }
  return pts;
}

/**
 * Route direction through each finish gate on the validated path: +1 when the
 * route crosses the gate along its `forward`, -1 when against it.
 */
export function finishDirections(track: TrackData, gates = trackGates(track)): Map<number, 1 | -1> {
  const out = new Map<number, 1 | -1>();
  const a = analyzeTrack(track);
  for (let k = 1; k < a.path.length; k++) {
    const pi = a.path[k]!;
    const gate = gates.find((g) => g.piece === pi && g.kind === 'finish');
    if (!gate) continue;
    const prev = pieceConnectors(track.pieces[a.path[k - 1]!]!, a.path[k - 1]!);
    const entry = pieceConnectors(track.pieces[pi]!, pi).find((c) => prev.some((n) => n.cx === c.cx + DX[c.side] && n.cz === c.cz + DZ[c.side]));
    if (!entry) continue;
    // Travelling inward from the entry edge = opposite of the entry side direction.
    const dot = -DX[entry.side] * gate.forward.x - DZ[entry.side] * gate.forward.z;
    out.set(pi, dot >= 0 ? 1 : -1);
  }
  return out;
}
