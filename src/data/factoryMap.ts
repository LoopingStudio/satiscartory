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

/** Fixed starting map (64×64 cells of 2 m). The hub sits near the center. */
export const FACTORY_MAP = {
  hub: { x: 30, z: 30, rot: 0 as const },
  /** Player spawn, in cells (fractional allowed). */
  spawn: { x: 31.5, z: 27 },
  /** Garage terminal, relative to the hub anchor (cells). */
  garage: { x: 34.5, z: 31.5 },
  nodes: [
    { resource: 'iron', x: 24, z: 24, w: 3, h: 3 },
    { resource: 'iron', x: 37, z: 22, w: 3, h: 2 },
    { resource: 'rubber', x: 23, z: 36, w: 3, h: 3 },
    { resource: 'iron', x: 40, z: 38, w: 2, h: 3 },
    { resource: 'rubber', x: 44, z: 28, w: 2, h: 2 },
  ] satisfies ResourceNode[],
};
