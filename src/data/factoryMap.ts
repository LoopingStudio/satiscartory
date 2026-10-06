import type { ItemId } from './items';

export type ResourceId = 'iron' | 'rubber';

export interface ResourceDef {
  id: ResourceId;
  name: string;
  item: ItemId;
  color: number;
}

export const RESOURCES: Record<ResourceId, ResourceDef> = {
  iron: { id: 'iron', name: 'Gisement de fer', item: 'iron_ore', color: 0xb5653e },
  rubber: { id: 'rubber', name: 'Gisement de caoutchouc', item: 'latex', color: 0x34364a },
};

/** A rectangular patch of resource cells on the factory grid. */
export interface ResourceNode {
  resource: ResourceId;
  x: number;
  z: number;
  w: number;
  h: number;
}

/**
 * Saves made on the former 64×64 map are shifted by this many cells on load so that
 * their hub (30, 30) lands on the new centered hub (62, 62).
 */
export const LEGACY_MAP_OFFSET = 32;

/**
 * Fixed starting map (128×128 cells of 2 m). The hub sits at the center. Resource nodes
 * are spread out: one iron and one rubber node ~17 cells from the hub for the first
 * chains, the others 26 to 50 cells away in every direction.
 */
export const FACTORY_MAP = {
  hub: { x: 62, z: 62, rot: 0 as const },
  /** Player spawn, in cells (fractional allowed). */
  spawn: { x: 63.5, z: 58.5 },
  /** Garage terminal (cells). */
  garage: { x: 66.5, z: 63.5 },
  nodes: [
    // Starting nodes (west and north of the hub).
    { resource: 'iron', x: 44, z: 61, w: 4, h: 4 },
    { resource: 'rubber', x: 61, z: 80, w: 3, h: 3 },
    // Farther away.
    { resource: 'iron', x: 88, z: 70, w: 4, h: 3 },
    { resource: 'iron', x: 84, z: 30, w: 3, h: 3 },
    { resource: 'iron', x: 58, z: 20, w: 3, h: 3 },
    { resource: 'iron', x: 24, z: 26, w: 4, h: 4 },
    { resource: 'rubber', x: 30, z: 90, w: 3, h: 4 },
    { resource: 'rubber', x: 96, z: 100, w: 3, h: 3 },
  ] satisfies ResourceNode[],
};
