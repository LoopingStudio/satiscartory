import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Terrain, type Pad, type PadSource } from './terrain';
import { FACTORY_MAP } from '../../data/factoryMap';
import { TERRAIN_RULES as R } from '../../data/factoryTerrain';
import { mulberry32 } from '../../core/rng';

const W = 128;
const H = 128;
const t = Terrain.create('vallonne-1', W, H, FACTORY_MAP.nodes);
const g = { gx: 0, gz: 0, twist: 0 };

function fnv(a: Int32Array): string {
  let h = 0x811c9dc5;
  for (let k = 0; k < a.length; k++) {
    let v = a[k]!;
    for (let b = 0; b < 4; b++) {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193);
      v >>= 8;
    }
  }
  return (h >>> 0).toString(16);
}

/** Every corner of the cell rectangle [x0, x1) × [z0, z1). */
function corners(x0: number, z0: number, x1: number, z1: number): [number, number][] {
  const out: [number, number][] = [];
  for (let j = z0; j <= z1; j++) for (let i = x0; i <= x1; i++) out.push([i, j]);
  return out;
}

const OFF_PLATEAU = (cx: number, cz: number) => (cx + 0.5 - 63.5) ** 2 + (cz + 0.5 - 63.5) ** 2 >= 36 * 36;

describe('vallonne-1 generator', () => {
  it('is pinned (any change to the map is deliberate)', () => {
    expect(t.nx).toBe(161);
    expect(t.nz).toBe(161);
    expect(fnv(t.base)).toBe('211188a0');
  });

  it('uses exact arithmetic only (bit-identical in every engine)', () => {
    for (const f of ['src/factory/sim/terrain.ts', 'src/factory/sim/terrainNoise.ts']) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/Math\.(sin|cos|tan|asin|acos|atan2?|exp|expm1|pow|sqrt|cbrt|log\w*|hypot|random|fround)\b/);
      expect(src, f).not.toMatch(/\*\*/);
    }
  });

  it('keeps the plateau exactly flat where the start and the test layouts stand', () => {
    const zones: [number, number, number, number][] = [
      [62, 62, 65, 65], // hub
      [63, 58, 64, 59], // spawn
      [44, 61, 48, 65], // starting iron node
      [61, 80, 64, 83], // starting rubber node
      [44, 60, 65, 66], // demo chains to the hub's west edge
      [61, 64, 64, 83], // demo rubber chain
      [46, 61, 62, 64], // bigFactory strip
    ];
    for (const [x0, z0, x1, z1] of zones) for (const [i, j] of corners(x0, z0, x1, z1)) expect(t.baseAt(i, j), `${i},${j}`).toBe(0);
  });

  it('flattens every resource node and its surroundings, so a drill fits on each', () => {
    for (const n of FACTORY_MAP.nodes) {
      const level = t.baseAt(n.x, n.z);
      for (const [i, j] of corners(n.x - 2, n.z - 2, n.x + n.w + 2, n.z + n.h + 2)) expect(t.baseAt(i, j), `${n.resource}@${n.x},${n.z} ${i},${j}`).toBe(level);
      const s = t.padStats(n.x, n.z, n.x + 2, n.z + 1);
      expect(s.max - s.min).toBe(0);
      expect(t.isWetCell(n.x, n.z)).toBe(false);
    }
  });

  it('is mostly gentle, with a few steep crests and room to build', () => {
    let n = 0;
    let gentle = 0;
    let noBelt = 0;
    let pad = 0;
    for (let cz = 0; cz < H; cz++) {
      for (let cx = 0; cx < W - 1; cx++) {
        if (!OFF_PLATEAU(cx, cz) || t.isWetCell(cx, cz) || t.isWetCell(cx + 1, cz)) continue;
        n++;
        t.cellGrad(cx, cz, g, true);
        const m = Math.max(Math.abs(g.gx), Math.abs(g.gz));
        if (m <= 42) gentle++;
        if (!t.beltFitsNatural(cx, cz)) noBelt++;
        const m2 = Math.max(Math.abs(t.cellGrad(cx + 1, cz, g, true).gx), Math.abs(g.gz));
        const s = t.padStats(cx, cz, cx + 2, cz + 1);
        const py = t.padRule(cx, cz, cx + 2, cz + 1, []);
        if (m <= R.PAD_GRAD && m2 <= R.PAD_GRAD && s.max - s.min <= R.PAD_RELIEF && s.max - py <= R.PAD_CUT_FILL && py - s.min <= R.PAD_CUT_FILL) pad++;
      }
    }
    expect(gentle / n).toBeGreaterThanOrEqual(0.85);
    expect(noBelt / n).toBeGreaterThanOrEqual(0.02);
    expect(noBelt / n).toBeLessThanOrEqual(0.06);
    expect(pad / n).toBeGreaterThanOrEqual(0.7);
  });

  it('rolls 4 to 8 m: relief over 40 m windows, and stays within -7..10 m in the grid', () => {
    const rel: number[] = [];
    for (let z0 = 0; z0 + 20 <= H; z0 += 5) {
      for (let x0 = 0; x0 + 20 <= W; x0 += 5) {
        if ((x0 + 10 - 63.5) ** 2 + (z0 + 10 - 63.5) ** 2 < 40 * 40) continue;
        let lo = Infinity;
        let hi = -Infinity;
        for (const [i, j] of corners(x0, z0, x0 + 20, z0 + 20)) {
          lo = Math.min(lo, t.baseAt(i, j));
          hi = Math.max(hi, t.baseAt(i, j));
        }
        rel.push((hi - lo) / 100);
      }
    }
    rel.sort((a, b) => a - b);
    const q = (p: number) => rel[Math.floor(p * (rel.length - 1))]!;
    expect(q(0.5)).toBeGreaterThanOrEqual(3);
    expect(q(0.5)).toBeLessThanOrEqual(6);
    expect(q(0.9)).toBeGreaterThanOrEqual(5);
    expect(q(0.9)).toBeLessThanOrEqual(9);
    for (const [i, j] of corners(0, 0, W, H)) {
      expect(t.baseAt(i, j)).toBeGreaterThanOrEqual(-700);
      expect(t.baseAt(i, j)).toBeLessThanOrEqual(1000);
    }
  });

  it('lets a belt line reach the hub from every node', () => {
    const hubAdj = (cx: number, cz: number) => cx >= 61 && cx <= 65 && cz >= 61 && cz <= 65 && !(cx >= 62 && cx <= 64 && cz >= 62 && cz <= 64);
    for (const [k, n] of FACTORY_MAP.nodes.entries()) {
      const dist = new Int32Array(W * H).fill(-1);
      const queue: number[] = [];
      for (let cz = n.z; cz < n.z + n.h; cz++) for (let cx = n.x; cx < n.x + n.w; cx++) {
        dist[cx + cz * W] = 0;
        queue.push(cx + cz * W);
      }
      let found = -1;
      for (let q = 0; q < queue.length && found < 0; q++) {
        const c = queue[q]!;
        const cx = c % W;
        const cz = (c - cx) / W;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const x = cx + dx;
          const z = cz + dz;
          if (x < 0 || z < 0 || x >= W || z >= H || dist[x + z * W]! >= 0 || (x >= 62 && x <= 64 && z >= 62 && z <= 64)) continue;
          if (!t.beltFitsNatural(x, z)) continue;
          dist[x + z * W] = dist[c]! + 1;
          if (hubAdj(x, z)) {
            found = dist[x + z * W]!;
            break;
          }
          queue.push(x + z * W);
        }
      }
      expect(found, `node ${k}`).toBeGreaterThan(0);
      if (k === 0) expect(found).toBeLessThanOrEqual(16);
      if (k === 1) expect(found).toBeLessThanOrEqual(17);
    }
  });

  it('has a lake away from the nodes and from the legacy area', () => {
    const lake = t.lake!;
    expect(lake).not.toBeNull();
    let wet = 0;
    for (let cz = 0; cz < H; cz++) {
      for (let cx = 0; cx < W; cx++) {
        if (!t.isWetCell(cx, cz)) continue;
        wet++;
        expect(cx < 32 || cx > 95 || cz < 32 || cz > 95, `${cx},${cz}`).toBe(true);
        for (const n of FACTORY_MAP.nodes) {
          const d = Math.max(n.x - cx, 0, cx - (n.x + n.w - 1), n.z - cz, 0, cz - (n.z + n.h - 1));
          expect(d, `${cx},${cz}`).toBeGreaterThanOrEqual(6);
        }
      }
    }
    expect(wet).toBeGreaterThanOrEqual(30);
    // The bed is under the level, the water is up to 1.4 m deep.
    const x = lake.x * 2;
    const z = lake.z * 2;
    expect(t.waterDepthAt(x, z)).toBeGreaterThan(1);
    expect(t.waterDepthAt(x, z)).toBeLessThanOrEqual(1.4 + 1e-6);
    expect(t.waterDepthAt(127, 127)).toBe(0);
  });

  it('rises into mountains beyond the grid edge, on every side', () => {
    const side = (out: number) => {
      let lo = Infinity;
      for (let k = 0; k <= 256; k += 4) {
        lo = Math.min(lo, t.farHeight(-out, k), t.farHeight(256 + out, k), t.farHeight(k, -out), t.farHeight(k, 256 + out));
      }
      return lo;
    };
    expect(side(24)).toBeGreaterThanOrEqual(15);
    expect(side(100)).toBeGreaterThanOrEqual(40);
    // No cliff inside the grid: the edge rises no faster than the hills.
    for (let k = 0; k <= W; k++) {
      for (const [a, b] of [[[0, k], [1, k]], [[W, k], [W - 1, k]], [[k, 0], [k, 1]], [[k, H], [k, H - 1]]] as const) {
        expect(Math.abs(t.baseAt(a[0], a[1]) - t.baseAt(b[0], b[1]))).toBeLessThanOrEqual(120);
      }
    }
    // The far heights continue the lattice exactly at its border.
    expect(Math.round(t.farHeight(-32, 100) * 100)).toBe(t.baseAt(-16, 50));
  });
});

