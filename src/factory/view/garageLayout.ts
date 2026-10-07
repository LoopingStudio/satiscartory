import { BUILDINGS } from '../../data/buildings';
import { FACTORY_CELL } from '../../config/constants';
import { rotatedSize, type Rot } from '../sim/dirs';
import { rotateLocal } from './beltPath';

/** Axis-aligned box in building-local meters: center and half extents. */
export interface LayoutBox {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
}

const [FW, FD] = BUILDINGS.garage.footprint;

/**
 * Garage in garage-local meters (rotation 0, origin = footprint center on the ground): a 6 × 8 m box
 * with the back wall on -Z, side walls on ±X and the whole front (+Z, GARAGE_DOOR_SIDE) open as the
 * door, under a lintel. Nothing on the floor of the bay (cars drive on the ground collider) and no roof
 * (visual beams only): the orbit and chase cameras see the bay from outside and are never trapped.
 * Shared by the model (BuildingVisuals), the colliders (FactoryWorld) and the hover outline
 * (BuildController).
 */
export const GARAGE = {
  /** Half size of the footprint (X: width, Z: depth). */
  halfW: (FW * FACTORY_CELL) / 2,
  halfD: (FD * FACTORY_CELL) / 2,
  /** Gap between the walls and the footprint edge (neighbors never touch the walls). */
  inset: 0.05,
  /** Wall thickness. */
  wall: 0.3,
  /**
   * Wall height. The player jumps 1.6 m and autosteps 0.9 m (also in the air): 2.5 m from the ground,
   * 3.3 m from a conveyor (0.8 m) laid along the wall. Not proof against the top of a machine (2.1 m).
   */
  height: 3.5,
  /** Depth (along Z) of the yellow door posts that end the side walls. */
  post: 1.1,
} as const;

/** Outer half extents of the walls. */
const W = GARAGE.halfW - GARAGE.inset;
const D = GARAGE.halfD - GARAGE.inset;
const T = GARAGE.wall;
const H = GARAGE.height;
/** Clear height of the door (the kart with its seated driver is 2.13 m tall). */
const DOOR_H = 2.8;

/** Walls (also the colliders): back, then -X and +X sides running from the back wall to the door. Never overlapping. */
export const GARAGE_WALLS: readonly LayoutBox[] = [
  { x: 0, y: H / 2, z: -D + T / 2, hx: W, hy: H / 2, hz: T / 2 },
  { x: -(W - T / 2), y: H / 2, z: T / 2, hx: T / 2, hy: H / 2, hz: D - T / 2 },
  { x: W - T / 2, y: H / 2, z: T / 2, hx: T / 2, hy: H / 2, hz: D - T / 2 },
];

/** Lintel over the door, carrying the sign (collider too: a jumping head bumps into it). */
export const GARAGE_LINTEL: LayoutBox = { x: 0, y: (DOOR_H + H) / 2, z: D - T / 2, hx: W - T, hy: (H - DOOR_H) / 2, hz: T / 2 };

/**
 * Clutter in the back corners, outside the bay (also colliders): a stack of two tires lying flat (+X)
 * and two crates (-X). Low (< 1 m): even a jump from them stays under the wall tops.
 */
export const GARAGE_CLUTTER = {
  tires: { x: W - T - 0.45, y: 0.455, z: -D + T + 0.45, hx: 0.39, hy: 0.455, hz: 0.39 },
  crates: { x: -(W - T - 0.5), y: 0.385, z: -D + T + 0.45, hx: 0.44, hy: 0.385, hz: 0.4 },
} as const satisfies Record<string, LayoutBox>;

/** Inside of the walls (local Z from the back wall to the open front). */
export const GARAGE_INNER = { halfW: W - T, back: -D + T, front: D } as const;

/** The door: the whole front between the side walls, under the lintel. */
export const GARAGE_DOOR = { z: D, halfWidth: W - T, height: DOOR_H } as const;

/** Painted bay around the footprint center (parking bayPose): fits the sport car (1.91 × 3.88 m) with room. */
export const GARAGE_BAY = { halfW: 1.3, halfD: 2.4 } as const;

/** A layout box turned by r quarter turns (+Z -> +X), as placed for a building of rotation r. */
export function rotateBox(b: LayoutBox, r: Rot): LayoutBox {
  const c = { x: 0, z: 0 };
  rotateLocal(b.x, b.z, r, c);
  const [hx, hz] = rotatedSize(b.hx, b.hz, r);
  return { x: c.x, y: b.y, z: c.z, hx, hy: b.hy, hz };
}
