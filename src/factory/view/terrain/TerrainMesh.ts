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

interface Static {
  index: THREE.BufferAttribute;
  colors: THREE.BufferAttribute;
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
    const ax = axis(terrain.width, terrain.margin);
    const az = axis(terrain.height, terrain.margin);
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
export function buildTerrainGeometry(t: Terrain, ax = axis(t.width, t.margin), az = axis(t.height, t.margin)): THREE.BufferGeometry {
  const xs = ax.coords;
  const zs = az.coords;
  const nx = xs.length;
  const nz = zs.length;
  const pos = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = i - ax.first;
      const b = j - az.first;
      const inside = a >= 0 && b >= 0 && a < t.nx && b < t.nz;
      const k = (i + j * nx) * 3;
      pos[k] = xs[i]!;
      pos[k + 1] = inside ? t.eff[a + b * t.nx]! / 100 : t.farHeight(xs[i]!, zs[j]!);
      pos[k + 2] = zs[j]!;
    }
  }
  const key = `${t.id}|${t.width}|${t.height}|${t.margin}`;
  let st = statics.get(key);
  if (!st || t.id === 'flat') {
    st = { index: buildIndex(nx, nz), colors: buildColors(t, xs, zs, pos) };
    statics.set(key, st);
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
      c.copy(GREENS[0]!).lerp(GREENS[1]!, smoothstep(0.2, 0.5, n)).lerp(GREENS[2]!, smoothstep(0.55, 0.85, n));
      c.lerp(DRY, 0.6 * smoothstep(4, 9, h));
      const outside = Math.max(-x, x - W, -z, z - H, 0);
      c.lerp(DIRT, smoothstep(17, 26, deg));
      c.lerp(ROCK, Math.max(smoothstep(27, 36, deg), smoothstep(6, 30, outside) * smoothstep(8, 25, h)));
      c.lerp(SNOW, smoothstep(50, 62, h));
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
