export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface GateGeom {
  center: Vec3;
  /** Unit horizontal normal (driving direction). */
  forward: Vec3;
  halfWidth: number;
  height: number;
}

/**
 * Does the segment p0 → p1 (car positions at two consecutive physics steps)
 * cross the gate's vertical rectangle? Returns the crossing fraction t in
 * [0, 1] (for sub-step timing) and the crossing direction, or null.
 * Robust at any speed since it tests the swept segment, not the endpoints.
 */
export function crossGate(p0: Vec3, p1: Vec3, g: GateGeom): { t: number; dir: 1 | -1 } | null {
  const d0 = (p0.x - g.center.x) * g.forward.x + (p0.z - g.center.z) * g.forward.z;
  const d1 = (p1.x - g.center.x) * g.forward.x + (p1.z - g.center.z) * g.forward.z;
  if ((d0 < 0 && d1 < 0) || (d0 > 0 && d1 > 0) || d0 === d1) return null;
  if (d0 === 0 && d1 === 0) return null;
  const t = d0 / (d0 - d1);
  if (t < 0 || t > 1) return null;
  const x = p0.x + (p1.x - p0.x) * t;
  const y = p0.y + (p1.y - p0.y) * t;
  const z = p0.z + (p1.z - p0.z) * t;
  // lateral axis = (-fz, fx)
  const lateral = (x - g.center.x) * -g.forward.z + (z - g.center.z) * g.forward.x;
  if (Math.abs(lateral) > g.halfWidth) return null;
  const dy = y - g.center.y;
  if (dy < -2 || dy > g.height) return null;
  return { t, dir: d1 > d0 ? 1 : -1 };
}
