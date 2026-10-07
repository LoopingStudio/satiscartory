import type { ModelKey } from '../core/assets/manifest.gen';
import type { ItemId } from './items';

export type SlotId = 'chassis' | 'engine' | 'wheels' | 'panels' | 'spoiler';

export interface SlotDef {
  id: SlotId;
  name: string;
  /** Items that can be installed in this slot (first = default). */
  accepts: ItemId[];
  /** Number of items consumed (e.g. 4 wheels). */
  count: number;
  optional?: boolean;
}

/** Base physical stats of a car body before parts. */
export interface BaseStats {
  massKg: number;
  /** Total engine force at the wheels (N). */
  engineN: number;
  topSpeedKmh: number;
  /** Tire grip multiplier (1 = normal). */
  grip: number;
  /** Aerodynamic downforce coefficient (N per (m/s)²). */
  downforce: number;
  /** Max steering angle at standstill (degrees). */
  steerDeg: number;
  brakeN: number;
}

export type BlueprintId = 'kart' | 'sport' | 'loaner';

export interface Blueprint {
  id: BlueprintId;
  name: string;
  /** Can be assembled in the garage (the loaner is always available instead). */
  buildable: boolean;
  description: string;
  model: ModelKey;
  slots: SlotDef[];
  base: BaseStats;
  /** Where the engine shows on a car under construction (over the front or the rear axle). */
  engineMount?: 'front' | 'rear';
}

export const BLUEPRINTS: Record<BlueprintId, Blueprint> = {
  kart: {
    id: 'kart',
    name: 'Kart Oopi',
    buildable: true,
    description: 'Léger et nerveux : accélère fort et tourne serré, mais plafonne vite.',
    model: 'car-kit/kart-oopi',
    slots: [
      { id: 'chassis', name: 'Châssis', accepts: ['chassis'], count: 1 },
      { id: 'engine', name: 'Moteur', accepts: ['engine'], count: 1 },
      { id: 'wheels', name: 'Roues', accepts: ['wheel', 'wheel_racing'], count: 4 },
    ],
    base: { massKg: 320, engineN: 3600, topSpeedKmh: 150, grip: 1.05, downforce: 0.6, steerDeg: 34, brakeN: 4200 },
    engineMount: 'rear',
  },
  sport: {
    id: 'sport',
    name: 'Sportive',
    buildable: true,
    description: 'Lourde et rapide : vitesse de pointe élevée, stable, mais demande de bien freiner.',
    model: 'car-kit/sedan-sports',
    slots: [
      { id: 'chassis', name: 'Châssis', accepts: ['chassis'], count: 1 },
      { id: 'engine', name: 'Moteur', accepts: ['engine'], count: 1 },
      { id: 'wheels', name: 'Roues', accepts: ['wheel', 'wheel_racing'], count: 4 },
      { id: 'panels', name: 'Carrosserie', accepts: ['panel'], count: 4 },
      { id: 'spoiler', name: 'Aileron', accepts: ['spoiler'], count: 1, optional: true },
    ],
    base: { massKg: 1050, engineN: 8800, topSpeedKmh: 245, grip: 0.95, downforce: 1.6, steerDeg: 27, brakeN: 14000 },
    engineMount: 'front',
  },
  loaner: {
    id: 'loaner',
    name: 'Kart de location',
    buildable: false,
    description: 'Prêté par le circuit pour débuter. Lent et mou : construis le tien !',
    model: 'car-kit/kart-oobi',
    slots: [],
    base: { massKg: 360, engineN: 2700, topSpeedKmh: 120, grip: 0.92, downforce: 0.4, steerDeg: 30, brakeN: 3800 },
  },
};

export const BLUEPRINT_IDS = Object.keys(BLUEPRINTS) as BlueprintId[];
