import { FACTORY_CELL } from '../../config/constants';
import type { ResourceNode } from '../../data/factoryMap';
import { TERRAINS, TERRAIN_IDS, TERRAIN_RULES, type TerrainDef, type TerrainId } from '../../data/factoryTerrain';
import { smoothstep, valueNoise } from './terrainNoise';

/**
 * Relief of the factory map (pure, deterministic).
 *
 * Heights are integer centimeters on the corners of the 2 m cells, over the grid plus a margin: corner
 * (gi, gj), gi ∈ [−M, W + M], stands at world (2·gi, 2·gj) m. `base` is the natural ground, generated once
 * per map with exact arithmetic only (+ − × ÷, floor, round, integer hashes: bit-identical everywhere).
 * `eff` is the ground as the buildings left it: every padded building (machines, drill, garage, hub)
 * levels the corners of its footprint to its pad height `py`, and the free corners up to BANK_STEPS
 * away blend back to the natural ground (banks). Belts never change the ground; they follow it.
 *
 * A cell is split into two triangles along the diagonal (x1, z0)–(x0, z1), like Rapier's heightfield and
 * three's PlaneGeometry: heightAt matches the physics and the mesh exactly.
 */

const CELL = FACTORY_CELL;
const { BANK_STEPS: K, WATER_FILL } = TERRAIN_RULES;

/** A padded building's footprint as an inclusive corner rectangle, and its pad height (cm). */
export interface Pad {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  py: number;
}

/** Where the padded buildings stand (FactorySim implements it). */
export interface PadSource {
  /** Id of the padded building on cell (cx, cz); 0 if none (empty, belt, out of the grid). */
  padIdAt(cx: number, cz: number): number;
  pad(id: number): Pad | undefined;
}

/** Gradient of a cell in cm per 2 m along x and z, and its twist (distance of its corners from a plane). */
export interface CellGrad {
  gx: number;
  gz: number;
  twist: number;
}

/** A belt deck: height `c` (m) at the cell center and slopes (m per m) along x and z. */
export interface DeckPlane {
  c: number;
  sx: number;
  sz: number;
}

/** The lake, in cells, and its level (cm). */
export interface Lake {
  x: number;
  z: number;
  rx: number;
  rz: number;
  level: number;
}

/** Height (m) of a deck plane of cell (cx, cz) at world (x, z). */
export function deckY(p: DeckPlane, cx: number, cz: number, x: number, z: number): number {
  return p.c + p.sx * (x - (cx + 0.5) * CELL) + p.sz * (z - (cz + 0.5) * CELL);
}

export function isTerrainId(v: unknown): v is TerrainId {
  return typeof v === 'string' && (TERRAIN_IDS as readonly string[]).includes(v);
}

// ------------------------------------------------------------------ generator

/** The height function of a map definition (m, at any point in cell units). */
class Shape {
  private readonly nodeLevels: number[];
  readonly lakeLevel: number | null;

  constructor(
    private readonly def: TerrainDef,
    private readonly W: number,
    private readonly H: number,
    private readonly nodes: readonly ResourceNode[],
  ) {
    const q = def.nodeFlat.roundCm / 100;
    this.nodeLevels = nodes.map((n) => Math.round(this.relief(n.x + n.w / 2, n.z + n.h / 2) / q) * q);
    const l = def.lake;
    this.lakeLevel = l ? Math.round((this.relief(l.x, l.z) - l.below) * 10) / 10 : null;
  }

