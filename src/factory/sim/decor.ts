import { FACTORY_CELL } from '../../config/constants';
import type { ResourceNode } from '../../data/factoryMap';
import type { Terrain } from './terrain';
import { hash2, smoothstep, valueNoise } from './terrainNoise';

/**
 * Scenery of the relief map (pure and deterministic, no three): where trees and rocks stand. Trees and
 * big rocks are solid; pebbles and the far pines (on the mountains, past the lattice) are only seen.
 * Building over an item hides it (its clear disc touches a taken cell) and dismantling brings it back.
 */
export type DecorKind = 'pine' | 'oak' | 'birch' | 'rock' | 'pebble' | 'farPine';

export interface DecorItem {
  kind: DecorKind;
  x: number;
  z: number;
  yaw: number;
  scale: number;
  /** Radius (m) of the disc a building must stay clear of for the item to show (canopy, rock). */
  clear: number;
  /** Solid (a trunk or a big rock collider). */
  solid: boolean;
}

export interface DecorLayout {
  items: DecorItem[];
  /** Per grid cell (cx + cz · width): items whose clear disc touches it. */
  byCell: Map<number, number[]>;
  /** Per item: the grid cells its clear disc touches (cx + cz · width). */
  cells: number[][];
}

const SEED = 0x7ee5;
/** Near items on a jittered grid of this spacing (m). */
const STEP = 5;
/** No trees within this many cells of the plateau's center (pebbles only), full density from FULL on. */
const CORE = 22;
const FULL = 40;

/** Natural slope (degrees) at (x, z) m, from the cell's natural gradient. */
function slopeDeg(t: Terrain, x: number, z: number): number {
  const g = t.cellGrad(Math.floor(x / FACTORY_CELL), Math.floor(z / FACTORY_CELL), { gx: 0, gz: 0, twist: 0 }, true);
  return (Math.atan(Math.max(Math.abs(g.gx), Math.abs(g.gz)) / 200) * 180) / Math.PI;
}

/**
 * The scenery of a map: trees in forests (denser away from the plateau), big rocks on slopes, pebbles,
 * and far pines on the mountains. Nothing on the plateau's core (but pebbles), on resource nodes and
 * around them, in the lake and on its shore, near the spawn, nor on the cliff band past the grid edge.
 */
