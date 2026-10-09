import type { ItemId, Inventory } from '../data/items';
import type { CarSpec } from '../car/stats';
import { BLUEPRINTS, blueprintById, type Blueprint, type BlueprintId, type SlotDef } from '../data/blueprints';
import type { CarWear } from '../data/wear';

/** Where a car stands in the factory (meters; yaw 0 faces +Z, like Vehicle spawns). */
export interface CarPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** A car built in the garage from parts produced by the factory. */
export interface CarInstance {
  id: string;
  name: string;
  blueprint: string;
  /** Installed part per slot (slot id → item id). */
  parts: Record<string, ItemId>;
  /** Position in the factory; null/absent = not placed yet (parks in the first free garage). */
  pose?: CarPose | null;
  /** Wear of the installed parts (data/wear.ts); absent on a new car, never an empty object. */
  wear?: CarWear;
}

/** Restores a pose from untrusted save data (null if invalid). */
export function sanitizePose(p: unknown): CarPose | null {
  if (!p || typeof p !== 'object') return null;
  const { x, y, z, yaw } = p as CarPose;
  return [x, y, z, yaw].every((v) => typeof v === 'number' && Number.isFinite(v)) ? { x, y, z, yaw } : null;
}

/** Always-available starter car (no parts needed). */
export const LOANER_SPEC: CarSpec = { blueprint: 'loaner', parts: {} };

/** Slot id → chosen item, or null to leave an optional slot empty. */
export type PartChoices = Record<string, ItemId | null>;

export function defaultChoices(bp: Blueprint): PartChoices {
  const c: PartChoices = {};
  for (const s of bp.slots) c[s.id] = s.optional ? null : s.accepts[0]!;
  return c;
}

/** Default choices upgraded to what the stock allows (racing wheels, spoiler). */
export function bestChoices(bp: Blueprint, storage: Inventory): PartChoices {
  const c = defaultChoices(bp);
  for (const s of bp.slots) {
    // Prefer the last (best) accepted item that is in stock in sufficient quantity.
    const best = [...s.accepts].reverse().find((item) => (storage[item] ?? 0) >= s.count);
    if (best) c[s.id] = best;
    else if (s.optional) c[s.id] = null;
  }
  return c;
}

/** Items consumed by assembling `bp` with `choices`. */
export function costOf(bp: Blueprint, choices: PartChoices): Inventory {
  const cost: Inventory = {};
  for (const s of bp.slots) {
    const item = choices[s.id];
    if (!item) continue;
    cost[item] = (cost[item] ?? 0) + s.count;
  }
  return cost;
}

export interface AssemblyCheck {
  ok: boolean;
  /** Missing quantity per item. */
  missing: Inventory;
  /** Required slots left empty / invalid choices. */
  invalidSlots: string[];
}

export function checkAssembly(storage: Inventory, bpId: BlueprintId, choices: PartChoices): AssemblyCheck {
  const bp = BLUEPRINTS[bpId];
  const invalidSlots: string[] = [];
  if (!bp.buildable) invalidSlots.push('*');
  for (const s of bp.slots) {
    const item = choices[s.id];
    if (!item) {
      if (!s.optional) invalidSlots.push(s.id);
    } else if (!s.accepts.includes(item)) invalidSlots.push(s.id);
  }
  const missing: Inventory = {};
  for (const [item, n] of Object.entries(costOf(bp, choices)) as [ItemId, number][]) {
    const have = storage[item] ?? 0;
    if (have < n) missing[item] = n - have;
  }
  return { ok: invalidSlots.length === 0 && Object.keys(missing).length === 0, missing, invalidSlots };
}

/**
 * Assembles a car: removes its parts from `storage` (mutated) and returns the
 * new car, or null if parts are missing.
 */
export function assemble(storage: Inventory, bpId: BlueprintId, choices: PartChoices, serial: number): CarInstance | null {
  if (!checkAssembly(storage, bpId, choices).ok) return null;
  const bp = BLUEPRINTS[bpId];
  for (const [item, n] of Object.entries(costOf(bp, choices)) as [ItemId, number][]) storage[item] = (storage[item] ?? 0) - n;
  const parts: Record<string, ItemId> = {};
  for (const s of bp.slots) {
    const item = choices[s.id];
    if (item) parts[s.id] = item;
  }
  return { id: `car-${serial}`, name: `${bp.name} n°${serial}`, blueprint: bpId, parts };
}

/** Dismantles a car: its parts go back to `storage` (mutated). */
export function disassemble(storage: Inventory, car: CarInstance): void {
  const bp = blueprintById(car.blueprint);
  if (!bp) return;
  for (const s of bp.slots) {
    const item = car.parts[s.id];
    if (item) storage[item] = (storage[item] ?? 0) + s.count;
  }
}

/**
 * Swaps the part in one slot (e.g. racing wheels, add a spoiler): the new
 * parts come from storage, the old ones go back. Returns false if not enough.
 */
export function swapPart(storage: Inventory, car: CarInstance, slotId: string, item: ItemId | null): boolean {
  const bp = blueprintById(car.blueprint);
  const slot: SlotDef | undefined = bp?.slots.find((s) => s.id === slotId);
  if (!slot) return false;
  if (item === null && !slot.optional) return false;
  if (item !== null && !slot.accepts.includes(item)) return false;
  const old = car.parts[slotId] ?? null;
  if (old === item) return true;
  if (item !== null && (storage[item] ?? 0) < slot.count) return false;
  if (item !== null) storage[item] = (storage[item] ?? 0) - slot.count;
  if (old) storage[old] = (storage[old] ?? 0) + slot.count;
  if (item) car.parts[slotId] = item;
  else delete car.parts[slotId];
  return true;
}

export function specOf(car: CarInstance | null): CarSpec {
  return car ? { blueprint: car.blueprint as BlueprintId, parts: car.parts } : LOANER_SPEC;
}