  /** Hills and crests, faded out over the plateau (exactly 0 on it). */
  private relief(xc: number, zc: number): number {
    const d = this.def;
    const p = d.plateau;
    const dx = xc - p.x;
    const dz = zc - p.z;
    const d2 = dx * dx + dz * dz;
    const f2 = p.flat * p.flat;
    if (d2 <= f2) return 0;
    const xm = xc * CELL;
    const zm = zc * CELL;
    let h = 0;
    for (let k = 0; k < d.hills.length; k++) {
      const o = d.hills[k]!;
      h += o.amp * valueNoise(xm / o.wl, zm / o.wl, d.seed + 101 * (k + 1));
    }
    const c = d.crests;
    const r = 1 - Math.abs(valueNoise(xm / c.wl, zm / c.wl, d.seed + 17));
    const cover = smoothstep(c.cover[0], c.cover[1], (valueNoise(xm / c.coverWl, zm / c.coverWl, d.seed + 29) + 1) / 2);
    h += c.amp * r * r * cover;
    const b2 = p.blend * p.blend;
    return d2 < b2 ? h * smoothstep(f2, b2, d2) : h;
  }

  height(xc: number, zc: number): number {
    const d = this.def;
    let h = this.relief(xc, zc);
    // Resource nodes: flat pads at their center's height, blended back to the relief.
    const nf = d.nodeFlat;
    for (let k = 0; k < this.nodes.length; k++) {
      const n = this.nodes[k]!;
      const cx = Math.max(n.x - nf.margin - xc, 0, xc - (n.x + n.w + nf.margin));
      const cz = Math.max(n.z - nf.margin - zc, 0, zc - (n.z + n.h + nf.margin));
      const c = Math.max(cx, cz);
      if (c < nf.blend) {
        const level = this.nodeLevels[k]!;
        h = level + (h - level) * smoothstep(0, nf.blend, c);
      }
    }
    // Lake: a bowl under the water level, a shore ring just above it, blended back to the relief.
    const l = d.lake;
    if (l && this.lakeLevel !== null) {
      const ex = (xc - l.x) / l.rx;
      const ez = (zc - l.z) / l.rz;
      const dn2 = ex * ex + ez * ez;
      const top = this.lakeLevel + l.shore;
      if (dn2 <= 1) h = this.lakeLevel - l.depth * (1 - dn2);
      else if (dn2 <= SHORE_IN) h = this.lakeLevel + (l.shore * (dn2 - 1)) / (SHORE_IN - 1);
      else if (dn2 < SHORE_OUT) h = top + (h - top) * smoothstep(SHORE_IN, SHORE_OUT, dn2);
    }
    // Mountains beyond the grid: a cliff, then peaks. Exactly 0 inside the grid.
    const m = d.mountains;
    const xm = xc * CELL;
    const zm = zc * CELL;
    const out = Math.max(-xm, 0, xm - this.W * CELL, -zm, zm - this.H * CELL);
    if (out > 0) {
      const wobble = (m.wobble * (valueNoise(xm / m.wobbleWl, zm / m.wobbleWl, d.seed + 43) + 1)) / 2;
      const e = out - wobble;
      if (e > 0) {
        h += m.cliff * Math.min(e, m.cliffWidth);
        if (e > m.cliffWidth) {
          const f = e - m.cliffWidth;
          const peaks = 0.55 + 0.45 * valueNoise(xm / m.peakWl, zm / m.peakWl, d.seed + 53);
          h += (m.height * peaks * f) / (f + m.knee);
        }
        const r = 1 - Math.abs(valueNoise(xm / m.ridgeWl, zm / m.ridgeWl, d.seed + 47));
        h += m.ridgeAmp * r * r * Math.min(1, e / 40);
      }
    }
    return h;
  }
}

/** The lake's bowl ends at dn2 = 1, its shore ring at SHORE_IN (radius × 1.6), its blend at SHORE_OUT (× 2.4). */
const SHORE_IN = 2.56;
const SHORE_OUT = 5.8;
/** Corners within the lake ellipse × 1.05 below level + 20 cm are wet. */
const WET_DN2 = 1.1025;
const WET_ABOVE = 20;

interface Generated {
  base: Int32Array;
  wet: Uint8Array;
  lake: Lake | null;
  shape: Shape;
}

const generated = new Map<string, Generated>();

