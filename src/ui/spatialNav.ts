/** Spatial focus navigation over screen rectangles (pure: the DOM glue in padNav.ts measures them). */

export interface NavRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Dir = 'up' | 'down' | 'left' | 'right';

interface Edges {
  l: number;
  r: number;
  t: number;
  b: number;
}
const edges = (r: NavRect): Edges => ({ l: r.x, r: r.x + r.w, t: r.y, b: r.y + r.h });

/** Layout puts aligned controls a fraction of a pixel apart: closer than this counts as level. */
const EPS = 1;

/** `c` lies in direction `dir` from `s` (its far side is past the source's, its near side not behind). */
function ahead(dir: Dir, s: Edges, c: Edges): boolean {
  switch (dir) {
    case 'left': return (c.r < s.r - EPS || c.r <= s.l + EPS) && c.l < s.l - EPS;
    case 'right': return (c.l > s.l + EPS || c.l >= s.r - EPS) && c.r > s.r + EPS;
    case 'up': return (c.b < s.b - EPS || c.b <= s.t + EPS) && c.t < s.t - EPS;
    case 'down': return (c.t > s.t + EPS || c.t >= s.b - EPS) && c.b > s.b + EPS;
  }
}

/** The two overlap on the cross axis (same row for left/right, same column for up/down). */
function inBeam(dir: Dir, s: Edges, c: Edges): boolean {
  return dir === 'left' || dir === 'right' ? c.b > s.t + EPS && c.t < s.b - EPS : c.r > s.l + EPS && c.l < s.r - EPS;
}

/** Distance along the direction to the candidate's near edge, and to its far edge. */
function major(dir: Dir, s: Edges, c: Edges): number {
  return Math.max(0, dir === 'left' ? s.l - c.r : dir === 'right' ? c.l - s.r : dir === 'up' ? s.t - c.b : c.t - s.b);
}
function majorFar(dir: Dir, s: Edges, c: Edges): number {
  return Math.max(1, dir === 'left' ? s.l - c.l : dir === 'right' ? c.r - s.r : dir === 'up' ? s.t - c.t : c.b - s.b);
}

/** Center offset across the direction. */
function minor(dir: Dir, s: Edges, c: Edges): number {
  return dir === 'left' || dir === 'right' ? Math.abs((s.t + s.b) / 2 - (c.t + c.b) / 2) : Math.abs((s.l + s.r) / 2 - (c.l + c.r) / 2);
}

/** `c` is entirely past the source's edge in direction `dir`. */
function beyond(dir: Dir, s: Edges, c: Edges): boolean {
  switch (dir) {
    case 'left': return c.r <= s.l + EPS;
    case 'right': return c.l >= s.r - EPS;
    case 'up': return c.b <= s.t + EPS;
    case 'down': return c.t >= s.b - EPS;
  }
}

/** `a` wins over `b` by being aligned with the source (left/right: always; up/down: unless `b` is entirely closer). */
function beamBeats(dir: Dir, s: Edges, a: Edges, b: Edges): boolean {
  if (inBeam(dir, s, b) || !inBeam(dir, s, a)) return false;
  // `b` straddles the source's edge (another column's control level with it): the aligned one wins.
  if (!beyond(dir, s, b)) return true;
  if (dir === 'left' || dir === 'right') return true;
  return major(dir, s, a) < majorFar(dir, s, b);
}

/**
 * The best candidate in direction `dir` from `from`, or -1 (Android's FocusFinder rules): among the
 * candidates ahead, one aligned with the source (same row, same column) wins, except going up or down when
 * a misaligned one is entirely closer (a small checkbox on the next row beats the button three rows
 * down); otherwise the distance along the direction counts 13 times more than the offset across it.
 */
export function pickInDirection(from: NavRect, cands: readonly NavRect[], dir: Dir): number {
  const s = edges(from);
  const score = (c: Edges) => 13 * major(dir, s, c) ** 2 + minor(dir, s, c) ** 2;
  let best = -1;
  let bestE: Edges | null = null;
  cands.forEach((r, i) => {
    if (r === from) return;
    const c = edges(r);
    if (!ahead(dir, s, c)) return;
    if (!bestE || beamBeats(dir, s, c, bestE) || (!beamBeats(dir, s, bestE, c) && score(c) < score(bestE))) {
      best = i;
      bestE = c;
    }
  });
  return best;
}

/** Index of the rectangle whose center is closest to (x, y), or -1. */
export function nearestTo(x: number, y: number, cands: readonly NavRect[]): number {
  let best = -1;
  let bestD = Infinity;
  cands.forEach((r, i) => {
    const d = Math.hypot(r.x + r.w / 2 - x, r.y + r.h / 2 - y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Index of the first rectangle in reading order (top to bottom, then left to right), or -1. */
export function firstInReadingOrder(cands: readonly NavRect[]): number {
  let best = -1;
  cands.forEach((r, i) => {
    const b = cands[best];
    // Same row when their vertical spans overlap by half the smaller height.
    if (!b) return void (best = i);
    const overlap = Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y);
    const sameRow = overlap > Math.min(r.h, b.h) / 2;
    if (sameRow ? r.x < b.x : r.y < b.y) best = i;
  });
  return best;
}
