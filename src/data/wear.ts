import { SALE, WEAR } from './balance';
import { BLUEPRINTS, BLUEPRINT_IDS, CAR_PARTS, blueprintById, isCarPart, type SlotDef, type SlotId } from './blueprints';
import { ITEM_IDS, isItemId, type Inventory as ItemCounts, type ItemId } from './items';
import { RECIPES } from './recipes';
import { PART_VALUES, carPrice } from './sales';

/*
 * Wear of the parts installed on a car (pure): integer thousandths per slot, 0 = new, WEAR.MAX = worn out. A new
 * part has no key, and a car without any wear has no `wear` at all (a new or repaired car, an old save). The cars
 * are typed by their shape (blueprint, parts, wear) so that the data needs nothing from the garage. Below: the
 * prices of the wear (repairs in items or credits, worn sets and worn cars sold).
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

/**
 * Writes the state shown (%) of each slot of the car's blueprint into `out` (blueprint order, −1 for an empty slot);
 * true when one of them changed. Allocates nothing once `out` has its length: a check for every frame.
 */
export function shownConditions(car: WearCar, out: number[]): boolean {
  const slots = blueprintById(car.blueprint)?.slots;
  if (!slots) return false;
  let changed = out.length !== slots.length;
  out.length = slots.length;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!;
    const c = car.parts[s.id] ? condition(slotWear(car, s.id)) : -1;
    if (out[i] !== c) {
      out[i] = c;
      changed = true;
    }
  }
  return changed;
}

/** What a HUD shows of a car's wear: its most worn slot (null when new) and that slot's state (%). */
export interface ShownWorst {
  slot: SlotId | null;
  pct: number;
}

/**
 * Writes the car's most worn slot and its state shown (%, 100 when new) into `out`; true when either changed (always
 * the first time from `{ slot: null, pct: -1 }`). Allocates nothing: a check for every frame (the race pill).
 */
export function shownWorst(car: WearCar, out: ShownWorst): boolean {
  const s = worstSlotOf(car);
  const slot = s ? s.id : null;
  const pct = condition(s ? slotWear(car, s.id) : 0);
  if (slot === out.slot && pct === out.pct) return false;
  out.slot = slot;
  out.pct = pct;
  return true;
}

/** Installed slots worn above WEAR.BLOCK_ABOVE, in the blueprint's order (the car does not start a race). */
export function blockedSlots(car: WearCar): SlotId[] {
  const bp = blueprintById(car.blueprint);
  return bp ? bp.slots.filter((s) => slotWear(car, s.id) > WEAR.BLOCK_ABOVE).map((s) => s.id) : [];
}

/** The car does not start a race: an installed part is worn above WEAR.BLOCK_ABOVE (spoiler included). No allocation. */
export function isBlocked(car: WearCar): boolean {
  return worstWear(car) > WEAR.BLOCK_ABOVE;
}

/** Why a car does not start a race: its slots worn above WEAR.BLOCK_ABOVE (a fuel ticket may add its own kind). */
export interface RaceBlock<C extends WearCar = WearCar> {
  kind: 'wear';
  car: C;
  /** In the blueprint's order. */
  slots: SlotId[];
}

/**
 * What keeps `car` from starting a race, null when it may (and for the loaner, `null`). Taking a worn-out optional
 * part off (the spoiler, « Aucun ») lifts it.
 */