function generate(id: Exclude<TerrainId, 'flat'>, W: number, H: number, nodes: readonly ResourceNode[]): Generated {
  const key = `${id}|${W}|${H}|${nodes.map((n) => `${n.resource}${n.x},${n.z},${n.w},${n.h}`).join(';')}`;
  const hit = generated.get(key);
  if (hit) return hit;
  const def = TERRAINS[id];
  const M = def.margin;
  const nx = W + 2 * M + 1;
  const nz = H + 2 * M + 1;
  const shape = new Shape(def, W, H, nodes);
  const base = new Int32Array(nx * nz);
  const wet = new Uint8Array(nx * nz);
  const l = def.lake;
  const level = shape.lakeLevel === null ? null : Math.round(shape.lakeLevel * 100);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const gi = i - M;
      const gj = j - M;
      const v = i + j * nx;
      base[v] = Math.round(shape.height(gi, gj) * 100);
      if (l && level !== null) {
        const ex = (gi - l.x) / l.rx;
        const ez = (gj - l.z) / l.rz;
        if (ex * ex + ez * ez <= WET_DN2 && base[v]! < level + WET_ABOVE) wet[v] = 1;
      }
    }
  }
  const g: Generated = { base, wet, lake: l && level !== null ? { x: l.x, z: l.z, rx: l.rx, rz: l.rz, level } : null, shape };
  generated.set(key, g);
  return g;
}

// ------------------------------------------------------------------ terrain

export class Terrain {
  readonly width: number;
  readonly height: number;
  /** Lattice margin around the grid, in cells. */
  readonly margin: number;
  /** Lattice size in corners. */
  readonly nx: number;
  readonly nz: number;
  /** Natural ground (cm), shared between sims of the same map: never write it. */
  readonly base: Int32Array;
  /** Ground as the padded buildings left it (cm), this sim's own copy. */
  readonly eff: Int32Array;
  /** Corners under water (shared). */
  readonly wet: Uint8Array;
  /** Grid cells with a wet corner. */
  readonly cellWet: Uint8Array;
  readonly lake: Lake | null;
  /** Lowest and highest natural ground (m). */
  readonly minY: number;
  readonly maxY: number;
  private readonly shape: Shape | null;
  /** Scratch for the pads near a corner (no allocation per corner). */
  private readonly seen = new Int32Array(64);

  private constructor(
    readonly id: TerrainId,
    width: number,
    height: number,
    margin: number,
    base: Int32Array,
    wet: Uint8Array,
    lake: Lake | null,
    shape: Shape | null,
  ) {
    this.width = width;
    this.height = height;
    this.margin = margin;
    this.nx = width + 2 * margin + 1;
    this.nz = height + 2 * margin + 1;
    this.base = base;
    this.eff = base.slice();
    this.wet = wet;
    this.lake = lake;
    this.shape = shape;
    this.cellWet = new Uint8Array(width * height);
    for (let cz = 0; cz < height; cz++) {
      for (let cx = 0; cx < width; cx++) {
        const v = this.vi(cx, cz);
        if (wet[v] || wet[v + 1] || wet[v + this.nx] || wet[v + this.nx + 1]) this.cellWet[cx + cz * width] = 1;
      }
    }
    let min = 0;
    let max = 0;
    for (let k = 0; k < base.length; k++) {
      const h = base[k]!;
      if (h < min) min = h;
      if (h > max) max = h;
    }
    this.minY = min / 100;
    this.maxY = max / 100;
  }

  /** Perfectly flat ground (unit tests, the stress layout): every rule passes, pads are at 0. */
  get flat(): boolean {
    return this.id === 'flat';
  }

  /** A generated map (not flat, not a test fixture): it has scenery (trees, rocks) and far mountains. */
  get generated(): boolean {
    return this.shape !== null;
  }

  static create(id: TerrainId, width: number, height: number, nodes: readonly ResourceNode[] = []): Terrain {
    if (id === 'flat') return Terrain.flat(width, height);
    const g = generate(id, width, height, nodes);
    return new Terrain(id, width, height, TERRAINS[id].margin, g.base, g.wet, g.lake, g.shape);
  }

