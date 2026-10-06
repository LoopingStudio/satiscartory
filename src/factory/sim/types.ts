import type { BuildingType, Side } from '../../data/buildings';
import type { Inventory, ItemId } from '../../data/items';
import type { ResourceId } from '../../data/factoryMap';
import type { Rot } from './dirs';

export interface BeltItem {
  item: ItemId;
  /** Position along the tile path, 0..SEG (integer units). */
  pos: number;
  /** Position at the previous tick (may be negative right after a hand-off), for interpolation. */
  prev: number;
  /** Local side the item entered through (2 = back, 1 = right, 3 = left). */
  from: Side;
}

export type MachineStatus = 'noRecipe' | 'idle' | 'working' | 'blocked';

interface Base {
  id: number;
  x: number;
  z: number;
  rot: Rot;
  /** Placed without paying (dev layouts): dismantling refunds no cost. */
  free?: true;
}

export interface ConveyorB extends Base {
  type: 'conveyor';
  /** Ordered front (highest pos) first. */
  items: BeltItem[];
  /** Local side of the last accepted feeder (for round-robin merging); -1 = none. */
  lastFrom: number;
}

export interface DrillB extends Base {
  type: 'drill';
  resource: ResourceId | null;
  progress: number;
  outBuf: ItemId[];
}

export interface MachineB extends Base {
  type: 'press' | 'assembler';
  recipe: string | null;
  inBuf: Inventory;
  outBuf: ItemId[];
  progress: number;
  status: MachineStatus;
}

export interface HubB extends Base {
  type: 'hub';
}

export type Building = ConveyorB | DrillB | MachineB | HubB;

export interface Link {
  target: number;
  /** World cell of the target that receives the item. */
  cx: number;
  cz: number;
  /** World side of the target cell the item enters through. */
  entry: Side;
}

export interface FactorySave {
  /** 1: machines 1×2, items along their length. 2: machines 2×1, items across (migrated on load). */
  version: 1 | 2;
  tick: number;
  nextId: number;
  storage: Inventory;
  delivered: Inventory;
  crafted: Inventory;
  buildings: Building[];
}

export type PlaceError = 'outOfBounds' | 'occupied' | 'needsNode' | 'cost' | 'notBuildable';

export interface PlaceCheck {
  ok: boolean;
  error?: PlaceError;
  cells: [number, number][];
  /** Missing items when error === 'cost'. */
  missing?: Inventory;
  /** For drills: which resource the drill would mine. */
  resource?: ResourceId | null;
}

export type BuildingTypeOf<T extends BuildingType> = Extract<Building, { type: T }>;

/** Something items can be taken from (hub storage, player backpack…). */
export interface ItemSource {
  count(item: ItemId): number;
  /** Removes up to n items; returns how many were removed. */
  remove(item: ItemId, n: number): number;
}

/** Something items can be put into. */
export interface ItemSink {
  /** Adds up to n items; returns how many were accepted. */
  add(item: ItemId, n: number): number;
}