export function raceBlocker<C extends WearCar>(car: C | null): RaceBlock<C> | null {
  if (!car) return null;
  const slots = blockedSlots(car);
  return slots.length ? { kind: 'wear', car, slots } : null;
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
 * Wear of a worn set (the reserve, a build slot) from untrusted save data: rounded and clamped to 1..WEAR.MAX; one
 * that is not a number is worn out (a set is never repaired by a broken save).
 */
export function sanitizeSetWear(raw: unknown): number {
  return Math.max(1, wearValue(raw) ?? WEAR.MAX);
}

/** A worn set from untrusted save data: a car part, the count of its slot, a wear in 1..WEAR.MAX (sanitizeSetWear). Null when invalid. */
export function sanitizeWornSet(raw: unknown): WornSet | null {
  if (!raw || typeof raw !== 'object') return null;
  const { item, n, wear } = raw as Record<string, unknown>;
  if (!isItemId(item) || !isCarPart(item)) return null;
  const count = slotCountFor(item);
  if (count === null || n !== count) return null;
  return { item, n: count, wear: sanitizeSetWear(wear) };
}

// ------------------------------------------------------------------ prices (repairs, worn sets, worn cars)

/**
 * Repair kit of one part, ×2 to stay in integers, from its assembler recipe: the tires of a wheel (1 per wheel, 2
 * per racing wheel), half of the recipe of any other part. Repairing is always cheaper than making new parts.
 */
const KIT2: Readonly<Partial<Record<ItemId, ItemCounts>>> = (() => {
  const wheels = new Set<ItemId>(Object.values(BLUEPRINTS).flatMap((bp) => bp.slots.filter((s) => s.id === 'wheels').flatMap((s) => s.accepts)));
  const out: Partial<Record<ItemId, ItemCounts>> = {};
  for (const item of CAR_PARTS) {
    const recipe = RECIPES.find((r) => r.machine === 'assembler' && r.outputs.some((o) => o.item === item));
    const kit: ItemCounts = {};
    for (const s of recipe?.inputs ?? []) {
      if (wheels.has(item) && s.item !== 'tire') continue;
      kit[s.item] = (kit[s.item] ?? 0) + (wheels.has(item) ? 2 * s.count : s.count);
    }
    out[item] = kit;
  }
  return out;
})();

/** Integer a / b rounded up (a ≥ 0, b > 0). */
const ceilDiv = (a: number, b: number) => Math.floor((a + b - 1) / b);

/**
 * Items that repair `n` parts worn `w` ‰ (a slot, or a set of the reserve): ⌈kit × n × w / 1000⌉ of each item of
 * the kit, so at least 1 of each from 1 ‰ on; nothing for a new part (or one no kit covers). In ITEM_IDS order.
 */
export function repairItems(item: ItemId, n: number, w: number): ItemCounts {
  const out: ItemCounts = {};
  const kit = KIT2[item];
  if (!kit || !(w > 0) || !(n > 0)) return out;
  for (const id of ITEM_IDS) {
    const k = kit[id];
    if (k) out[id] = ceilDiv(k * n * Math.min(WEAR.MAX, w), 2 * WEAR.MAX);
  }
  return out;
}

/**
 * Credits that repair `n` parts worn `w` ‰: the kit's value (PART_VALUES) with the dealer's margin, pro rata of the
 * wear, rounded up to SALE.ROUND, so at least 10 cr from 1 ‰ on; 0 for a new part.
 */
export function repairCredits(item: ItemId, n: number, w: number): number {
  const kit = KIT2[item];
  if (!kit || !(w > 0) || !(n > 0)) return 0;
  let v2 = 0;
  for (const [id, k] of Object.entries(kit) as [ItemId, number][]) v2 += k * PART_VALUES[id];
  return Math.ceil((SALE.MARGIN_NUM * v2 * n * Math.min(WEAR.MAX, w)) / (SALE.MARGIN_DEN * 2 * WEAR.MAX * SALE.ROUND)) * SALE.ROUND;
}

/**
 * A worn set sold from the reserve: the parts' value (without the dealer's margin) × their state,
 * ⌊value × n × (1000 − w) / 1000⌋ credits (0 when worn out). Selling a car's parts one set at a time always brings
 * in less than selling the car (at least a quarter of their value less).
 */
export function wornSetPrice(item: ItemId, n: number, w: number): number {
  const v = Math.max(0, Math.min(WEAR.MAX, Number.isFinite(w) ? w : WEAR.MAX));
  return Math.max(0, Math.floor((PART_VALUES[item] * n * (WEAR.MAX - v)) / WEAR.MAX));
}

/**
 * Price of a car worn as `wear` (the dealer's and the garage's): the new price minus the credits that repair every
 * installed part, never below 0. Repairing with credits and then selling brings in exactly the same.
 */
export function wornCarPrice(blueprint: unknown, parts: Readonly<Record<string, unknown>>, wear?: Readonly<CarWear>): number {
  const price = carPrice(blueprint, parts);
  const bp = blueprintById(blueprint);
  if (!bp || !wear) return price;
  let repair = 0;
  for (const s of bp.slots) {
    const item = parts[s.id];
    if (!isItemId(item) || !s.accepts.includes(item)) continue;
    repair += repairCredits(item, s.count, wear[s.id] ?? 0);
  }
  return Math.max(0, price - repair);
}
