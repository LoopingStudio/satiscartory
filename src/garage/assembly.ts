import type { ItemId, Inventory } from '../data/items';
import type { CarSpec } from '../car/stats';
import { BLUEPRINTS, type Blueprint, type BlueprintId, type SlotDef } from '../data/blueprints';

/** A car built in the garage from parts produced by the factory. */
export interface CarInstance {
  id: string;
  name: string;
  blueprint: string;
  /** Installed part per slot (slot id → item id). */
  parts: Record<string, ItemId>;
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
  const bp = BLUEPRINTS[car.blueprint as BlueprintId];
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
  const bp = BLUEPRINTS[car.blueprint as BlueprintId];
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
