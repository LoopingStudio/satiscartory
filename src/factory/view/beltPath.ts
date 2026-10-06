import type { Side } from '../../data/buildings';
import type { Rot } from '../sim/dirs';

/**
 * Position + heading of an item on a conveyor tile, in local cell units
 * (cell center = origin, edges at ±0.5). The output edge is +Z (side 0).
 * `u` is the normalized path parameter (0 = entry edge, 1 = exit edge); u < 0
 * extrapolates backwards from the entry edge (right after a hand-off).
 */
export function beltLocal(from: Side, u: number, out: { x: number; z: number; yaw: number }): void {
  if (from === 2 || from === 0) {
    out.x = 0;
    out.z = -0.5 + u;
    out.yaw = 0;
    return;
  }
  // Side entry: quarter arc of radius 0.5 around the inner corner.
  const sx = from === 3 ? -1 : 1; // entry from -X (left) or +X (right)
  if (u < 0) {
    out.x = sx * (0.5 - u);
    out.z = 0;
    out.yaw = sx < 0 ? Math.PI / 2 : -Math.PI / 2;
    return;
  }
  const a = (Math.PI / 2) * Math.min(1, u);
  // center (sx*0.5, 0.5); start (sx*0.5, 0) -> end (0, 0.5)
  out.x = sx * 0.5 - sx * 0.5 * Math.sin(a);
  out.z = 0.5 - 0.5 * Math.cos(a);
  // heading: starts pointing toward -sx (inward), ends pointing +Z
  out.yaw = sx < 0 ? Math.PI / 2 - a : -Math.PI / 2 + a;
}

/** Rotates a local offset by r quarter turns (+Z -> +X). */
export function rotateLocal(x: number, z: number, r: Rot, out: { x: number; z: number }): void {
  let a = x;
  let b = z;
  for (let i = 0; i < r; i++) {
    const t = a;
    a = b;
    b = -t;
  }
  out.x = a;
  out.z = b;
}
