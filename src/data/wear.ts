import { WEAR } from './balance';
import { BLUEPRINTS, BLUEPRINT_IDS, blueprintById, isCarPart, type SlotDef, type SlotId } from './blueprints';
import { isItemId, type ItemId } from './items';

/*
 * Wear of the parts installed on a car (pure): integer thousandths per slot, 0 = new, WEAR.MAX = worn out. A new
 * part has no key, and a car without any wear has no `wear` at all (a new or repaired car, an old save). The cars
 * are typed by their shape (blueprint, parts, wear) so that the data needs nothing from the garage.
 */

/** Wear per slot (‰, integers 1..WEAR.MAX); a missing slot is new. */
export type CarWear = Partial<Record<SlotId, number>>;

/** A whole slot's worth of worn parts taken off a car (« 4 roues · 42 % »): the reserve of worn parts. */
export interface WornSet {
  item: ItemId;
  /** The slot's count: 4 wheels, 1 chassis… */
  n: number;
  /** ‰, 1..WEAR.MAX. */
  wear: number;
}

/** What wear reads of a car (a CarInstance). */
export interface WearCar {
  blueprint: string;
  parts: Readonly<Record<string, unknown>>;
  wear?: CarWear;
}

/** State shown for a wear (%): 100 only when new, 20 at the race limit (BLOCK_ABOVE), 0 worn out. */
export function condition(w = 0): number {
  const v = Number.isFinite(w) ? Math.min(WEAR.MAX, Math.max(0, w)) : 0;
  return Math.floor((WEAR.MAX - v) / 10);
}

/** Number of items of the slot that takes `item` (4 wheels, 4 panels, 1 otherwise); null for an item no slot takes. */
export function slotCountFor(item: ItemId): number | null {
  for (const id of BLUEPRINT_IDS) {
    for (const s of BLUEPRINTS[id].slots) if (s.accepts.includes(item)) return s.count;
  }
  return null;
}

/** Wear of a slot of `car` (0 when new or empty). */
export function slotWear(car: WearCar, slot: SlotId): number {
  return car.parts[slot] ? (car.wear?.[slot] ?? 0) : 0;
}

/** The most worn installed slot (the first one of the blueprint on a tie), null when new or of an unknown blueprint. No allocation. */
export function worstSlotOf(car: WearCar): SlotDef | null {
  const bp = blueprintById(car.blueprint);
  if (!bp || !car.wear) return null;
  let best: SlotDef | null = null;
  let most = 0;
  for (const s of bp.slots) {
    const w = slotWear(car, s.id);
    if (w > most) {
      most = w;
      best = s;
    }
  }
  return best;
}

/** Wear (‰) of the most worn installed slot, 0 when new. No allocation. */
export function worstWear(car: WearCar): number {
  const s = worstSlotOf(car);
  return s ? slotWear(car, s.id) : 0;
}

/** Installed slots worn above WEAR.BLOCK_ABOVE, in the blueprint's order (the car does not start a race). */
export function blockedSlots(car: WearCar): SlotId[] {
  const bp = blueprintById(car.blueprint);
  return bp ? bp.slots.filter((s) => slotWear(car, s.id) > WEAR.BLOCK_ABOVE).map((s) => s.id) : [];
}

/** The slot gets new parts (or none): its wear goes, and `wear` with it when nothing else is worn. */
export function clearSlotWear(car: { wear?: CarWear }, slot: string): void {
  const w = car.wear;
  if (!w || !Object.hasOwn(w, slot)) return;
  delete w[slot as SlotId];
  if (Object.keys(w).length === 0) delete car.wear;
}

/** Wear read from untrusted save data, an integer clamped to 0..WEAR.MAX (null: not a finite number). */
function wearValue(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(WEAR.MAX, Math.max(0, Math.round(v))) : null;
}

/**
 * A car's wear from untrusted save data: only the slots of its blueprint that hold a part the slot takes, finite
 * numbers rounded and clamped to 0..WEAR.MAX, zeros dropped. A value that is not a number counts as absent (new).
 * Undefined when nothing is left (the car keeps no `wear` key).
 */
export function sanitizeWear(blueprint: unknown, parts: Readonly<Record<string, unknown>>, raw: unknown): CarWear | undefined {
  const bp = blueprintById(blueprint);
  if (!bp || !raw || typeof raw !== 'object') return undefined;
  let out: CarWear | undefined;
  for (const s of bp.slots) {
    if (!Object.hasOwn(raw, s.id)) continue;
    const item = parts[s.id];
    if (!isItemId(item) || !s.accepts.includes(item)) continue;
    const w = wearValue((raw as Record<string, unknown>)[s.id]);
    if (w) (out ??= {})[s.id] = w;
  }
  return out;
}

/**
 * A worn set from untrusted save data: a car part, the count of its slot, a wear rounded and clamped to 1..WEAR.MAX
 * (one that is not a number is worn out: a set is never repaired by a broken save). Null when invalid.
 */
export function sanitizeWornSet(raw: unknown): WornSet | null {
  if (!raw || typeof raw !== 'object') return null;
  const { item, n, wear } = raw as Record<string, unknown>;
  if (!isItemId(item) || !isCarPart(item)) return null;
  const count = slotCountFor(item);
  if (count === null || n !== count) return null;
  return { item, n: count, wear: Math.max(1, wearValue(wear) ?? WEAR.MAX) };
}
