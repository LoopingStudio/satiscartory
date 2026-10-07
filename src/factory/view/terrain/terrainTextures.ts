import * as THREE from 'three';
import type { FactorySim, TerrainRect } from '../../sim/FactorySim';
import type { Terrain } from '../../sim/terrain';

/**
 * Per-cell data of the relief for the shaders, one texel per lattice cell (grid + margin):
 * R occupancy (255: a building or belt stands there), G surface (255: a pad, concrete; 1..127: how far
 * the banks moved the ground, in cm: dug earth), B natural ground no belt fits on (build grid tint),
 * A resource node (1 iron, 2 rubber). Plus the effective ground heights per corner (m, float) for the grass.
 */
export class TerrainTextures {
  readonly cells: THREE.DataTexture;
  readonly heights: THREE.DataTexture;
  private readonly cellData: Uint8Array;
  private readonly heightData: Float32Array;
  /**
   * Changed since the last upload. Whole re-uploads (about 100 KB each, only when a pad is placed or
   * removed): three's partial texture updates are single-row and RGBA only.
   */
  private cellsDirty = false;
  private heightsDirty = false;
  private readonly cw: number;
  private readonly ch: number;

  constructor(private readonly sim: FactorySim) {
    const t = sim.terrain;
    this.cw = t.nx - 1;
    this.ch = t.nz - 1;
    this.cellData = new Uint8Array(this.cw * this.ch * 4);
    this.heightData = new Float32Array(t.nx * t.nz);
    for (let k = 0; k < this.cellData.length / 4; k++) {
      const ci = k % this.cw;
      const cj = (k - ci) / this.cw;
      const cx = ci - t.margin;
      const cz = cj - t.margin;
      const inGrid = cx >= 0 && cz >= 0 && cx < sim.width && cz < sim.height;
      this.cellData[k * 4 + 2] = inGrid && !t.beltFitsNatural(cx, cz) ? 255 : 0;
      const node = inGrid ? sim.nodeGrid[cx + cz * sim.width]! : 0;
      this.cellData[k * 4 + 3] = node;
    }
    this.writeCells(-t.margin, -t.margin, sim.width + t.margin - 1, sim.height + t.margin - 1);
    this.writeHeights(-t.margin, -t.margin, sim.width + t.margin, sim.height + t.margin);
    this.cells = new THREE.DataTexture(this.cellData, this.cw, this.ch, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.cells.magFilter = this.cells.minFilter = THREE.NearestFilter;
    this.cells.needsUpdate = true;
    this.heights = new THREE.DataTexture(this.heightData, t.nx, t.nz, THREE.RedFormat, THREE.FloatType);
    this.heights.magFilter = this.heights.minFilter = THREE.NearestFilter;
    this.heights.needsUpdate = true;
    this.cellsDirty = this.heightsDirty = false;
  }

  get terrain(): Terrain {
    return this.sim.terrain;
  }

  /** The ground changed on corners [i0, i1] × [j0, j1]: heights there, cell surfaces around. */
  terrainChanged(r: TerrainRect): void {
    this.writeHeights(r.i0, r.j0, r.i1, r.j1);
    this.writeCells(r.i0 - 1, r.j0 - 1, r.i1, r.j1);
  }

  /** A building appeared or left on these grid cells. */
  occupancyChanged(cells: readonly [number, number][]): void {
    for (const [cx, cz] of cells) this.writeCells(cx, cz, cx, cz);
  }

  /** Uploads what changed (call once per frame). */
  flush(): void {
    if (this.cellsDirty) this.cells.needsUpdate = true;
    if (this.heightsDirty) this.heights.needsUpdate = true;
    this.cellsDirty = this.heightsDirty = false;
  }

  /** Occupancy and surface of grid cells [cx0, cx1] × [cz0, cz1] (any cells of the lattice). */
  private writeCells(cx0: number, cz0: number, cx1: number, cz1: number): void {
    const t = this.terrain;
    const sim = this.sim;
    const M = t.margin;
    const a0 = Math.max(0, cx0 + M);
    const a1 = Math.min(this.cw - 1, cx1 + M);
    const b0 = Math.max(0, cz0 + M);
    const b1 = Math.min(this.ch - 1, cz1 + M);
    if (a0 > a1 || b0 > b1) return;
    for (let b = b0; b <= b1; b++) {
      for (let a = a0; a <= a1; a++) {
        const cx = a - M;
        const cz = b - M;
        const k = (a + b * this.cw) * 4;
        this.cellData[k] = sim.at(cx, cz) ? 255 : 0;
        let moved = 0;
        for (const [i, j] of CORNERS) moved = Math.max(moved, Math.abs(t.effAt(cx + i, cz + j) - t.baseAt(cx + i, cz + j)));
        this.cellData[k + 1] = sim.padIdAt(cx, cz) ? 255 : Math.min(127, moved);
      }
    }
    this.cellsDirty = true;
  }

  private writeHeights(i0: number, j0: number, i1: number, j1: number): void {
    const t = this.terrain;
    const M = t.margin;
    const a0 = Math.max(0, i0 + M);
    const a1 = Math.min(t.nx - 1, i1 + M);
    const b0 = Math.max(0, j0 + M);
    const b1 = Math.min(t.nz - 1, j1 + M);
    for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) this.heightData[a + b * t.nx] = t.eff[a + b * t.nx]! / 100;
    this.heightsDirty = true;
  }

  dispose(): void {
    this.cells.dispose();
    this.heights.dispose();
  }
}

const CORNERS = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
] as const;
