import * as THREE from 'three';
import { FACTORY_CELL } from '../../../config/constants';
import { smoothstep, valueNoise } from '../../sim/terrainNoise';
import type { Terrain } from '../../sim/terrain';
import { groundMaterial } from './groundMaterial';

/** Far bands around the 2 m lattice: 8 m spacing over 192 m, then 32 m spacing over 512 m (under the fog). */
const BANDS: [step: number, length: number][] = [
  [8, 192],
  [32, 512],
];

/**
 * World coordinates of one axis of the terrain grid: the lattice every 2 m (exactly the physics corners),
 * then coarser far bands on both sides. Also returns the index of the lattice's first corner.
 */
function axis(cells: number, margin: number): { coords: Float64Array; first: number } {
  const lo = -margin * FACTORY_CELL;
  const hi = (cells + margin) * FACTORY_CELL;
  const before: number[] = [];
  let x = lo;
  for (const [step, len] of BANDS) for (let k = 0; k < len / step; k++) before.unshift((x -= step));
  const after: number[] = [];
  x = hi;
  for (const [step, len] of BANDS) for (let k = 0; k < len / step; k++) after.push((x += step));
  const inner: number[] = [];
  for (let k = 0; k <= cells + 2 * margin; k++) inner.push(lo + k * FACTORY_CELL);
  return { coords: Float64Array.from([...before, ...inner, ...after]), first: before.length };
}

const axes = new Map<string, ReturnType<typeof axis>>();
function axisCached(cells: number, margin: number): ReturnType<typeof axis> {
  const key = `${cells}|${margin}`;
  let a = axes.get(key);
  if (!a) axes.set(key, (a = axis(cells, margin)));
  return a;
}

/** Index of the last coordinate ≤ v (clamped to a whole quad). */
function quadOf(coords: Float64Array, v: number): number {
  let lo = 0;
  let hi = coords.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (coords[mid]! <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Natural ground (m) at (x, z) as the mesh draws it: between its far-band corners too, where the height
 * function itself can rise metres above the flat triangles (ridge crests). Scenery past the lattice stands
 * on this, not on Terrain.farHeight.
 */
export function drawnHeight(t: Terrain, x: number, z: number): number {
  const ax = axisCached(t.width, t.margin);
  const az = axisCached(t.height, t.margin);
  const i = quadOf(ax.coords, x);
  const j = quadOf(az.coords, z);
  const corner = (ii: number, jj: number) => {
    const a = ii - ax.first;
    const b = jj - az.first;
    return a >= 0 && b >= 0 && a < t.nx && b < t.nz ? t.base[a + b * t.nx]! / 100 : t.farHeight(ax.coords[ii]!, az.coords[jj]!);
  };
  const x0 = ax.coords[i]!;
  const z0 = az.coords[j]!;
  const fx = Math.min(1, Math.max(0, (x - x0) / (ax.coords[i + 1]! - x0)));
  const fz = Math.min(1, Math.max(0, (z - z0) / (az.coords[j + 1]! - z0)));
  // Same split as buildIndex: (x0, z0)-(x1, z0)-(x0, z1), then (x1, z1)-(x0, z1)-(x1, z0).
  if (fx + fz <= 1) {
    const h00 = corner(i, j);
    return h00 + fx * (corner(i + 1, j) - h00) + fz * (corner(i, j + 1) - h00);
  }
  const h11 = corner(i + 1, j + 1);
  return h11 + (1 - fx) * (corner(i, j + 1) - h11) + (1 - fz) * (corner(i + 1, j) - h11);
}

interface Static {
  index: THREE.BufferAttribute;
  colors: THREE.BufferAttribute;
  /** Positions with the natural ground (the far bands are costly to sample: computed once per map). */
  positions: Float32Array;
}

/** Index and natural colors per map (never change; shared by every factory visit). */
const statics = new Map<string, Static>();

const C = (hex: number) => new THREE.Color(hex);
const GREENS = [C(0x5f8f3c), C(0x6f9d45), C(0x7aa548)];
const DRY = C(0x9aa65a);
const DIRT = C(0x8b7151);
const ROCK = C(0x84808f);
const SAND = C(0xd6c48e);
const BED = C(0x4f6152);
const SNOW = C(0xeef1f6);

/**
 * The relief as one mesh: a tensor grid (no cracks, no skirts) whose middle is the physics lattice, cell
 * for cell, split along the same diagonal as Rapier's heightfield. Flat-shaded low-poly ground with
 * natural vertex colors (grass, dry crests, dirt and rock on slopes, sand on the shore, snow on the peaks).
 */
export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  /** Corners per row of the whole grid (lattice and far bands). */
  private readonly rowLength: number;
  /** Index (in xs / zs) of the lattice's first corner. */
  private readonly fx: number;
  private readonly fz: number;

  constructor(private readonly terrain: Terrain) {
    const ax = axisCached(terrain.width, terrain.margin);
    const az = axisCached(terrain.height, terrain.margin);
    this.rowLength = ax.coords.length;
    this.fx = ax.first;
    this.fz = az.first;
    this.geometry = buildTerrainGeometry(terrain, ax, az);
    this.mesh = new THREE.Mesh(this.geometry, groundMaterial());
    this.mesh.name = 'terrain';
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
  }

  /** Copies the effective ground of lattice corners [i0, i1] × [j0, j1] (grid coords) into the mesh. */
  updateCorners(i0: number, j0: number, i1: number, j1: number): void {
    const t = this.terrain;
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const nxAll = this.rowLength;
    const a0 = Math.max(0, i0 + t.margin);
    const a1 = Math.min(t.nx - 1, i1 + t.margin);
    const b0 = Math.max(0, j0 + t.margin);
    const b1 = Math.min(t.nz - 1, j1 + t.margin);
    for (let b = b0; b <= b1; b++) {
      for (let a = a0; a <= a1; a++) pos.setY(a + this.fx + (b + this.fz) * nxAll, t.eff[a + b * t.nx]! / 100);
    }
    pos.addUpdateRange((a0 + this.fx + (b0 + this.fz) * nxAll) * 3, ((b1 - b0) * nxAll + (a1 - a0) + 1) * 3);
    pos.needsUpdate = true;
  }

  dispose(): void {
    // The index and color attributes are cached per map; only the positions are this mesh's own.
    this.geometry.dispose();
  }
}

/** Geometry of the terrain grid (exported for the mesh/physics parity test). */
export function buildTerrainGeometry(t: Terrain, ax = axisCached(t.width, t.margin), az = axisCached(t.height, t.margin)): THREE.BufferGeometry {
  const xs = ax.coords;
  const zs = az.coords;
  const nx = xs.length;
  const nz = zs.length;
  const key = `${t.id}|${t.width}|${t.height}|${t.margin}`;
  let st = statics.get(key);
  if (!st || !t.generated) {
    // The natural ground everywhere (lattice: base; far bands: the height function).
    const natural = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = i - ax.first;
        const b = j - az.first;
        const inside = a >= 0 && b >= 0 && a < t.nx && b < t.nz;
        const k = (i + j * nx) * 3;
        natural[k] = xs[i]!;
        natural[k + 1] = inside ? t.base[a + b * t.nx]! / 100 : t.farHeight(xs[i]!, zs[j]!);
        natural[k + 2] = zs[j]!;
      }
    }
    // Colors from the natural ground (pads and banks come and go; the shader paints them).
    st = { index: buildIndex(nx, nz), colors: buildColors(t, xs, zs, natural), positions: natural };
    if (t.generated) statics.set(key, st);
  }
  // This sim's ground over the lattice (its pads and banks).
  const pos = st.positions.slice();
  for (let b = 0; b < t.nz; b++) {
    for (let a = 0; a < t.nx; a++) pos[(a + ax.first + (b + az.first) * nx) * 3 + 1] = t.eff[a + b * t.nx]! / 100;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', st.colors);
  g.setIndex(st.index);
  g.computeBoundingSphere();
  return g;
}

