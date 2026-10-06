import type { ItemId } from './items';

/** Effect of one installed item on the car (applied once per item). */
export interface PartModifier {
  massKg?: number;
  /** Multipliers (1 = no change). */
  gripMul?: number;
  topSpeedMul?: number;
  engineMul?: number;
  /** Additive downforce coefficient. */
  downforce?: number;
  label: string;
}

export const PART_MODIFIERS: Partial<Record<ItemId, PartModifier>> = {
  chassis: { label: 'Châssis standard' },
  engine: { label: 'Moteur standard' },
  wheel: { massKg: 0, label: 'Roue standard' },
  // Applied per wheel: 4 racing wheels ≈ +26% grip.
  wheel_racing: { massKg: 3, gripMul: 1.06, label: 'Roue racing : +6 % d’adhérence chacune' },
  panel: { massKg: 18, topSpeedMul: 1.015, label: 'Panneau : carrosserie plus aérodynamique' },
  spoiler: { massKg: 12, downforce: 2.4, topSpeedMul: 0.975, gripMul: 1.04, label: 'Aileron : beaucoup d’appui, un peu moins de pointe' },
};
