import { FactorySim } from '../factory/sim/FactorySim';
import type { FactorySave } from '../factory/sim/types';
import type { CarInstance } from '../garage/assembly';
import type { TrackRecord } from '../race/records';

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

  constructor(sim?: FactorySim) {
    this.sim = sim ?? FactorySim.newGame();
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
    };
  }

  static fromSave(data: SaveData): GameState {
    const s = new GameState(FactorySim.fromSave(data.factory));
    s.player = data.player ?? null;
    s.cars = Array.isArray(data.cars) ? data.cars : [];
    // null = the loaner kart (a valid choice); fall back only when missing or dangling.
    const sel = data.selectedCarId;
    s.selectedCarId = sel === undefined ? (s.cars[0]?.id ?? null) : sel !== null && !s.cars.some((c) => c.id === sel) ? (s.cars[0]?.id ?? null) : sel;
    s.records = data.records ?? {};
    s.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
    s.objectives = data.objectives ?? {};
    s.carCounter = data.carCounter ?? s.cars.length;
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
  }
}
