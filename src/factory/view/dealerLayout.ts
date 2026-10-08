import { BUILDINGS } from '../../data/buildings';
import { FACTORY_CELL } from '../../config/constants';
import type { CarConfig } from '../../data/sales';
import { newBuild, type CarBuild } from '../../garage/build';
import { BLUEPRINTS } from '../../data/blueprints';
import type { LayoutBox } from './garageLayout';

const [FW, FD] = BUILDINGS.dealer.footprint;
/** Outer half extents (0.05 m inside the footprint, like the garage: neighbors never touch). */
const W = (FW * FACTORY_CELL) / 2 - 0.05;
const D = (FD * FACTORY_CELL) / 2 - 0.05;

/**
 * Dealer (« Concession ») in dealer-local meters (rotation 0, origin = footprint center on the ground): a 6 × 4 m
 * shop. At the back (-Z, the input side) a 3 m store block takes the parts through three hatches; in front a glass
 * showroom on a podium shows the car being assembled, seen side-on through the long front. The sign stands on the
 * store's roof. Shared by the model (BuildingVisuals), the colliders (FactoryWorld) and the tests.
 */
export const DEALER_SHOP = {
  halfW: W,
  halfD: D,
  /** Podium (showroom floor) height. */
  floor: 0.12,
  /** Store block: depth along Z from the back, height. */
  storeDepth: 1.1,
  height: 3.0,
  /** Glass showroom: top of its frame, pane thickness, corner posts and top rails. */
  glassTop: 2.62,
  glass: 0.04,
  post: 0.12,
  rail: 0.1,
} as const;

/** Front face of the store block (back wall of the showroom). */
export const DEALER_STORE_FRONT = -D + DEALER_SHOP.storeDepth;

/** Colliders: the store block and the glass showroom (solid: the player walks around it). */
export const DEALER_BOXES: readonly LayoutBox[] = [
  { x: 0, y: DEALER_SHOP.height / 2, z: (-D + DEALER_STORE_FRONT) / 2, hx: W, hy: DEALER_SHOP.height / 2, hz: DEALER_SHOP.storeDepth / 2 },
  { x: 0, y: DEALER_SHOP.glassTop / 2, z: (DEALER_STORE_FRONT + D) / 2, hx: W, hy: DEALER_SHOP.glassTop / 2, hz: (D - DEALER_STORE_FRONT) / 2 },
];

/** Inside of the glass. */
export const DEALER_SHOWROOM = {
  halfW: W - DEALER_SHOP.glass,
  back: DEALER_STORE_FRONT,
  front: D - DEALER_SHOP.glass,
  top: DEALER_SHOP.glassTop - DEALER_SHOP.rail,
} as const;

/** Where the car on show stands: on the podium, in the middle of the showroom, along X (side-on from the front). */
export const DEALER_DISPLAY = {
  x: 0,
  y: DEALER_SHOP.floor,
  z: (DEALER_SHOWROOM.back + DEALER_SHOWROOM.front) / 2,
  yaw: Math.PI / 2,
} as const;

/** Hatches with strip curtains on the back wall, one in front of each input cell (belts end at 0.8 m). */
export const DEALER_HATCHES = {
  xs: BUILDINGS.dealer.ports.map((p) => (p.cell[0] + 0.5) * FACTORY_CELL - (FW * FACTORY_CELL) / 2),
  bottom: 0.4,
  top: 1.45,
  halfW: 0.7,
  frame: 0.08,
} as const;

/** Sign on the store's roof, readable from both sides. */
export const DEALER_SIGN = { halfW: 2.2, bottom: 3.0, top: 3.6, depth: 0.08, z: (-D + DEALER_STORE_FRONT) / 2 } as const;

/** Progress bar along the bottom of the sign's front face, between its hazard stripes (60 px of 768 each side). */
export const DEALER_BAR = { halfW: DEALER_SIGN.halfW * (1 - 120 / 768), y: DEALER_SIGN.bottom + 0.06, h: 0.06 } as const;

/** Top of the model (highlight boxes, marks floated over it). */
export const DEALER_TOP = DEALER_SIGN.top + 0.05;

/**
 * The car on show after a fraction `f` of its time: its parts go in slot by slot in blueprint order (chassis,
 * engine, wheels one by one, panels, spoiler) like a garage build, and it is complete for the last step.
 */
export function dealerBuild(car: CarConfig, f: number): CarBuild {
  const bp = BLUEPRINTS[car.blueprint];
  const slots = bp.slots.filter((s) => {
    const item = car.parts[s.id];
    return !!item && s.accepts.includes(item);
  });
  const total = slots.reduce((n, s) => n + s.count, 0);
  let left = Math.max(0, Math.min(total, Math.floor(f * (total + 1))));
  const build = newBuild(-1, car.blueprint);
  for (const s of slots) {
    const n = Math.min(s.count, left);
    if (n > 0) build.parts[s.id] = { item: car.parts[s.id]!, n };
    left -= n;
  }
  return build;
}