export function decorLayout(t: Terrain, nodes: readonly ResourceNode[], spawn: { x: number; z: number }, plateau: { x: number; z: number }): DecorLayout {
  const items: DecorItem[] = [];
  if (t.flat) return { items, byCell: new Map(), cells: [] };
  const W = t.width * FACTORY_CELL;
  const H = t.height * FACTORY_CELL;
  const lo = -t.margin * FACTORY_CELL;
  const hiX = W + t.margin * FACTORY_CELL;
  const hiZ = H + t.margin * FACTORY_CELL;
  const lake = t.lake;
  const nearNode = (x: number, z: number, cells: number) =>
    nodes.some((n) => x > (n.x - cells) * FACTORY_CELL && x < (n.x + n.w + cells) * FACTORY_CELL && z > (n.z - cells) * FACTORY_CELL && z < (n.z + n.h + cells) * FACTORY_CELL);
  /** Natural ground (m) near (x, z): the layout depends on the map only, not on what was built. */
  const baseH = (x: number, z: number) => t.baseAt(Math.round(x / FACTORY_CELL), Math.round(z / FACTORY_CELL)) / 100;
  /** In the lake or on its shore (up to 1.5 m above the water). */
  const wet = (x: number, z: number) => {
    if (!lake) return false;
    const ex = (x / FACTORY_CELL - lake.x) / lake.rx;
    const ez = (z / FACTORY_CELL - lake.z) / lake.rz;
    return ex * ex + ez * ez < 3.2 && baseH(x, z) < lake.level / 100 + 1.5;
  };
  const outside = (x: number, z: number) => Math.max(-x, x - W, -z, z - H, 0);
  for (let gz = lo; gz < hiZ; gz += STEP) {
    for (let gx = lo; gx < hiX; gx += STEP) {
      const r1 = hash2(gx, gz, SEED);
      const r2 = hash2(gx, gz, SEED + 1);
      const r3 = hash2(gx, gz, SEED + 2);
      const x = gx + (r1 - 0.5) * STEP * 0.8;
      const z = gz + (r2 - 0.5) * STEP * 0.8;
      if (x < lo + 1 || z < lo + 1 || x > hiX - 1 || z > hiZ - 1) continue;
      const dc = Math.hypot(x / FACTORY_CELL - plateau.x, z / FACTORY_CELL - plateau.z);
      // Pebbles everywhere but the water, the nodes and the spawn.
      if (r3 < 0.18 && !wet(x, z) && !nearNode(x, z, 1) && Math.hypot(x - spawn.x, z - spawn.z) > 8 && outside(x, z) === 0) {
        items.push({ kind: 'pebble', x: x + 1.3, z: z - 0.9, yaw: r1 * 6.28, scale: 0.18 + r2 * 0.22, clear: 0.3, solid: false });
      }
      if (dc < CORE || nearNode(x, z, 3) || wet(x, z) || Math.hypot(x - spawn.x, z - spawn.z) < 8) continue;
      // No step up the cliff: nothing on the band past the edge of the grid.
      if (outside(x, z) > 0) continue;
      const deg = slopeDeg(t, x, z);
      if (deg > 45) continue;
      const forest = (valueNoise(x / 70, z / 70, SEED + 3) + 1) / 2;
      const density = smoothstep(CORE, FULL, dc) * (0.16 + 0.8 * smoothstep(0.4, 0.75, forest));
      if (deg > 32) {
        if (r3 < 0.35) items.push({ kind: 'rock', x, z, yaw: r1 * 6.28, scale: 0.9 + r2 * 1.4, clear: 1.2 + r2 * 1.2, solid: true });
        continue;
      }
      if (r3 > density) {
        // A lone big rock now and then in the open.
        if (r3 > 0.985) items.push({ kind: 'rock', x, z, yaw: r1 * 6.28, scale: 0.8 + r2, clear: 1 + r2, solid: true });
        continue;
      }
      const h = baseH(x, z);
      const kind: DecorKind = h > 4.5 || forest > 0.72 ? 'pine' : r2 < 0.35 ? 'birch' : 'oak';
      const scale = 0.8 + r1 * 0.5;
      items.push({ kind, x, z, yaw: r2 * 6.28, scale, clear: (kind === 'oak' ? 2.1 : kind === 'pine' ? 1.5 : 1.3) * scale, solid: true });
    }
  }
  // Far pines on the mountains (8 m band past the lattice), below the snow.
  for (let gz = lo - 190; gz < hiZ + 190; gz += 8) {
    for (let gx = lo - 190; gx < hiX + 190; gx += 8) {
      if (gx > lo && gx < hiX && gz > lo && gz < hiZ) continue;
      const r1 = hash2(gx, gz, SEED + 7);
      const r2 = hash2(gx, gz, SEED + 8);
      const x = gx + (r1 - 0.5) * 7;
      const z = gz + (r2 - 0.5) * 7;
      const h = t.farHeight(x, z);
      if (h > 50) continue;
      const forest = (valueNoise(x / 90, z / 90, SEED + 9) + 1) / 2;
      if (hash2(gx, gz, SEED + 10) > 0.35 + 0.6 * smoothstep(0.3, 0.7, forest)) continue;
      items.push({ kind: 'farPine', x, z, yaw: r1 * 6.28, scale: 1 + r2 * 0.8, clear: 0, solid: false });
    }
  }
  // Cell index of the clear discs (in the grid only).
  const byCell = new Map<number, number[]>();
  const cells: number[][] = items.map(() => []);
  items.forEach((it, i) => {
    if (it.clear <= 0) return;
    const c0x = Math.floor((it.x - it.clear) / FACTORY_CELL);
    const c1x = Math.floor((it.x + it.clear) / FACTORY_CELL);
    const c0z = Math.floor((it.z - it.clear) / FACTORY_CELL);
    const c1z = Math.floor((it.z + it.clear) / FACTORY_CELL);
    for (let cz = Math.max(0, c0z); cz <= Math.min(t.height - 1, c1z); cz++) {
      for (let cx = Math.max(0, c0x); cx <= Math.min(t.width - 1, c1x); cx++) {
        // The disc touches the cell's square.
        const nx = Math.max(cx * FACTORY_CELL, Math.min(it.x, (cx + 1) * FACTORY_CELL));
        const nz = Math.max(cz * FACTORY_CELL, Math.min(it.z, (cz + 1) * FACTORY_CELL));
        if ((nx - it.x) ** 2 + (nz - it.z) ** 2 >= it.clear * it.clear) continue;
        const key = cx + cz * t.width;
        let list = byCell.get(key);
        if (!list) byCell.set(key, (list = []));
        list.push(i);
        cells[i]!.push(key);
      }
    }
  });
  return { items, byCell, cells };
}

/** Item `i` is hidden: a building stands on a cell its clear disc touches (`grid`: building id per cell). */
export function isCleared(layout: DecorLayout, i: number, grid: Int32Array): boolean {
  for (const key of layout.cells[i]!) if (grid[key]) return true;
  return false;
}

/** Layouts per map (computed once: about 2 000 items). */
const layouts = new Map<string, DecorLayout>();

export function decorLayoutCached(t: Terrain, nodes: readonly ResourceNode[], spawn: { x: number; z: number }, plateau: { x: number; z: number }): DecorLayout {
  const key = `${t.id}|${t.width}|${t.height}|${nodes.length}`;
  let l = layouts.get(key);
  if (!l || t.id === 'flat') layouts.set(key, (l = decorLayout(t, nodes, spawn, plateau)));
  return l;
}
