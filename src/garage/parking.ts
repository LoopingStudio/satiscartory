import { BUILDINGS, GARAGE_DOOR_SIDE } from '../data/buildings';
import { FACTORY_CELL } from '../config/constants';
import { DX, DZ, rotateSide, rotatedSize, type Rot } from '../factory/sim/dirs';
import type { CarInstance, CarPose } from './assembly';
import { GARAGE_INNER, rotateBox } from '../factory/view/garageLayout';

/** A garage as placed on the grid (cells). */
export interface GarageSpot {
  id: number;
  x: number;
  z: number;
  rot: Rot;
  /** Its pad height on the relief (cm); absent on a flat map. */
  py?: number;
}

export { GARAGE_DOOR_SIDE };
/** Who blocks a garage's bay, from the cars' real footprints (FactoryCars); see carInBay for the pure fallback. */
export type BayBlocker = (g: Omit<GarageSpot, 'id'>) => CarInstance | null;

/** Bay of a garage: footprint center, car facing the door. */
export function bayPose(g: Omit<GarageSpot, 'id'>): CarPose {
  const [w, h] = BUILDINGS.garage.footprint;
  const [rw, rh] = rotatedSize(w, h, g.rot);
  const side = rotateSide(GARAGE_DOOR_SIDE, g.rot);
  return { x: (g.x + rw / 2) * FACTORY_CELL, y: (g.py ?? 0) / 100, z: (g.z + rh / 2) * FACTORY_CELL, yaw: Math.atan2(DX[side], DZ[side]) };
}

/** World rectangle [minX, minZ, maxX, maxZ] inside the garage walls (bay and doorway). */
export function bayRect(g: Omit<GarageSpot, 'id'>): [number, number, number, number] {
  const b = bayPose(g);
  const inner = { x: 0, y: 0, z: (GARAGE_INNER.back + GARAGE_INNER.front) / 2, hx: GARAGE_INNER.halfW, hy: 0, hz: (GARAGE_INNER.front - GARAGE_INNER.back) / 2 };
  const r = rotateBox(inner, g.rot);
  return [b.x + r.x - r.hx, b.z + r.z - r.hz, b.x + r.x + r.hx, b.z + r.z + r.hz];
}

/** The car standing in this garage (its center inside the walls), if any. Pure fallback of a BayBlocker. */
export function carInBay(cars: readonly CarInstance[], g: Omit<GarageSpot, 'id'>): CarInstance | null {
  const [x0, z0, x1, z1] = bayRect(g);
  return cars.find((c) => c.pose && c.pose.x >= x0 && c.pose.x <= x1 && c.pose.z >= z0 && c.pose.z <= z1) ?? null;
}

/** Car blocking the bay: any car centered inside, or (with `blocker`) any car whose body overlaps it. */
export function bayOccupant(cars: readonly CarInstance[], g: Omit<GarageSpot, 'id'>, blocker?: BayBlocker): CarInstance | null {
  return carInBay(cars, g) ?? blocker?.(g) ?? null;
}

/**
 * Parks every car without a pose in a free garage bay (garages in id order).
 * Returns the cars that were parked. Cars stay unplaced while no bay is free.
 */
export function parkUnplaced(cars: CarInstance[], garages: readonly GarageSpot[], blocker?: BayBlocker): CarInstance[] {
  const parked: CarInstance[] = [];
  const sorted = [...garages].sort((a, b) => a.id - b.id);
  for (const car of cars) {
    if (car.pose) continue;
    const free = sorted.find((g) => !bayOccupant(cars, g, blocker));
    if (!free) break;
    car.pose = bayPose(free);
    parked.push(car);
  }
  return parked;
}
