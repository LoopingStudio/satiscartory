import type { ModelKey } from '../core/assets/manifest.gen';

export const ITEM_IDS = [
  'iron_ore',
  'latex',
  'plate',
  'bolt',
  'tire',
  'chassis',
  'engine',
  'wheel',
  'wheel_racing',
  'panel',
  'spoiler',
] as const;
export type ItemId = (typeof ITEM_IDS)[number];

export interface ItemDef {
  id: ItemId;
  name: string;
  /** Model shown on belts and in UI previews. */
  model: ModelKey;
  /** Uniform scale applied to the model on belts (model units → meters). */
  beltScale: number;
  /** Optional instance tint (hex) for raw resources that reuse a generic model. */
  tint?: number;
  /** Rotation about Y on belts (radians). */
  beltYaw?: number;
  /** Lift above the belt surface in meters. */
  beltLift?: number;
}

export const ITEMS: Record<ItemId, ItemDef> = {
  iron_ore: { id: 'iron_ore', name: 'Minerai de fer', model: 'factory-kit/box-small', beltScale: 0.9, tint: 0xb5653e },
  latex: { id: 'latex', name: 'Latex', model: 'factory-kit/box-small', beltScale: 0.9, tint: 0x2f3142 },
  plate: { id: 'plate', name: 'Plaque', model: 'car-kit/debris-plate-a', beltScale: 1.2 },
  bolt: { id: 'bolt', name: 'Boulon', model: 'car-kit/debris-bolt', beltScale: 2.2 },
  tire: { id: 'tire', name: 'Pneu', model: 'car-kit/debris-tire', beltScale: 1.4, beltLift: 0.42 },
  chassis: { id: 'chassis', name: 'Châssis', model: 'car-kit/debris-drivetrain-axle', beltScale: 1.0, beltYaw: Math.PI / 2 },
  engine: { id: 'engine', name: 'Moteur', model: 'car-kit/debris-drivetrain', beltScale: 0.85 },
  wheel: { id: 'wheel', name: 'Roue', model: 'car-kit/wheel-default', beltScale: 1.4, beltLift: 0.42 },
  wheel_racing: { id: 'wheel_racing', name: 'Roue racing', model: 'car-kit/wheel-racing', beltScale: 1.4, beltLift: 0.42 },
  panel: { id: 'panel', name: 'Panneau', model: 'car-kit/debris-door', beltScale: 1.0, beltYaw: Math.PI / 2 },
  spoiler: { id: 'spoiler', name: 'Aileron', model: 'car-kit/debris-spoiler-a', beltScale: 1.0 },
};

export type Inventory = Partial<Record<ItemId, number>>;

export function isItemId(v: unknown): v is ItemId {
  return typeof v === 'string' && (ITEM_IDS as readonly string[]).includes(v);
}
