import type { CarGeometry } from '../../car/geometry';
import type { CarPose } from '../../garage/assembly';
import { CAR_SCALE, GRAVITY_FACTORY, GRAVITY_RACE, PLAYER_RADIUS } from '../../config/constants';

/*
 * Pure math of the cars standing and driving in the factory (no three, no Rapier): boxes, reach,
 * where the player gets out, map limits, poses. FactoryCars does the physics and the rendering.
 */

/** Driving in the factory. */
export const FACTORY_CAR = {
  /** Soft speed cap (m/s, 90 km/h): the factory is no race track. */
  SPEED_CAP: 25,
  /** Max speed (m/s) to get out of the car. */
  EXIT_SPEED: 3,
  /** Reach (m) from the player to a parked car's box for « E : monter ». */
  NEAR_DIST: 3.2,
  /** The car is kept this far (m) inside the map edges. */
  MAP_MARGIN: 2,
  /** Soft wall: max speed (m/s) toward the edge per meter left to it (full speed fades over ~6 m). */
  MAP_PUSH: 4,
  /** Farther than this (m) outside the map: back to the last safe pose. */
  MAP_LOST: 12,
  /** More than this (m) under the ground below it, or 10 m under the lowest ground: fell through, back to the last safe pose. */
  FALL_DEPTH: 4,
  /** Seconds between two safe-pose snapshots. */
  SAFE_INTERVAL: 0.5,
  /** Gap (m) between the car's box and the player's capsule when getting out. */
  EXIT_GAP: 0.25,
  /** Safe poses only this level (up axis ≥ 0.97, about 14°): a reset there never starts in the slope. */
  SAFE_UP: 0.97,
  /** Getting out only this level (up axis ≥ 0.9, about 25°). */
  EXIT_UP: 0.9,
  /** An exit spot's floor at most this far (m) above or below the car's. */
  EXIT_STEP: 1.5,
  /** Water: wet wheels above this depth (m, horizontal drag), drowned below that (back to the last safe pose after DROWN_S). */
  WET_DEPTH: 0.15,
  DROWN_DEPTH: 0.9,
  DROWN_S: 1.5,
  /** Horizontal drag in the water (1/s): about 8 m/s top speed. */
  WATER_DRAG: 1.5,
} as const;

/** Gravity scale of a car body in the factory world: it weighs what it weighs in the race (grip, suspension). */
export const CAR_GRAVITY_SCALE = GRAVITY_RACE / GRAVITY_FACTORY;

/** Car-local box in meters: +X left, +Y up, +Z forward; origin = ground under the middle of the axles. */
export interface CarBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface XZ {
  x: number;
  z: number;
}

/** Whole car (body + wheels, not the kart's driver) in meters, from the model layout. */
export function carBox(g: CarGeometry, scale = CAR_SCALE): CarBox {
  const min = [...g.bodyMin];
  const max = [...g.bodyMax];
  for (const w of g.wheels) {
    const [x, y, z] = w.center;
    // A wheel spans its radius along Y and Z and about half of it across.
    const half = [w.radius / 2, w.radius, w.radius];
    [x, y, z].forEach((c, i) => {
      min[i] = Math.min(min[i]!, c - half[i]!);
      max[i] = Math.max(max[i]!, c + half[i]!);
    });
  }
  return {
    minX: min[0]! * scale,
    maxX: max[0]! * scale,
    minY: Math.max(0, min[1]! * scale),
    maxY: max[1]! * scale,
    minZ: min[2]! * scale,
    maxZ: max[2]! * scale,
  };
}

/** World XZ → car-local XZ (x left, z forward). */
export function toLocal(p: CarPose, x: number, z: number): XZ {
  const dx = x - p.x;
  const dz = z - p.z;
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  return { x: dx * c - dz * s, z: dx * s + dz * c };
}

/** Car-local XZ → world XZ (yaw 0 faces +Z; local +X, the car's left, is world +X). */
export function toWorld(p: CarPose, lx: number, lz: number): XZ {
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  return { x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c };
}

/** Horizontal distance (m) from a world point to the car's box (0 inside it). */
export function distanceToBox(p: CarPose, b: CarBox, x: number, z: number): number {
  const l = toLocal(p, x, z);
  const dx = Math.max(b.minX - l.x, 0, l.x - b.maxX);
  const dz = Math.max(b.minZ - l.z, 0, l.z - b.maxZ);
  return Math.hypot(dx, dz);
}

/** World corners of the car's footprint. */
export function boxCorners(p: CarPose, b: CarBox): XZ[] {
  return [toWorld(p, b.minX, b.minZ), toWorld(p, b.maxX, b.minZ), toWorld(p, b.maxX, b.maxZ), toWorld(p, b.minX, b.maxZ)];
}

/** Does the car's footprint overlap the world rectangle (touching edges do not count)? Separating axes. */
export function boxOverlapsRect(p: CarPose, b: CarBox, minX: number, minZ: number, maxX: number, maxZ: number): boolean {
  const car = boxCorners(p, b);
  const rect: XZ[] = [{ x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }];
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  const axes: XZ[] = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: c, z: -s }, { x: s, z: c }];
  const eps = 1e-6;
  for (const a of axes) {
    const span = (pts: XZ[]) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const q of pts) {
        const d = q.x * a.x + q.z * a.z;
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
      return [lo, hi] as const;
    };
    const [l1, h1] = span(car);
    const [l2, h2] = span(rect);
    if (h1 <= l2 + eps || h2 <= l1 + eps) return false;
  }
  return true;
}

