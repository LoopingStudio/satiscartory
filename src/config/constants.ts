// World conventions: 1 unit = 1 m, +Y up, +Z forward (Kenney models face +Z).
// Grid sides: 0 = +Z, 1 = +X, 2 = -Z, 3 = -X. Rotating by r quarter turns
// (object.rotation.y = r * PI/2) maps side s -> (s + r) & 3 and offset (dx, dz) -> (dz, -dx).

/** Size of one track editor cell in meters (road tiles are 1×1 in the kit). */
export const TRACK_CELL = 12;
/** One track height level = rise of `road-slant` = 0.25 tile. */
export const LEVEL_TILE = 0.25;
export const LEVEL_H = TRACK_CELL * LEVEL_TILE;
/** Car models are ~2.56 long; scaled to ~4.1 m. */
export const CAR_SCALE = 1.6;
/** Factory grid cell size in meters; factory-kit tiles are 1×1 so they get this scale. */
export const FACTORY_CELL = 2;
export const FACTORY_MODEL_SCALE = FACTORY_CELL;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_RADIUS = 0.35;

export const PHYS_HZ = 60;
export const PHYS_DT = 1 / PHYS_HZ;
export const FACTORY_HZ = 20;
export const FACTORY_DT = 1 / FACTORY_HZ;
/** Max simulated time per rendered frame (prevents spiral of death). */
export const MAX_FRAME_DT = 0.1;
export const MAX_PHYS_STEPS_PER_FRAME = 8;

export const GRAVITY_FACTORY = -9.81;
export const GRAVITY_RACE = -20;

/** Factory grid size in cells. */
export const FACTORY_GRID_W = 64;
export const FACTORY_GRID_H = 64;
