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
  type: 'smelter' | 'press' | 'assembler';
  recipe: string | null;
  inBuf: Inventory;
  outBuf: ItemId[];
  progress: number;
  status: MachineStatus;
}

export interface HubB extends Base {
  type: 'hub';
}

/** Garage: no items, no ports. Which car stands in it is derived from the cars' poses (GameState). */
export interface GarageB extends Base {
  type: 'garage';
}

export type Building = ConveyorB | DrillB | MachineB | GarageB | HubB;

export interface Link {
  target: number;
  /** World cell of the target that receives the item. */
  cx: number;
  cz: number;
  /** World side of the target cell the item enters through. */
  entry: Side;
}

/** Where a building of some type stands (or would stand). */
export interface Placement {
  type: BuildingType;
  x: number;
  z: number;
  rot: Rot;
}

/** Links a planned building would make (FactorySim.planLinks); planned buildings have ids -1, -2… */
export interface PlanLinks {
  out: Link | null;
  /** Buildings that would feed it, with their link. */
  in: { id: number; link: Link }[];
}

/**
 * A building's port in world terms. `linked`: an output carrying its items, an input something feeds;
 * `blocked`: the cell in front is taken by a building that does not connect through it (or off the map);
 * `unused`: an output with nothing in front while another output of the building is linked (a building
 * outputs through one port only); `free`: an empty cell in front, waiting for a conveyor.
 */
export interface PortInfo {
  /** Building cell of the port and the world side it faces. */
  cx: number;
  cz: number;
  side: Side;
  dir: 'in' | 'out';
  state: 'linked' | 'blocked' | 'unused' | 'free';
  /** Building in front of the port, if any. */
  neighbor: number | null;
}

export interface FactorySave {
  /**
   * 1: machines 1×2, items along their length. 2: machines 2×1, items across.
   * 3: 128×128 map (older saves are shifted by LEGACY_MAP_OFFSET). Migrated on load.
   */
  version: 1 | 2 | 3;
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

/** Recipe machines (smelter, constructor, assembler). */
export function isMachine(b: Building | undefined): b is MachineB {
  return b !== undefined && (b.type === 'smelter' || b.type === 'press' || b.type === 'assembler');
}

/** Buildings with an output buffer (drills and recipe machines). */
export function isProducer(b: Building | undefined): b is DrillB | MachineB {
  return b !== undefined && (b.type === 'drill' || isMachine(b));
}

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