  static flat(width: number, height: number): Terrain {
    const n = (width + 1) * (height + 1);
    return new Terrain('flat', width, height, 0, new Int32Array(n), new Uint8Array(n), null, null);
  }

  /**
   * Test fixture: natural ground given corner by corner (cm, row-major over the lattice with margin
   * `margin`). With a water level, corners below level + 20 cm are wet.
   */
  static fromHeights(width: number, height: number, margin: number, cm: ArrayLike<number>, water: number | null = null): Terrain {
    const nx = width + 2 * margin + 1;
    const nz = height + 2 * margin + 1;
    if (cm.length !== nx * nz) throw new Error(`fromHeights: ${cm.length} heights, expected ${nx * nz}`);
    const base = Int32Array.from(cm, (h) => Math.round(h));
    const wet = new Uint8Array(nx * nz);
    if (water !== null) for (let k = 0; k < base.length; k++) if (base[k]! < water + WET_ABOVE) wet[k] = 1;
    const lake = water === null ? null : { x: width / 2, z: height / 2, rx: width, rz: height, level: water };
    // 'vallonne-1' only names the fixture as non-flat; its shape (far heights) is the lattice border.
    return new Terrain('vallonne-1', width, height, margin, base, wet, lake, null);
  }

  // ---------------------------------------------------------------- lattice

  /** Lattice index of corner (gi, gj), which must lie in the lattice. */
  vi(gi: number, gj: number): number {
    return gi + this.margin + (gj + this.margin) * this.nx;
  }

  inLattice(gi: number, gj: number): boolean {
    return gi >= -this.margin && gj >= -this.margin && gi <= this.width + this.margin && gj <= this.height + this.margin;
  }

  private clampI(gi: number): number {
    return gi < -this.margin ? -this.margin : gi > this.width + this.margin ? this.width + this.margin : gi;
  }

  private clampJ(gj: number): number {
    return gj < -this.margin ? -this.margin : gj > this.height + this.margin ? this.height + this.margin : gj;
  }

  /** Natural ground at a corner (cm), clamped to the lattice. */
  baseAt(gi: number, gj: number): number {
    return this.base[this.vi(this.clampI(gi), this.clampJ(gj))]!;
  }

  /** Effective ground at a corner (cm), clamped to the lattice. */
  effAt(gi: number, gj: number): number {
    return this.eff[this.vi(this.clampI(gi), this.clampJ(gj))]!;
  }

  isWet(gi: number, gj: number): boolean {
    return this.inLattice(gi, gj) && this.wet[this.vi(gi, gj)] === 1;
  }

  /** A grid cell with a corner under water. Out of the grid: false. */
  isWetCell(cx: number, cz: number): boolean {
    return cx >= 0 && cz >= 0 && cx < this.width && cz < this.height && this.cellWet[cx + cz * this.width] === 1;
  }

  // ---------------------------------------------------------------- samplers (O(1), no allocation)

  /** Effective ground height (m) at world (x, z), on the two triangles of its cell; clamped to the lattice. */
  heightAt(x: number, z: number): number {
    if (this.flat) return 0;
    const M = this.margin;
    let fx = x / CELL + M;
    let fz = z / CELL + M;
    const maxX = this.nx - 1;
    const maxZ = this.nz - 1;
    fx = fx < 0 ? 0 : fx > maxX ? maxX : fx;
    fz = fz < 0 ? 0 : fz > maxZ ? maxZ : fz;
    let i = Math.floor(fx);
    let j = Math.floor(fz);
    if (i >= maxX) i = maxX - 1;
    if (j >= maxZ) j = maxZ - 1;
    const u = fx - i;
    const v = fz - j;
    const e = this.eff;
    const k = i + j * this.nx;
    const h00 = e[k]!;
    const h10 = e[k + 1]!;
    const h01 = e[k + this.nx]!;
    const h11 = e[k + this.nx + 1]!;
    const h = u + v <= 1 ? h00 + u * (h10 - h00) + v * (h01 - h00) : h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
    return h / 100;
  }

