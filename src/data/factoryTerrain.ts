/**
 * Relief of the factory map (data only; the generator is src/factory/sim/terrain.ts).
 *
 * Heights live on the corners of the 2 m cells, in integer centimeters, over the grid plus a margin.
 * 'flat' is today's perfectly flat floor (unit tests, the stress layout); 'vallonne-1' is the real map:
 * a flat plateau around the hub and the starting nodes, rolling hills, a few steep crests, flat pads
 * under the resource nodes, a lake to the west and mountains beyond the edge of the grid.
 */
export type TerrainId = 'flat' | 'vallonne-1';

export const TERRAIN_IDS: readonly TerrainId[] = ['flat', 'vallonne-1'];

/** Terrain of a new game, and of a save that names none. */
export const FACTORY_TERRAIN_DEFAULT: TerrainId = 'vallonne-1';

export interface TerrainDef {
  seed: number;
  /** Lattice margin around the grid, in cells (the heightfield and the 2 m mesh band cover it). */
  margin: number;
  /** Exactly flat (height 0) within `flat` cells of (x, z), relief faded in until `blend` cells. */
  plateau: { x: number; z: number; flat: number; blend: number };
  /** Rolling hills: value-noise octaves (amplitude in m, wavelength in m). */
  hills: { amp: number; wl: number }[];
  /** Steep crests: ridged noise of amplitude `amp` m and wavelength `wl` m where a coverage noise of
   * wavelength `coverWl` rises between cover[0] and cover[1]. */
  crests: { amp: number; wl: number; coverWl: number; cover: [number, number] };
  /** Flat pads under the resource nodes: node rectangle grown by `margin` cells, blended over `blend`
   * cells, at the relief height of the node's center rounded to `roundCm`. */
  nodeFlat: { margin: number; blend: number; roundCm: number };
  /** Lake: ellipse centered on (x, z) cells with radii (rx, rz) cells. Its level is the relief at the
   * center minus `below` m; the bed goes `depth` m under it; the shore rises `shore` m above it. */
  lake: { x: number; z: number; rx: number; rz: number; below: number; depth: number; shore: number } | null;
  /** Mountains beyond the grid edge: a cliff of slope `cliff` (m per m) over `cliffWidth` m, then rising
   * toward `height` m (half way after `knee` m), with ridges and a wobbly foot. */
  mountains: { cliff: number; cliffWidth: number; height: number; knee: number; ridgeAmp: number; ridgeWl: number; wobble: number; wobbleWl: number };
}

export const TERRAINS: Record<Exclude<TerrainId, 'flat'>, TerrainDef> = {
  'vallonne-1': {
    seed: 0x5a71c0de,
    margin: 16,
    plateau: { x: 63.5, z: 63.5, flat: 24, blend: 36 },
    hills: [
      { amp: 3.8, wl: 84 },
      { amp: 1.7, wl: 40 },
      { amp: 0.6, wl: 18 },
    ],
    crests: { amp: 7, wl: 70, coverWl: 150, cover: [0.4, 0.68] },
    nodeFlat: { margin: 2, blend: 4, roundCm: 25 },
    lake: { x: 40, z: 118, rx: 11, rz: 7, below: 0.6, depth: 1.4, shore: 0.4 },
    mountains: { cliff: 1.5, cliffWidth: 14, height: 80, knee: 60, ridgeAmp: 10, ridgeWl: 120, wobble: 8, wobbleWl: 90 },
  },
};

/**
 * Placement limits, in integer centimeters per 2 m cell (the sim never computes an angle; the HUD turns
 * them into degrees). A cell's gradient is the larger of its two axis gradients, its twist how far its
 * four corners are from a plane.
 */
export const TERRAIN_RULES = {
  /** Under a padded building (machines, drill, garage, hub): 50 cm per cell ≈ 14°. */
  PAD_GRAD: 50,
  /** Highest minus lowest natural corner under a padded building. */
  PAD_RELIEF: 150,
  /** Largest cut or fill between a pad and the natural ground at any of its corners. */
  PAD_CUT_FILL: 120,
  /** Pads are rounded to this step… */
  PAD_ROUND: 10,
  /** …and snap to an adjacent pad within this distance (rows along a slope become terraces). */
  PAD_SNAP: 40,
  /** Banks around a pad: free corners up to this many lattice steps away blend back to the ground. */
  BANK_STEPS: 3,
  /** Under a belt piece (conveyor, splitter, merger): 80 cm per cell ≈ 21.8°. */
  BELT_GRAD: 80,
  BELT_TWIST: 40,
  /** In front of a garage door: rise of each of the 3 cells cars drive out on (≈ 10°). */
  DOOR_RISE: 35,
  /** Legacy buildings standing in the lake are lifted on fill this high above the water (cm). */
  WATER_FILL: 10,
} as const;