/**
 * Where the player may get out (feet, world XZ), best first: beside the seat on the car's left, on its right,
 * behind, in front; then the same farther away. Each stands `radius + gap` clear of the box.
 */
export function exitCandidates(p: CarPose, b: CarBox, radius = PLAYER_RADIUS, gap = FACTORY_CAR.EXIT_GAP): XZ[] {
  const out: XZ[] = [];
  const midX = (b.minX + b.maxX) / 2;
  // The seat is between the axles (local z = 0), clamped into the box for odd models.
  const seatZ = Math.max(b.minZ, Math.min(b.maxZ, 0));
  for (const far of [0, 1.2]) {
    const off = radius + gap + far;
    out.push(toWorld(p, b.maxX + off, seatZ), toWorld(p, b.minX - off, seatZ), toWorld(p, midX, b.minZ - off), toWorld(p, midX, b.maxZ + off));
  }
  return out;
}

/**
 * Velocity along one axis that keeps a car inside [margin, size - margin] (soft wall): the speed toward an
 * edge may not exceed `push` × the distance left to it, so the car slows down over the last meters
 * (≈ speed / push) and never crosses; past the edge it is pushed back. Unchanged far from the edges.
 */
export function keepInside(pos: number, vel: number, size: number, margin: number = FACTORY_CAR.MAP_MARGIN, push: number = FACTORY_CAR.MAP_PUSH): number {
  const minVel = (margin - pos) * push;
  const maxVel = (size - margin - pos) * push;
  return Math.min(Math.max(vel, minVel), maxVel);
}

/** Inside the map rectangle [0, w] × [0, h] shrunk by `margin` (negative = grown). */
export function insideMap(x: number, z: number, w: number, h: number, margin = 0): boolean {
  return x >= margin && x <= w - margin && z >= margin && z <= h - margin;
}

/** Heading of a rotation (yaw 0 faces +Z): direction of its rotated +Z axis on the ground. */
export function yawOfQuat(q: { x: number; y: number; z: number; w: number }): number {
  return Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
}

/** World up component of a rotation's +Y axis (1 = upright, < 0 = upside-down). */
export function upYOfQuat(q: { x: number; y: number; z: number; w: number }): number {
  return 1 - 2 * (q.x * q.x + q.z * q.z);
}

/** Pose saved for a car standing at `pos` with rotation `q` on a floor at `floorY` (meters). */
export function poseOf(pos: { x: number; z: number }, q: { x: number; y: number; z: number; w: number }, floorY: number): CarPose {
  return { x: pos.x, y: floorY, z: pos.z, yaw: yawOfQuat(q) };
}

/** Same place within `eps` (meters / radians)? */
export function samePose(a: CarPose, b: CarPose, eps = 1e-4): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps && Math.abs(a.yaw - b.yaw) < eps;
}

/** A car's rotation (quaternion) and height on the ground: see terrainFit. */
export interface TerrainFit {
  y: number;
  q: { x: number; y: number; z: number; w: number };
}

/**
 * How a car at `pose` sits on the ground `heightAt`: the plane through the ground under its front, back,
 * left and right (40 % of the box out from its middle) gives its pitch and roll; `y` is that plane under
 * the pose's origin (the ground under the middle of the axles). Pure math (the quaternion is yaw, then
 * pitch, then roll).
 */
export function terrainFit(pose: CarPose, b: CarBox, heightAt: (x: number, z: number) => number, out: TerrainFit = { y: 0, q: { x: 0, y: 0, z: 0, w: 1 } }): TerrainFit {
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const dx = Math.max(0.1, 0.4 * (b.maxX - b.minX));
  const dz = Math.max(0.1, 0.4 * (b.maxZ - b.minZ));
  const at = (lx: number, lz: number) => {
    const w = toWorld(pose, lx, lz);
    return heightAt(w.x, w.z);
  };
  const front = at(cx, cz + dz);
  const back = at(cx, cz - dz);
  const left = at(cx + dx, cz);
  const right = at(cx - dx, cz);
  const sFwd = (front - back) / (2 * dz);
  const sLeft = (left - right) / (2 * dx);
  out.y = (front + back + left + right) / 4 - sFwd * cz - sLeft * cx;
  // q = Ry(yaw) · Rx(−pitch) · Rz(roll): nose up rotates +Z toward +Y, left side up rotates +X toward +Y.
  const yaw = pose.yaw / 2;
  const pitch = -Math.atan(sFwd) / 2;
  const roll = Math.atan(sLeft) / 2;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  // (Ry · Rx) then · Rz.
  const ax = cy * sp;
  const ay = sy * cp;
  const az = -sy * sp;
  const aw = cy * cp;
  out.q.x = ax * cr + ay * sr;
  out.q.y = ay * cr - ax * sr;
  out.q.z = az * cr + aw * sr;
  out.q.w = aw * cr - az * sr;
  return out;
}

/** What CarModel builds from a car (blueprint + installed parts): a different key means a rebuild. */
export function carModelKey(car: { blueprint: string; parts: Partial<Record<string, string>> }): string {
  const slots = Object.keys(car.parts).filter((k) => car.parts[k]).sort();
  return `${car.blueprint}|${slots.map((k) => `${k}=${car.parts[k]}`).join(',')}`;
}