  /** Slope of the effective ground at (x, z): dh/dx and dh/dz (m per m) of its triangle. */
  slopeAt(x: number, z: number, out: { x: number; z: number }): { x: number; z: number } {
    if (this.flat) {
      out.x = 0;
      out.z = 0;
      return out;
    }
    const M = this.margin;
    const maxX = this.nx - 1;
    const maxZ = this.nz - 1;
    let fx = x / CELL + M;
    let fz = z / CELL + M;
    fx = fx < 0 ? 0 : fx > maxX ? maxX : fx;
    fz = fz < 0 ? 0 : fz > maxZ ? maxZ : fz;
    let i = Math.floor(fx);
    let j = Math.floor(fz);
    if (i >= maxX) i = maxX - 1;
    if (j >= maxZ) j = maxZ - 1;
    const e = this.eff;
    const k = i + j * this.nx;
    const h00 = e[k]!;
    const h10 = e[k + 1]!;
    const h01 = e[k + this.nx]!;
    const h11 = e[k + this.nx + 1]!;
    if (fx - i + (fz - j) <= 1) {
      out.x = (h10 - h00) / (100 * CELL);
      out.z = (h01 - h00) / (100 * CELL);
    } else {
      out.x = (h11 - h01) / (100 * CELL);
      out.z = (h11 - h10) / (100 * CELL);
    }
    return out;
  }

  /**
   * Gradient and twist of a cell (cm per 2 m), on the effective ground (or the natural one). The cell is
   * clamped to the lattice.
   */
  cellGrad(cx: number, cz: number, out: CellGrad, natural = false): CellGrad {
    const a = natural ? this.base : this.eff;
    const i = Math.min(this.clampI(cx), this.width + this.margin - 1);
    const j = Math.min(this.clampJ(cz), this.height + this.margin - 1);
    const k = this.vi(i, j);
    const h00 = a[k]!;
    const h10 = a[k + 1]!;
    const h01 = a[k + this.nx]!;
    const h11 = a[k + this.nx + 1]!;
    out.gx = (h10 + h11 - h00 - h01) / 2;
    out.gz = (h01 + h11 - h00 - h10) / 2;
    out.twist = Math.abs(h00 + h11 - h10 - h01);
    return out;
  }

  /**
   * Deck of a belt piece on cell (cx, cz): the least-squares plane of its four corners, exact at the
   * middle of each edge (the mean of that edge's two corners), so neighboring belts meet without a step.
   * With a flow direction (straight conveyors), the cross slope is dropped: level across, ramp along.
   */
  deckPlane(cx: number, cz: number, flowRot: number | null, out: DeckPlane): DeckPlane {
    if (this.flat) {
      out.c = 0;
      out.sx = 0;
      out.sz = 0;
      return out;
    }
    const e = this.eff;
    const k = this.vi(cx, cz);
    const h00 = e[k]!;
    const h10 = e[k + 1]!;
    const h01 = e[k + this.nx]!;
    const h11 = e[k + this.nx + 1]!;
    out.c = (h00 + h10 + h01 + h11) / 400;
    out.sx = (h10 + h11 - h00 - h01) / (400 * (CELL / 2));
    out.sz = (h01 + h11 - h00 - h10) / (400 * (CELL / 2));
    if (flowRot !== null) {
      if (flowRot & 1) out.sz = 0;
      else out.sx = 0;
    }
    return out;
  }

  /** Water above the ground at (x, z) (m); 0 when dry or without a lake. */
  waterDepthAt(x: number, z: number): number {
    const l = this.lake;
    if (!l) return 0;
    const ex = (x / CELL - l.x) / l.rx;
    const ez = (z / CELL - l.z) / l.rz;
    if (ex * ex + ez * ez > SHORE_IN) return 0;
    return Math.max(0, l.level / 100 - this.heightAt(x, z));
  }

  /** Natural height (m) anywhere, beyond the lattice too (far mesh bands); the lattice border otherwise. */
  farHeight(x: number, z: number): number {
    return this.shape ? this.shape.height(x / CELL, z / CELL) : this.baseAt(Math.round(x / CELL), Math.round(z / CELL)) / 100;
  }

