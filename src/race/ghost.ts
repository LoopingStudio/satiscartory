/*
 * Ghost of a run (pure: no three, no Rapier): the car's pose GHOST_STEP_MS apart from the GO, for a friend to race
 * against (race/challenge.ts). Packed small for a link: positions as centimeter deltas from the previous sample (the
 * first one absolute), rotations as quaternions × QUAT_SCALE, integers only; deflate does the rest (share/codec.ts).
 * A respawn is just a jump between two samples.
 */

/** Sample period: 10 per second (every 6 fixed steps at 60 Hz), interpolated when shown. */
export const GHOST_STEP_MS = 100;
const QUAT_SCALE = 1000;
/** Longest run a ghost keeps: 10 minutes. */
export const GHOST_MAX_SAMPLES = 6000;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}
export interface QuatLike extends Vec3Like {
  w: number;
}

/** A packed ghost, as it travels in a challenge. */
export interface PackedGhost {
  step: number;
  /** x, y, z per sample in cm: the first absolute, then deltas. */
  p: number[];
  /** x, y, z, w per sample, × QUAT_SCALE. */
  q: number[];
}

/** A ghost ready to show: sample k is at k × step ms. */
export interface Ghost {
  step: number;
  count: number;
  pos: Float32Array;
  quat: Float32Array;
}

/** Records a run: push() every fixed step with the session's time; it keeps the poses at multiples of GHOST_STEP_MS. */
export class GhostRecorder {
  private readonly pos: number[] = [];
  private readonly quat: number[] = [];
  private next = 0;

  get count(): number {
    return this.pos.length / 3;
  }

  /** The pose at `timeMs` (ms since the GO); only the first one at or past each multiple of the step is kept. */
  push(timeMs: number, p: Vec3Like, q: QuatLike): void {
    if (!(timeMs >= this.next) || this.count >= GHOST_MAX_SAMPLES || !Number.isFinite(p.x + p.y + p.z + q.x + q.y + q.z + q.w)) return;
    this.pos.push(p.x, p.y, p.z);
    this.quat.push(q.x, q.y, q.z, q.w);
    this.next = this.count * GHOST_STEP_MS;
  }

  reset(): void {
    this.pos.length = 0;
    this.quat.length = 0;
    this.next = 0;
  }

  /** The run so far, packed. */
  pack(): PackedGhost {
    const p: number[] = [];
    let px = 0;
    let py = 0;
    let pz = 0;
    for (let i = 0; i < this.pos.length; i += 3) {
      const x = Math.round(this.pos[i]! * 100);
      const y = Math.round(this.pos[i + 1]! * 100);
      const z = Math.round(this.pos[i + 2]! * 100);
      p.push(x - px, y - py, z - pz);
      px = x;
      py = y;
      pz = z;
    }
    return { step: GHOST_STEP_MS, p, q: this.quat.map((v) => Math.round(v * QUAT_SCALE)) };
  }
}

/** A packed ghost from untrusted data (a friend's code): null when malformed. */
export function unpackGhost(raw: unknown): Ghost | null {
  if (!raw || typeof raw !== 'object') return null;
  const { step, p, q } = raw as Partial<PackedGhost>;
  if (step !== GHOST_STEP_MS || !Array.isArray(p) || !Array.isArray(q)) return null;
  const count = p.length / 3;
  if (!Number.isInteger(count) || count < 1 || count > GHOST_MAX_SAMPLES || q.length !== count * 4) return null;
  if (!p.every(Number.isSafeInteger) || !q.every(Number.isSafeInteger)) return null;
  const pos = new Float32Array(count * 3);
  let x = 0;
  let y = 0;
  let z = 0;
  for (let k = 0; k < count; k++) {
    x += p[k * 3]!;
    y += p[k * 3 + 1]!;
    z += p[k * 3 + 2]!;
    pos.set([x / 100, y / 100, z / 100], k * 3);
  }
  const quat = new Float32Array(count * 4);
  for (let k = 0; k < count; k++) {
    let a = q[k * 4]! / QUAT_SCALE;
    let b = q[k * 4 + 1]! / QUAT_SCALE;
    let c = q[k * 4 + 2]! / QUAT_SCALE;
    let d = q[k * 4 + 3]! / QUAT_SCALE;
    const n = Math.hypot(a, b, c, d) || 1;
    a /= n;
    b /= n;
    c /= n;
    d /= n;
    quat.set([a, b, c, d], k * 4);
  }
  return { step, count, pos, quat };
}

/**
 * The ghost's pose at `timeMs` into `outP` / `outQ` (linear between samples, normalized quaternion lerp along the
 * shorter arc); held at the last sample past the end. False before it has any sample.
 */
export function ghostPoseAt(g: Ghost, timeMs: number, outP: Vec3Like, outQ: QuatLike): boolean {
  if (!g.count) return false;
  const f = Math.max(0, timeMs) / g.step;
  const k = Math.min(g.count - 1, Math.floor(f));
  const k1 = Math.min(g.count - 1, k + 1);
  const t = k1 === k ? 0 : f - k;
  const P = g.pos;
  outP.x = P[k * 3]! + (P[k1 * 3]! - P[k * 3]!) * t;
  outP.y = P[k * 3 + 1]! + (P[k1 * 3 + 1]! - P[k * 3 + 1]!) * t;
  outP.z = P[k * 3 + 2]! + (P[k1 * 3 + 2]! - P[k * 3 + 2]!) * t;
  const Q = g.quat;
  const dot = Q[k * 4]! * Q[k1 * 4]! + Q[k * 4 + 1]! * Q[k1 * 4 + 1]! + Q[k * 4 + 2]! * Q[k1 * 4 + 2]! + Q[k * 4 + 3]! * Q[k1 * 4 + 3]!;
  const s = dot < 0 ? -1 : 1;
  let x = Q[k * 4]! + (s * Q[k1 * 4]! - Q[k * 4]!) * t;
  let y = Q[k * 4 + 1]! + (s * Q[k1 * 4 + 1]! - Q[k * 4 + 1]!) * t;
  let z = Q[k * 4 + 2]! + (s * Q[k1 * 4 + 2]! - Q[k * 4 + 2]!) * t;
  let w = Q[k * 4 + 3]! + (s * Q[k1 * 4 + 3]! - Q[k * 4 + 3]!) * t;
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n;
  y /= n;
  z /= n;
  w /= n;
  outQ.x = x;
  outQ.y = y;
  outQ.z = z;
  outQ.w = w;
  return true;
}
