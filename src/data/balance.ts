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

/**
 * Wear of the installed parts (data/wear.ts, car/wearMeter.ts), per slot in integer thousandths: 0 = new (no key),
 * MAX = worn out; the state shown is ⌊(1000 − w) / 10⌋ %. Every threshold reads « above » (>).
 */
export const WEAR = {
  MAX: 1000,
  /** A car with a part above this does not start a race (19 % shown or less; 20 % still races). */
  BLOCK_ABOVE: 800,
  /** Gauges turn orange above this (49 % shown or less), red above BLOCK_ABOVE. */
  WARN_ABOVE: 500,
  /**
   * Wheels, ‰ per km with the wheels on the ground: rolling, plus TIRE_HANDBRAKE_PER_KM with the handbrake on,
   * plus TIRE_SLIDE_PER_KM per km slid sideways beyond SLIP_FREE (m/s, a tire at its grip limit slides that much).
   * A clean lap of the Ovale (0.58 km, the bot barely slides) takes about 21 ‰: some 38 laps to BLOCK_ABOVE.
   */
  TIRE_PER_KM: 36,
  TIRE_HANDBRAKE_PER_KM: 150,
  TIRE_SLIDE_PER_KM: 400,
  SLIP_FREE: 0.3,
  /** Engine, ‰ per km: rolling, plus ENGINE_THROTTLE_PER_KM × throttle (full throttle wears about 4 times more). */
  ENGINE_PER_KM: 3,
  ENGINE_THROTTLE_PER_KM: 10,
  /**
   * Shocks: a contact speed change above SHOCK_FLOOR (m/s in one step, in the car's plane) opens a window of at most
   * SHOCK_WINDOW steps that sums them up; when it closes, each body part takes min(SHOCK_MAX, SHOCK_K × max(0,
   * Δv − SHOCK_FREE)²) ‰. Pushing or steering into a wall stays under the floor, and so does a landing from up to
   * 2 m; one from 4 to 8 m may cross it and costs a few ‰ at most. Grazes are free.
   */
  SHOCK_FLOOR: 2,
  SHOCK_WINDOW: 4,
  SHOCK_FREE: 3,
  SHOCK_K: { chassis: 0.33, panels: 0.5, spoiler: 0.4 },
  SHOCK_MAX: 300,
  /** Put back on the road (‰ chassis / panels / spoiler) per cause; « Recommencer » and « Réessayer » cost nothing. */
  RESET: {
    key: { chassis: 2, panels: 3, spoiler: 3 },
    stuck: { chassis: 2, panels: 3, spoiler: 3 },
    flip: { chassis: 15, panels: 25, spoiler: 30 },
    fall: { chassis: 20, panels: 20, spoiler: 20 },
    water: { chassis: 10, panels: 15, spoiler: 10 },
  },
  /** Damage flash (HUD) from this many ‰ on the most hit part: « Retour arrière » (2 to 3 ‰) shows nothing. */
  FLASH_MIN: 5,
  /**
   * 3D look (car/CarModel.ts): the tires and the body darken one step above each of these (‰), the darkest one above
   * BLOCK_ABOVE (« à réparer »); the middle one is where the gauges turn orange (WARN_ABOVE).
   */
  LOOK_ABOVE: [250, 500, 800],
  /** The engine smokes above this (‰), more and more up to MAX, more at full throttle (car/CarFx.ts). */
  SMOKE_ABOVE: 700,
  /**
   * Effects of a worn-out part (car/wornTuning.ts), on the final tuning, through the curve L(u) = u(1 + 3u)/4 of
   * u = w / MAX (slope 1/4 at the start, L = 0.68 at the race limit): the wheels lose `grip` of their friction (all
   * three frictions), the engine `engine` of its force, the chassis `steer` of its steering and `brake` of its brakes,
   * the panels add `drag` to the drag, a spoiler loses `spoiler` of its own share of the downforce. At the race limit
   * a lap is about 10 % slower; the Sportive's 17 % on the Colline, whose steep ramp takes more than its engine pushes
   * (tests/wear-sim.test.ts).
   */
  EFFECT: { grip: 0.25, engine: 0.2, steer: 0.15, brake: 0.2, drag: 0.2, spoiler: 0.5 },
} as const;

/** Production rates (« /min »): measured over the last WINDOW ticks; a building placed or reset less than MIN_SPAN ago is still measuring. */
export const STATS = {
  /** 1 200 ticks = the last minute. */
  WINDOW: 1200,
  /** 60 ticks = 3 s. */
  MIN_SPAN: 60,
} as const;