describe('samplers', () => {
  it('heightAt is the corner height at corners and the two-triangle rule inside a cell', () => {
    const rng = mulberry32(7);
    for (let k = 0; k < 500; k++) {
      const x = -30 + rng() * 315;
      const z = -30 + rng() * 315;
      const i = Math.floor(x / 2);
      const j = Math.floor(z / 2);
      const u = x / 2 - i;
      const v = z / 2 - j;
      const h00 = t.effAt(i, j);
      const h10 = t.effAt(i + 1, j);
      const h01 = t.effAt(i, j + 1);
      const h11 = t.effAt(i + 1, j + 1);
      const want = u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
      expect(t.heightAt(x, z)).toBeCloseTo(want / 100, 9);
    }
    expect(t.heightAt(20 * 2, 30 * 2)).toBe(t.effAt(20, 30) / 100);
  });

  it('deckPlane meets the mean of each edge at its middle; a straight deck is level across', () => {
    const p = { c: 0, sx: 0, sz: 0 };
    const rng = mulberry32(3);
    for (let k = 0; k < 200; k++) {
      const cx = Math.floor(rng() * W);
      const cz = Math.floor(rng() * H);
      t.deckPlane(cx, cz, null, p);
      const mid = (i0: number, j0: number, i1: number, j1: number) => (t.effAt(i0, j0) + t.effAt(i1, j1)) / 200;
      expect(p.c + p.sx).toBeCloseTo(mid(cx + 1, cz, cx + 1, cz + 1), 9); // +X edge
      expect(p.c - p.sx).toBeCloseTo(mid(cx, cz, cx, cz + 1), 9); // -X edge
      expect(p.c + p.sz).toBeCloseTo(mid(cx, cz + 1, cx + 1, cz + 1), 9); // +Z edge
      expect(p.c - p.sz).toBeCloseTo(mid(cx, cz, cx + 1, cz), 9); // -Z edge
      const flowX = { ...t.deckPlane(cx, cz, 1, p) };
      expect(flowX.sz).toBe(0);
      expect(flowX.c + flowX.sx).toBeCloseTo(mid(cx + 1, cz, cx + 1, cz + 1), 9);
      const flowZ = { ...t.deckPlane(cx, cz, 0, p) };
      expect(flowZ.sx).toBe(0);
      expect(flowZ.c - flowZ.sz).toBeCloseTo(mid(cx, cz, cx + 1, cz), 9);
    }
  });

  it('flat terrain is zero everywhere and every belt fits', () => {
    const f = Terrain.flat(16, 16);
    expect(f.flat).toBe(true);
    expect(f.heightAt(3, 7)).toBe(0);
    expect(f.beltFits(0, 0)).toBe(true);
    expect(f.beltFits(16, 0)).toBe(false);
    expect(f.padRule(0, 0, 2, 1, [30])).toBe(0);
  });
});