  /** A belt piece can stand on grid cell (cx, cz): dry, and not too steep or twisted (effective ground). */
  beltFits(cx: number, cz: number): boolean {
    if (cx < 0 || cz < 0 || cx >= this.width || cz >= this.height) return false;
    if (this.flat) return true;
    if (this.cellWet[cx + cz * this.width]) return false;
    const e = this.eff;
    const k = this.vi(cx, cz);
    return beltCorners(e[k]!, e[k + 1]!, e[k + this.nx]!, e[k + this.nx + 1]!);
  }

  /** Same, if the padded building `extra` were placed too (build ghosts: its banks count). */
  beltFitsWith(cx: number, cz: number, pads: PadSource, extra: Pad | null): boolean {
    if (!extra || this.flat) return this.beltFits(cx, cz);
    if (cx < 0 || cz < 0 || cx >= this.width || cz >= this.height || this.cellWet[cx + cz * this.width]) return false;
    const h = (i: number, j: number) => this.cornerEff(i, j, pads, extra);
    return beltCorners(h(cx, cz), h(cx + 1, cz), h(cx, cz + 1), h(cx + 1, cz + 1));
  }

  /** Same test on the natural ground (static: build-grid tint, scenery). */
  beltFitsNatural(cx: number, cz: number): boolean {
    if (cx < 0 || cz < 0 || cx >= this.width || cz >= this.height) return false;
    if (this.flat) return true;
    if (this.cellWet[cx + cz * this.width]) return false;
    const g = this.cellGrad(cx, cz, SCRATCH_GRAD, true);
    return Math.abs(g.gx) <= TERRAIN_RULES.BELT_GRAD && Math.abs(g.gz) <= TERRAIN_RULES.BELT_GRAD && g.twist <= TERRAIN_RULES.BELT_TWIST;
  }

  // ---------------------------------------------------------------- pads

