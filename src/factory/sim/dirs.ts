import type { Side } from '../../data/buildings';

export type Rot = 0 | 1 | 2 | 3;

/** Unit offsets per side: 0 = +Z, 1 = +X, 2 = -Z, 3 = -X. */
export const DX = [0, 1, 0, -1] as const;
export const DZ = [1, 0, -1, 0] as const;

export function opposite(s: Side): Side {
  return ((s + 2) & 3) as Side;
}

export function rotateSide(s: Side, r: Rot): Side {
  return ((s + r) & 3) as Side;
}

/** Local side of a world side for a building with rotation r. */
export function unrotateSide(s: Side, r: Rot): Side {
  return ((s - r + 4) & 3) as Side;
}

/** Footprint size after rotation. */
export function rotatedSize(w: number, h: number, r: Rot): [number, number] {
  return r & 1 ? [h, w] : [w, h];
}

/**
 * Rotates a local footprint cell by r quarter turns (+90° each: +Z -> +X), then
 * re-anchors so the rotated footprint still starts at (0, 0).
 */
export function rotateCell(dx: number, dz: number, r: Rot, w: number, h: number): [number, number] {
  let x = dx;
  let z = dz;
  let cw = w;
  let ch = h;
  for (let i = 0; i < r; i++) {
    // (x, z) -> (z, -x), shifted by (cw - 1) to stay non-negative.
    const nx = z;
    const nz = cw - 1 - x;
    x = nx;
    z = nz;
    const t = cw;
    cw = ch;
    ch = t;
  }
  return [x, z];
}
