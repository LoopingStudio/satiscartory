import { BLUEPRINTS, type BlueprintId } from '../data/blueprints';
import { PART_MODIFIERS } from '../data/parts';
import type { ItemId } from '../data/items';

/** Final physical stats of an assembled car. */
export interface CarStats {
  massKg: number;
  engineN: number;
  topSpeedMs: number;
  grip: number;
  downforce: number;
  steerRad: number;
  brakeN: number;
}

/** 0..10 bars shown in the garage. */
export interface StatBars {
  speed: number;
  accel: number;
  grip: number;
  weight: number;
}

export interface CarSpec {
  blueprint: BlueprintId;
  /** slot id → installed item (missing optional slots are empty). */
  parts: Partial<Record<string, ItemId>>;
}

export function computeCarStats(spec: CarSpec): CarStats {
  const bp = BLUEPRINTS[spec.blueprint];
  let mass = bp.base.massKg;
  let grip = bp.base.grip;
  let top = bp.base.topSpeedKmh / 3.6;
  let engine = bp.base.engineN;
  let downforce = bp.base.downforce;
  for (const slot of bp.slots) {
    const item = spec.parts[slot.id];
    if (!item) continue;
    const mod = PART_MODIFIERS[item];
    if (!mod) continue;
    for (let i = 0; i < slot.count; i++) {
      mass += mod.massKg ?? 0;
      grip *= mod.gripMul ?? 1;
      top *= mod.topSpeedMul ?? 1;
      engine *= mod.engineMul ?? 1;
      downforce += mod.downforce ?? 0;
    }
  }
  return {
    massKg: mass,
    engineN: engine,
    topSpeedMs: top,
    grip,
    downforce,
    steerRad: (bp.base.steerDeg * Math.PI) / 180,
    brakeN: bp.base.brakeN,
  };
}

const clamp10 = (v: number) => Math.max(0, Math.min(10, v));

export function statBars(s: CarStats): StatBars {
  return {
    speed: clamp10(((s.topSpeedMs * 3.6 - 100) / 170) * 10),
    accel: clamp10(((s.engineN / s.massKg - 4) / 9) * 10),
    grip: clamp10(((s.grip - 0.7) / 0.7) * 10),
    weight: clamp10((s.massKg / 1300) * 10),
  };
}
