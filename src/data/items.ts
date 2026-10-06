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
  /** Plural, lowercase (for counts > 1 in UI texts). */
  plural: string;
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
  iron_ore: { id: 'iron_ore', name: 'Minerai de fer', plural: 'minerais de fer', model: 'factory-kit/box-small', beltScale: 0.9, tint: 0xb5653e },
  latex: { id: 'latex', name: 'Latex', plural: 'latex', model: 'factory-kit/box-small', beltScale: 0.9, tint: 0x2f3142 },
  plate: { id: 'plate', name: 'Plaque', plural: 'plaques', model: 'car-kit/debris-plate-a', beltScale: 1.2 },
  bolt: { id: 'bolt', name: 'Boulon', plural: 'boulons', model: 'car-kit/debris-bolt', beltScale: 2.2 },
  tire: { id: 'tire', name: 'Pneu', plural: 'pneus', model: 'car-kit/debris-tire', beltScale: 1.4, beltLift: 0.42 },
  chassis: { id: 'chassis', name: 'Châssis', plural: 'châssis', model: 'car-kit/debris-drivetrain-axle', beltScale: 1.0, beltYaw: Math.PI / 2 },
  engine: { id: 'engine', name: 'Moteur', plural: 'moteurs', model: 'car-kit/debris-drivetrain', beltScale: 0.85 },
  wheel: { id: 'wheel', name: 'Roue', plural: 'roues', model: 'car-kit/wheel-default', beltScale: 1.4, beltLift: 0.42 },
  wheel_racing: { id: 'wheel_racing', name: 'Roue racing', plural: 'roues racing', model: 'car-kit/wheel-racing', beltScale: 1.4, beltLift: 0.42 },
  panel: { id: 'panel', name: 'Panneau', plural: 'panneaux', model: 'car-kit/debris-door', beltScale: 1.0, beltYaw: Math.PI / 2 },
  spoiler: { id: 'spoiler', name: 'Aileron', plural: 'ailerons', model: 'car-kit/debris-spoiler-a', beltScale: 1.0 },
};

export type Inventory = Partial<Record<ItemId, number>>;

/** "3 plaques", "1 plaque". */
export function countLabel(item: ItemId, n: number): string {
  const d = ITEMS[item];
  return `${n} ${n > 1 ? d.plural : d.name.toLowerCase()}`;
}

export function isItemId(v: unknown): v is ItemId {
  return typeof v === 'string' && (ITEM_IDS as readonly string[]).includes(v);
}