/** Two triangles per quad, split along (x1, z0)–(x0, z1) like Rapier's heightfield, facing +Y. */
function buildIndex(nx: number, nz: number): THREE.BufferAttribute {
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let k = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = i + j * nx;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx[k++] = a;
      idx[k++] = c;
      idx[k++] = b;
      idx[k++] = c;
      idx[k++] = d;
      idx[k++] = b;
    }
  }
  return nx * nz < 65536 ? new THREE.BufferAttribute(Uint16Array.from(idx), 1) : new THREE.BufferAttribute(idx, 1);
}

/** Natural colors from height and slope (the effective ground's pads get their concrete in the shader). */
function buildColors(t: Terrain, xs: Float64Array, zs: Float64Array, pos: Float32Array): THREE.BufferAttribute {
  const nx = xs.length;
  const nz = zs.length;
  const col = new Float32Array(nx * nz * 3);
  const c = new THREE.Color();
  const y = (i: number, j: number) => pos[(Math.min(nx - 1, Math.max(0, i)) + Math.min(nz - 1, Math.max(0, j)) * nx) * 3 + 1]!;
  const lake = t.lake;
  const W = t.width * FACTORY_CELL;
  const H = t.height * FACTORY_CELL;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = xs[i]!;
      const z = zs[j]!;
      const h = y(i, j);
      const dx = (y(i + 1, j) - y(i - 1, j)) / ((xs[Math.min(nx - 1, i + 1)]! - xs[Math.max(0, i - 1)]!) || 1);
      const dz = (y(i, j + 1) - y(i, j - 1)) / ((zs[Math.min(nz - 1, j + 1)]! - zs[Math.max(0, j - 1)]!) || 1);
      const deg = (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
      const n = (valueNoise(x / 37, z / 37, 101) + 1) / 2;
      const outside = Math.max(-x, x - W, -z, z - H, 0);
      c.copy(GREENS[0]!).lerp(GREENS[1]!, smoothstep(0.2, 0.5, n)).lerp(GREENS[2]!, smoothstep(0.55, 0.85, n));
      c.lerp(DRY, 0.6 * smoothstep(4, 9, h));
      // Dirt on steep slopes of the grid (the mountains past it stay green up to their rocks).
      c.lerp(DIRT, smoothstep(17, 26, deg) * (1 - smoothstep(0, 10, outside)));
      // Rock on steep ground (the cliff band) and toward the summits, snow on the highest.
      c.lerp(ROCK, Math.max(smoothstep(27, 36, deg), smoothstep(36, 50, h) * smoothstep(0, 20, outside)));
      c.lerp(SNOW, smoothstep(50, 60, h));
      if (lake) {
        const ex = (x / FACTORY_CELL - lake.x) / lake.rx;
        const ez = (z / FACTORY_CELL - lake.z) / lake.rz;
        if (ex * ex + ez * ez < 5.8) {
          const level = lake.level / 100;
          c.lerp(SAND, 1 - smoothstep(level + 0.25, level + 0.7, h));
          c.lerp(BED, 1 - smoothstep(level - 0.4, level - 0.05, h));
        }
      }
      col[(i + j * nx) * 3] = c.r;
      col[(i + j * nx) * 3 + 1] = c.g;
      col[(i + j * nx) * 3 + 2] = c.b;
    }
  }
  return new THREE.BufferAttribute(col, 3);
}
