import type { Inventory } from './items';

/** Factory simulation tuning (integer units; the sim runs at FACTORY_HZ = 20 ticks/s). */
export const BELT = {
  /** Path length units per conveyor tile. */
  SEG: 120,
  /** Units advanced per tick: 6 → 20 ticks per tile = 1 tile/s (2 m/s). */
  SPEED: 6,
  /** Minimum distance between two items: 40 → at most 3 items per tile. */
  SPACING: 40,
} as const;

export const DRILL = {
  /** Ticks per extracted item (40 = 2 s). */
  PERIOD: 40,
  OUT_CAP: 5,
} as const;

export const MACHINE = {
  /** Input buffer cap per item = recipe count × this. */
  IN_CAP_FACTOR: 2,
  OUT_CAP: 10,
} as const;

/** Stock available in the central hub on a new game (pays for the first buildings). */
export const START_STORAGE: Inventory = {
  plate: 70,
  bolt: 36,
};