/** Pads on a fixture, by cell. */
class Pads implements PadSource {
  readonly list = new Map<number, Pad>();
  constructor(private readonly w: number, private readonly h: number) {}
  padIdAt(cx: number, cz: number): number {
    if (cx < 0 || cz < 0 || cx >= this.w || cz >= this.h) return 0;
    for (const [id, p] of this.list) if (cx >= p.x0 && cx < p.x1 && cz >= p.z0 && cz < p.z1) return id;
    return 0;
  }
  pad(id: number): Pad | undefined {
    return this.list.get(id);
  }
}

/** A 24×24 fixture (margin 2): a ramp of `rise` cm per cell along x. */
function ramp(rise: number, water: number | null = null): Terrain {
  const M = 2;
  const n = 24 + 2 * M + 1;
  const cm: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) cm.push((i - M) * rise);
  return Terrain.fromHeights(24, 24, M, cm, water);
}

describe('effective ground', () => {
  it('levels a pad, banks 75 / 50 / 25 % around it, and gives the ground back on removal', () => {
    const r = ramp(20);
    const pads = new Pads(24, 24);
    const py = r.padRule(10, 10, 12, 11, []);
    expect(py).toBe(220); // corners 200..240, mean 220
    pads.list.set(1, { x0: 10, z0: 10, x1: 12, z1: 11, py });
    r.recomputeAll(pads);
    for (const [i, j] of corners(10, 10, 12, 11)) expect(r.effAt(i, j)).toBe(220);
    // West of the pad the ground is lower (fill), east higher (cut): banks at 1, 2, 3 steps.
    expect(r.effAt(9, 10)).toBe(180 + Math.round((220 - 200) * 0.75));
    expect(r.effAt(8, 10)).toBe(160 + Math.round((220 - 200) * 0.5));
    expect(r.effAt(7, 10)).toBe(140 + Math.round((220 - 200) * 0.25));
    expect(r.effAt(6, 10)).toBe(120);
    expect(r.effAt(13, 10)).toBe(260 + Math.round((220 - 240) * 0.75));
    pads.list.clear();
    r.recomputeAll(pads);
    expect([...r.eff]).toEqual([...r.base]);
  });

  it('takes the lower pad where two pads share corners', () => {
    const r = ramp(30);
    const pads = new Pads(24, 24);
    pads.list.set(1, { x0: 4, z0: 4, x1: 6, z1: 5, py: 150 });
    pads.list.set(2, { x0: 6, z0: 4, x1: 8, z1: 5, py: 210 });
    r.recomputeAll(pads);
    expect(r.effAt(6, 4)).toBe(150);
    expect(r.effAt(5, 4)).toBe(150);
    expect(r.effAt(7, 4)).toBe(210);
  });

  it('snaps to an adjacent pad within 40 cm, nearest first, within the cut and fill limits', () => {
    const r = ramp(20);
    // Corners 200..240: mean 220.
    expect(r.padRule(10, 10, 12, 11, [250])).toBe(250);
    expect(r.padRule(10, 10, 12, 11, [270])).toBe(220); // 50 cm away: no snap
    expect(r.padRule(10, 10, 12, 11, [250, 200])).toBe(200); // 20 cm beats 30 cm
    expect(r.padRule(10, 10, 12, 11, [240, 200])).toBe(240); // tie: the first (lowest id)
    const steep = ramp(60); // corners 600..720, mean 660: 690 fills 90 cm at most
    expect(steep.padRule(10, 10, 12, 11, [690])).toBe(690);
    const steeper = ramp(100); // corners 1000..1200, mean 1100: 1130 would fill 130 cm
    expect(steeper.padRule(10, 10, 12, 11, [1130])).toBe(1100);
  });

  it('recomputing a rectangle after each change equals recomputing everything (fuzz)', () => {
    const r = ramp(25);
    const full = ramp(25);
    const pads = new Pads(24, 24);
    const rng = mulberry32(11);
    let next = 1;
    for (let k = 0; k < 300; k++) {
      const ids = [...pads.list.keys()];
      let rect: Pad;
      if (ids.length && rng() < 0.4) {
        const id = ids[Math.floor(rng() * ids.length)]!;
        rect = pads.list.get(id)!;
        pads.list.delete(id);
      } else {
        const x = Math.floor(rng() * 21);
        const z = Math.floor(rng() * 22);
        const wide = rng() < 0.5;
        const x1 = x + (wide ? 3 : 2);
        const z1 = z + (wide ? 2 : 1);
        let free = true;
        for (let cz = z; cz < z1; cz++) for (let cx = x; cx < x1; cx++) if (pads.padIdAt(cx, cz)) free = false;
        if (!free) continue;
        rect = { x0: x, z0: z, x1, z1, py: r.padRule(x, z, x1, z1, []) };
        pads.list.set(next++, rect);
      }
      r.recompute(rect.x0 - R.BANK_STEPS, rect.z0 - R.BANK_STEPS, rect.x1 + R.BANK_STEPS, rect.z1 + R.BANK_STEPS, pads);
    }
    full.recomputeAll(pads);
    expect([...r.eff]).toEqual([...full.eff]);
  });

  it('never banks into the lake, and lifts legacy pads standing in it', () => {
    const M = 2;
    const n = 24 + 2 * M + 1;
    const cm: number[] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) cm.push(i - M < 8 ? -100 : 50);
    const r = Terrain.fromHeights(24, 24, M, cm, 0);
    expect(r.isWetCell(3, 3)).toBe(true);
    expect(r.isWetCell(12, 3)).toBe(false);
    const pads = new Pads(24, 24);
    pads.list.set(1, { x0: 9, z0: 4, x1: 11, z1: 5, py: -150 });
    pads.list.set(2, { x0: 2, z0: 10, x1: 4, z1: 11, py: -100 });
    r.recomputeAll(pads);
    expect(r.effAt(7, 4)).toBe(-100); // wet corner: no bank
    expect(r.effAt(12, 4)).toBeGreaterThanOrEqual(R.WATER_FILL); // a dry bank stops above the water
    expect(r.effAt(3, 10)).toBe(R.WATER_FILL); // legacy pad in the lake: on fill
  });
});