  /** Natural corners under a footprint (corner rectangle): their rounded mean, lowest and highest (cm). */
  padStats(x0: number, z0: number, x1: number, z1: number): { mean: number; min: number; max: number } {
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let gj = z0; gj <= z1; gj++) {
      for (let gi = x0; gi <= x1; gi++) {
        const h = this.baseAt(gi, gj);
        sum += h;
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
    return { mean: Math.round(sum / ((x1 - x0 + 1) * (z1 - z0 + 1))), min, max };
  }

  /**
   * Pad height (cm) of a footprint: the mean of its natural corners rounded to PAD_ROUND, or the pad of an
   * adjacent building (`neighbors`, in id order) within PAD_SNAP of that mean when it keeps every corner's
   * cut or fill within PAD_CUT_FILL (the nearest wins, ties to the first): rows along a slope become terraces.
   */
  padRule(x0: number, z0: number, x1: number, z1: number, neighbors: readonly number[]): number {
    if (this.flat) return 0;
    const s = this.padStats(x0, z0, x1, z1);
    const R = TERRAIN_RULES;
    let best = Math.round(s.mean / R.PAD_ROUND) * R.PAD_ROUND;
    let bestD = Infinity;
    for (const py of neighbors) {
      const d = Math.abs(py - s.mean);
      if (d <= R.PAD_SNAP && d < bestD && s.max - py <= R.PAD_CUT_FILL && py - s.min <= R.PAD_CUT_FILL) {
        best = py;
        bestD = d;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- effective ground

  /** Recomputes the effective ground on the corner rectangle [i0, i1] × [j0, j1] (clamped to the lattice). */
  recompute(i0: number, j0: number, i1: number, j1: number, pads: PadSource): void {
    if (this.flat) return;
    i0 = this.clampI(i0);
    j0 = this.clampJ(j0);
    i1 = this.clampI(i1);
    j1 = this.clampJ(j1);
    for (let gj = j0; gj <= j1; gj++) for (let gi = i0; gi <= i1; gi++) this.eff[this.vi(gi, gj)] = this.cornerEff(gi, gj, pads, null);
  }

  recomputeAll(pads: PadSource): void {
    this.recompute(-this.margin, -this.margin, this.width + this.margin, this.height + this.margin, pads);
  }

  /** Effective height (cm) a corner would have with `extra` placed too (build ghosts). */
  effWith(gi: number, gj: number, pads: PadSource, extra: Pad | null): number {
    if (this.flat) return 0;
    return this.cornerEff(this.clampI(gi), this.clampJ(gj), pads, extra);
  }

  /**
   * One corner: under pads, the lowest pad touching it (a step between two pads shows on the higher
   * one's foundation); otherwise a bank toward the nearest pads (75 / 50 / 25 % of their cut or fill at
   * 1 / 2 / 3 steps); otherwise the natural ground. Banks stop at the lake; legacy pads in it stand on fill.
   */
  private cornerEff(gi: number, gj: number, pads: PadSource, extra: Pad | null): number {
    const v = this.vi(gi, gj);
    const b = this.base[v]!;
    const level = this.lake ? this.lake.level : null;
    let min = Infinity;
    for (let cz = gj - 1; cz <= gj; cz++) {
      for (let cx = gi - 1; cx <= gi; cx++) {
        const id = pads.padIdAt(cx, cz);
        if (!id) continue;
        const p = pads.pad(id);
        if (p && p.py < min) min = p.py;
      }
    }
    if (extra && gi >= extra.x0 && gi <= extra.x1 && gj >= extra.z0 && gj <= extra.z1 && extra.py < min) min = extra.py;
    if (min !== Infinity) return this.wet[v] && level !== null ? Math.max(min, level + WATER_FILL) : min;
    if (this.wet[v]) return b;

    let dmin = K + 1;
    let sum = 0;
    let n = 0;
    let seenN = 0;
    const consider = (p: Pad) => {
      const dx = Math.max(p.x0 - gi, 0, gi - p.x1);
      const dz = Math.max(p.z0 - gj, 0, gj - p.z1);
      const d = Math.max(dx, dz);
      if (d > K) return;
      const ci = gi < p.x0 ? p.x0 : gi > p.x1 ? p.x1 : gi;
      const cj = gj < p.z0 ? p.z0 : gj > p.z1 ? p.z1 : gj;
      const delta = p.py - this.base[this.vi(ci, cj)]!;
      if (d < dmin) {
        dmin = d;
        sum = delta;
        n = 1;
      } else if (d === dmin) {
        sum += delta;
        n++;
      }
    };
    for (let cz = gj - K - 1; cz <= gj + K; cz++) {
      for (let cx = gi - K - 1; cx <= gi + K; cx++) {
        const id = pads.padIdAt(cx, cz);
        if (!id) continue;
        let dup = false;
        for (let s = 0; s < seenN; s++) if (this.seen[s] === id) dup = true;
        if (dup || seenN >= this.seen.length) continue;
        this.seen[seenN++] = id;
        const p = pads.pad(id);
        if (p) consider(p);
      }
    }
    if (extra) consider(extra);
    if (!n) return b;
    let h = b + Math.round((Math.round(sum / n) * (K + 1 - dmin)) / (K + 1));
    // A bank never digs a dry corner under the water.
    if (level !== null && h < b && h < level + WATER_FILL) h = Math.max(h, Math.min(b, level + WATER_FILL));
    return h;
  }
}

const SCRATCH_GRAD: CellGrad = { gx: 0, gz: 0, twist: 0 };

/** Belt limits on a cell's four corners (cm): gradient along x and z, and twist. */
function beltCorners(h00: number, h10: number, h01: number, h11: number): boolean {
  const gx = h10 + h11 - h00 - h01;
  const gz = h01 + h11 - h00 - h10;
  const R = TERRAIN_RULES.BELT_GRAD * 2;
  return gx <= R && gx >= -R && gz <= R && gz >= -R && Math.abs(h00 + h11 - h10 - h01) <= TERRAIN_RULES.BELT_TWIST;
}
