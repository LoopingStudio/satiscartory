import { BUILDINGS } from '../data/buildings';
import { DX, DZ, rotateSide, type Rot } from '../factory/sim/dirs';
import type { Building, GarageB } from '../factory/sim/types';

/*
 * Garages of several places (pure): garages side by side along their width (local ±X), with the same rotation and the
 * same pad height, are the modules of one garage. The walls between two modules go (BuildingVisuals, FactoryWorld);
 * each module keeps its own bay, door and panel. « Agrandir » places one more module on a side.
 */

/** Side of a module along its width: -1 local −X, +1 local +X. */
export type GarageSide = -1 | 1;

/** What the grouping reads of the sim: the building on a cell. */
export interface GarageGrid {
  at(x: number, z: number): Building | undefined;
}

/** Anchor of the module that would stand on `side` of `g` (same size, same rotation). */
export function sideAnchor(g: { x: number; z: number; rot: Rot }, side: GarageSide): [number, number] {
  const width = BUILDINGS.garage.footprint[0];
  const s = rotateSide(side > 0 ? 1 : 3, g.rot);
  return [g.x + DX[s] * width, g.z + DZ[s] * width];
}

/** The module of the same garage on `side` of `g`, if any. */
export function garageNeighbor(grid: GarageGrid, g: GarageB, side: GarageSide): GarageB | null {
  const [x, z] = sideAnchor(g, side);
  const n = grid.at(x, z);
  return n && n.type === 'garage' && n.id !== g.id && n.x === x && n.z === z && n.rot === g.rot && (n.py ?? 0) === (g.py ?? 0) ? n : null;
}

/** Which sides of `g` open onto another module (no wall there). */
export function openSides(grid: GarageGrid, g: GarageB): { minus: boolean; plus: boolean } {
  return { minus: !!garageNeighbor(grid, g, -1), plus: !!garageNeighbor(grid, g, 1) };
}

/** Every module of the garage of `g`, from its −X end to its +X end (`g` alone: a garage of one place). */
export function garageGroup(grid: GarageGrid, g: GarageB): GarageB[] {
  const left: GarageB[] = [];
  const seen = new Set<number>([g.id]);
  for (let n = garageNeighbor(grid, g, -1); n && !seen.has(n.id); n = garageNeighbor(grid, n, -1)) {
    seen.add(n.id);
    left.unshift(n);
  }
  const right: GarageB[] = [];
  for (let n = garageNeighbor(grid, g, 1); n && !seen.has(n.id); n = garageNeighbor(grid, n, 1)) {
    seen.add(n.id);
    right.push(n);
  }
  return [...left, g, ...right];
}
