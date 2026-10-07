import { FactorySim } from '../factory/sim/FactorySim';
import type { FactorySave } from '../factory/sim/types';
import { sanitizePose, type CarInstance } from '../garage/assembly';
import { parkUnplaced, type BayBlocker } from '../garage/parking';
import type { TrackRecord } from '../race/records';
import { Inventory, Wallet, type Stack } from './Inventory';
import { LEGACY_MAP_OFFSET } from '../data/factoryMap';
import { FACTORY_CELL } from '../config/constants';
import { TIERS, isUnlocked } from '../data/tiers';
import type { BuildingType } from '../data/buildings';
import type { Inventory as ItemCounts } from '../data/items';

export interface Settings {
  mouseSensitivity: number;
  invertY: boolean;
  shadows: boolean;
}

export const DEFAULT_SETTINGS: Settings = { mouseSensitivity: 1, invertY: false, shadows: true };

export interface PlayerSave {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface SaveData {
  version: 1;
  savedAt: number;
  factory: FactorySave;
  player?: PlayerSave | null;
  cars?: CarInstance[];
  selectedCarId?: string | null;
  records?: Record<string, TrackRecord>;
  settings?: Partial<Settings>;
  objectives?: Record<string, boolean>;
  carCounter?: number;
  /** Player backpack slots. */
  inventory?: (Stack | null)[];
  /** Hub tiers unlocked. Missing in saves older than the tiers: everything stays unlocked. */
  tier?: number;
  /** Number of tiers that existed when saving (absent before the garage tier: 4). */
  tierMax?: number;
}

/** Persistent game state shared by all modes (the factory keeps running in every mode). */
export class GameState {
  sim: FactorySim;
  player: PlayerSave | null = null;
  cars: CarInstance[] = [];
  selectedCarId: string | null = null;
  records: Record<string, TrackRecord> = {};
  settings: Settings = { ...DEFAULT_SETTINGS };
  objectives: Record<string, boolean> = {};
  carCounter = 0;
  /** Dev/test states (stress layout) are never saved. */
  ephemeral = false;
  /** Player backpack. */
  inventory = new Inventory();
  /** Number of hub tiers unlocked (TIERS); a new game starts at 0. */
  tier = 0;

  constructor(sim?: FactorySim) {
    this.sim = sim ?? FactorySim.newGame();
  }

  /** Backpack first, then the hub (pays costs, receives refunds and pickups). */
  wallet(): Wallet {
    return new Wallet(this.inventory, this.sim.hub);
  }

  /** Parks the cars that have no place yet in free garage bays; returns them. */
  parkCars(blocker?: BayBlocker): CarInstance[] {
    const garages = [...this.sim.buildings.values()].filter((b) => b.type === 'garage');
    return parkUnplaced(this.cars, garages, blocker);
  }

  isUnlocked(type: BuildingType): boolean {
    return isUnlocked(type, this.tier);
  }

  /**
   * Pays the next tier from the wallet (backpack first, then hub) and unlocks it.
   * `ok: false` with `missing` when it cannot be paid, without `missing` when every tier is unlocked.
   */
  unlockNextTier(): { ok: boolean; missing?: ItemCounts } {
    const next = TIERS[this.tier];
    if (!next) return { ok: false };
    const wallet = this.wallet();
    const missing = wallet.missingFor(next.cost);
    if (missing) return { ok: false, missing };
    for (const [item, n] of Object.entries(next.cost) as [keyof ItemCounts, number][]) wallet.remove(item, n);
    this.tier++;
    return { ok: true };
  }

  get selectedCar(): CarInstance | null {
    return this.cars.find((c) => c.id === this.selectedCarId) ?? null;
  }

  serialize(): SaveData {
    return {
      version: 1,
      savedAt: Date.now(),
      factory: this.sim.serialize(),
      player: this.player,
      cars: this.cars,
      selectedCarId: this.selectedCarId,
      records: this.records,
      settings: this.settings,
      objectives: this.objectives,
      carCounter: this.carCounter,
      inventory: this.inventory.serialize(),
      tier: this.tier,
      tierMax: TIERS.length,
    };
  }

  static fromSave(data: SaveData): GameState {
    const s = new GameState(FactorySim.fromSave(data.factory));
    s.player = data.player ?? null;
    // Saves from the 64×64 map: the factory is shifted on load, the player follows.
    if (s.player && (data.factory.version ?? 1) < 3) {
      s.player = { ...s.player, x: s.player.x + LEGACY_MAP_OFFSET * FACTORY_CELL, z: s.player.z + LEGACY_MAP_OFFSET * FACTORY_CELL };
    }
    s.cars = Array.isArray(data.cars)
      ? data.cars.filter((c) => c && typeof c.id === 'string' && typeof c.blueprint === 'string').map((c) => ({ ...c, parts: c.parts ?? {}, pose: sanitizePose(c.pose) }))
      : [];
    // null = the loaner kart (a valid choice); fall back only when missing or dangling.
    const sel = data.selectedCarId;
    s.selectedCarId = sel === undefined ? (s.cars[0]?.id ?? null) : sel !== null && !s.cars.some((c) => c.id === sel) ? (s.cars[0]?.id ?? null) : sel;
    s.records = data.records ?? {};
    s.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
    s.objectives = data.objectives ?? {};
    s.carCounter = data.carCounter ?? s.cars.length;
    s.inventory = Inventory.fromSave(data.inventory);
    // Saves from before the tiers keep every building available, and so does a save that had every
    // tier of its version (tiers added later, like the garage, come unlocked).
    const t = data.tier;
    const savedMax = typeof data.tierMax === 'number' ? data.tierMax : 4;
    s.tier = typeof t === 'number' && Number.isFinite(t) ? (t >= savedMax ? TIERS.length : Math.max(0, Math.min(TIERS.length, Math.floor(t)))) : TIERS.length;
    return s;
  }

  /** Replaces this state's content in place (keeps references held by modes valid). */
  replaceWith(other: GameState): void {
    this.sim = other.sim;
    this.player = other.player;
    this.cars = other.cars;
    this.selectedCarId = other.selectedCarId;
    this.records = other.records;
    this.settings = other.settings;
    this.objectives = other.objectives;
    this.carCounter = other.carCounter;
    this.ephemeral = other.ephemeral;
    this.inventory = other.inventory;
    this.tier = other.tier;
  }
}
