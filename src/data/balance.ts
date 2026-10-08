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

/** Splitter / merger: items wait in a small buffer between the belts (passed on at one per tick). */
export const NODE = {
  CAP: 2,
} as const;

export const DRILL = {
  /** Ticks per extracted item (40 = 2 s). */
  PERIOD: 40,
  OUT_CAP: 5,
} as const;

export const MACHINE = {
  /** Input buffer cap per item = recipe count × this (belt deliveries). */
  IN_CAP_FACTOR: 2,
  /** Manual loading from the hub may fill up to recipe count × this. */
  MANUAL_CAP_FACTOR: 10,
  OUT_CAP: 10,
} as const;

/** Stock in the central hub on a new game: nothing, the first parts are mined and crafted by hand. */
export const START_STORAGE: Inventory = {};

/** Hand work (player side, not simulated). */
export const HAND = {
  /** Seconds per ore while holding E on a resource node. */
  MINE_SECONDS: 0.75,
  /** Max distance (m) between the player and the nearest point of the mined cell (third-person aim lands a bit ahead). */
  MINE_REACH: 6,
  /** Seconds E is held on a belt to pick up its whole line (a press takes the aimed tile). */
  BELT_LINE_SECONDS: 0.5,
} as const;

/** Dealer (« Concession »): time to assemble and sell one car. */
export const DEALER = {
  /** Ticks per car (200 = 10 s). */
  SELL_TICKS: 200,
} as const;

/**
 * Car prices (data/sales.ts): parts are valued in machine ticks, the car sells for their sum × MARGIN_NUM /
 * MARGIN_DEN, rounded to ROUND credits.
 */
export const SALE = {
  MARGIN_NUM: 5,
  MARGIN_DEN: 4,
  ROUND: 10,
} as const;
