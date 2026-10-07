/**
 * Deterministic noise for the terrain generator. Only +, −, ×, ÷, Math.floor and integer hashing
 * (Math.imul, shifts, xor): IEEE-754 makes these bit-identical in every JavaScript engine, so every
 * player gets the same map down to the centimeter. No transcendental functions (terrain.test scans this file).
 */

/** Integer lattice hash in [0, 1). */
export function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Quintic fade 6t⁵ − 15t⁴ + 10t³ (zero slope and curvature at 0 and 1). */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Value noise in [−1, 1], one lattice cell per unit. */
export function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const u = fade(x - ix);
  const v = fade(z - iz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

/** Cubic smoothstep of x from e0 to e1, clamped to [0, 1]. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = x <= e0 ? 0 : x >= e1 ? 1 : (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
}
