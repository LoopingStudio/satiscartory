import { CAR_PARTS, blueprintById, type BlueprintId, type SlotDef, type SlotId } from '../data/blueprints';
import { ITEM_IDS, type Inventory as ItemCounts, type ItemId } from '../data/items';
import { clearSlotWear, condition, repairCredits, repairItems, slotWear, type WornSet } from '../data/wear';
import type { GameState } from '../state/GameState';
import { applyChange, findCar, partStock } from './actions';
import type { CarInstance } from './assembly';
import { buildComplete, newBuild, slotOf } from './build';
import { buildIn, rollOut } from './buildActions';
import { bayOccupant, type BayBlocker, type GarageSpot } from './parking';

/*
 * Wear actions of the garage on the game state (pure: no DOM, no three). A repair is paid in items (the kit of
 * data/wear.ts: backpack first, then the hub) or in credits (FactorySim.spend), all or nothing; it completes the
 * « repair » objective. A worn part never becomes a plain item without a paid repair: taken off a car or a build,
 * it goes to the reserve (state.worn) as a whole slot with its wear. Every action returns null or false without
 * changing anything when it cannot be done; callers persist and re-sync the physical cars after a change.
 */

/** How a repair is paid. */
export type Pay = 'items' | 'credits';

/** Price of a repair, both ways (items or credits). */
export interface RepairQuote {
  items: ItemCounts;
  credits: number;
}

/** Can the state pay a quote this way: what is missing (items), how many credits are short. */
export interface PayCheck {
  ok: boolean;
  missing?: ItemCounts;
  short?: number;
}

/** The repair of `n` parts of `item` worn `w` ‰ (a car's slot or a set of the reserve). */
export function setQuote(item: ItemId, n: number, w: number): RepairQuote {
  return { items: repairItems(item, n, w), credits: repairCredits(item, n, w) };
}

/** A slot of the car's blueprint with its installed part and that part's wear, null when unknown or empty. */
function installed(car: CarInstance, slotId: string): { slot: SlotDef; item: ItemId; wear: number } | null {
  const slot = blueprintById(car.blueprint)?.slots.find((s) => s.id === slotId);
  const item = slot ? car.parts[slot.id] : undefined;
  return slot && item ? { slot, item, wear: slotWear(car, slot.id) } : null;
}

/** Slots of the car whose part is worn, in the blueprint's order. */
function wornSlots(car: CarInstance): SlotDef[] {
  return (blueprintById(car.blueprint)?.slots ?? []).filter((s) => car.parts[s.id] && slotWear(car, s.id) > 0);
}

/** Repair of one slot of a car: null when the slot is empty, unknown or new. */
export function slotQuote(car: CarInstance, slotId: string): RepairQuote | null {
  const s = installed(car, slotId);
  return s && s.wear > 0 ? setQuote(s.item, s.slot.count, s.wear) : null;
}

/** « Tout réparer »: the sum of the quotes of every worn slot; null when the car is new. */
export function carQuote(car: CarInstance): RepairQuote | null {
  const slots = wornSlots(car);
  if (!slots.length) return null;
  const q: RepairQuote = { items: {}, credits: 0 };
  for (const s of slots) {
    const one = slotQuote(car, s.id)!;
    q.credits += one.credits;
    for (const id of ITEM_IDS) {
      const n = one.items[id];
      if (n) q.items[id] = (q.items[id] ?? 0) + n;
    }
  }
  return q;
}

/**
 * The most of each item that any of these quotes asks for: the garage's refresh key caps the stock at it, so that a
 * plate machine filling the hub does not redraw the panel while every « j'ai / il faut » shown stays the same.
 */
export function quoteCaps(quotes: readonly RepairQuote[]): ItemCounts {
  const caps: ItemCounts = {};
  for (const q of quotes) {
    for (const id of ITEM_IDS) {
      const n = q.items[id] ?? 0;
      if (n > (caps[id] ?? 0)) caps[id] = n;
    }
  }
  return caps;
}

/** The reserve as the garage lists it: sets of one item and count whose state shows the same %. */
export interface WornGroup {
  /** « wheel:4:42 »: item, count and state shown. Stable while the group lasts (pad focus, a pending sale). */
  key: string;
  /** The set the group's buttons act on, its most worn one (the first on a tie): the prices shown are its own. */
  set: WornSet;
  /** How many sets the group holds (« ×2 »). */
  count: number;
}

/**
 * The reserve grouped by (item, count, state shown), in CAR_PARTS order, then the least worn first. The sets are the
 * reserve's own objects (the actions find them by identity).
 */
export function wornGroups(worn: readonly WornSet[]): WornGroup[] {
  const groups = new Map<string, WornGroup>();
  for (const s of worn) {
    const key = `${s.item}:${s.n}:${condition(s.wear)}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { key, set: s, count: 1 });
    else {
      g.count++;
      if (s.wear > g.set.wear) g.set = s;
    }
  }
  const order = (s: WornSet) => CAR_PARTS.indexOf(s.item);
  return [...groups.values()].sort((a, b) => order(a.set) - order(b.set) || a.set.n - b.set.n || a.set.wear - b.set.wear);
}

/** The slot of `blueprint` a worn set fits (it takes the item, and as many as the set holds), null for none. */
export function slotForSet(blueprint: unknown, set: Pick<WornSet, 'item' | 'n'>): SlotDef | null {
  return blueprintById(blueprint)?.slots.find((s) => s.accepts.includes(set.item) && s.count === set.n) ?? null;
}

/** Whether the state can pay `q` this way (items: backpack + hub; credits: the sim's balance). */
export function payCheck(state: GameState, q: RepairQuote, pay: Pay): PayCheck {
  if (pay === 'items') {
    const missing = state.wallet().missingFor(q.items);
    return missing ? { ok: false, missing } : { ok: true };
  }
  const short = q.credits - state.sim.credits;
  return short > 0 ? { ok: false, short } : { ok: true };
}

/** Pays a quote, all or nothing (never a free repair: an empty quote is refused). What was paid, or null. */
function payQuote(state: GameState, q: RepairQuote, pay: Pay): Partial<RepairQuote> | null {
  if (!payCheck(state, q, pay).ok) return null;
  if (pay === 'credits') return state.sim.spend(q.credits, 'repair') ? { credits: q.credits } : null;
  const ids = ITEM_IDS.filter((id) => (q.items[id] ?? 0) > 0);
  if (!ids.length) return null;
  const wallet = state.wallet();
  for (const id of ids) wallet.remove(id, q.items[id]!);
  return { items: { ...q.items } };
}

/** Repairs one worn slot of a car (it is new again). Null (nothing paid) when there is nothing to repair or not enough to pay. */
export function repairCarSlot(state: GameState, carId: string, slotId: string, pay: Pay): { paid: Partial<RepairQuote> } | null {
  const car = findCar(state, carId);
  const q = car ? slotQuote(car, slotId) : null;
  if (!car || !q) return null;
  const paid = payQuote(state, q, pay);
  if (!paid) return null;
  clearSlotWear(car, slotId);
  state.objectives.repair = true;
  return { paid };
}

/** « Tout réparer »: every worn slot at once, paid in one go (all or nothing). Null when the car is new or the quote is not affordable. */
export function repairCar(state: GameState, carId: string, pay: Pay): { paid: Partial<RepairQuote>; slots: SlotId[] } | null {
  const car = findCar(state, carId);
  const q = car ? carQuote(car) : null;
  if (!car || !q) return null;
  const slots = wornSlots(car).map((s) => s.id);
  const paid = payQuote(state, q, pay);
  if (!paid) return null;
  for (const s of slots) clearSlotWear(car, s);
  state.objectives.repair = true;
  return { paid, slots };
}

/**
 * « Remplacer par du neuf »: new parts of the same kind from the stock (backpack first, then the hub) over worn
 * ones, which go to the reserve. Returns that worn set; null (nothing changed) when the slot is new, empty or
 * unknown, or the stock holds fewer parts than the slot takes.
 */
export function renewCarSlot(state: GameState, carId: string, slotId: string): WornSet | null {
  const car = findCar(state, carId);
  const s = car ? installed(car, slotId) : null;
  if (!car || !s || s.wear <= 0) return null;
  const before = partStock(state);
  const have = before[s.item] ?? 0;
  if (have < s.slot.count) return null;
  const set: WornSet = { item: s.item, n: s.slot.count, wear: s.wear };
  applyChange(state.wallet(), before, { ...before, [s.item]: have - s.slot.count });
  state.worn.push(set);
  clearSlotWear(car, slotId);
  return set;
}

/**
 * Repairs a set of the reserve: paid like a car's slot, its parts come back new (backpack first, overflow: hub;
 * `toHub` of them). Null when the set is not in the reserve or not enough to pay.
 */
export function repairWornSet(state: GameState, set: WornSet, pay: Pay): { paid: Partial<RepairQuote>; toHub: number } | null {
  const i = state.worn.indexOf(set);
  if (i < 0) return null;
  const paid = payQuote(state, setQuote(set.item, set.n, set.wear), pay);
  if (!paid) return null;
  state.worn.splice(i, 1);
  const toHub = applyChange(state.wallet(), {}, { [set.item]: set.n });
  state.objectives.repair = true;
  return { paid, toHub };
}

/** Sells a set of the reserve by its state (FactorySim.sellWorn). Null when it is not in the reserve or invalid. */
export function sellWornSet(state: GameState, set: WornSet): { price: number } | null {
  const i = state.worn.indexOf(set);
  if (i < 0) return null;
  const price = state.sim.sellWorn(set.item, set.n, set.wear);
  if (price === null) return null;
  state.worn.splice(i, 1);
  return { price };
}

/**
 * Puts a set of the reserve on a car (callers offer it for the car standing in the bay, like « Démonter »), in a
 * slot that takes it, with its wear. The parts it replaces go to the reserve when worn, to the backpack (overflow:
 * hub) when new. False when nothing changed (set not in the reserve, unknown car, slot that does not take it).
 */
export function installWornSet(state: GameState, carId: string, slotId: string, set: WornSet): boolean {
  const i = state.worn.indexOf(set);
  const car = findCar(state, carId);
  const slot = car ? blueprintById(car.blueprint)?.slots.find((s) => s.id === slotId) : undefined;
  if (i < 0 || !car || !slot || !slot.accepts.includes(set.item) || set.n !== slot.count) return false;
  const old = car.parts[slot.id];
  const oldWear = slotWear(car, slot.id);
  state.worn.splice(i, 1);
  if (old && oldWear > 0) state.worn.push({ item: old, n: slot.count, wear: oldWear });
  else if (old) applyChange(state.wallet(), {}, { [old]: slot.count });
  car.parts[slot.id] = set.item;
  (car.wear ??= {})[slot.id] = set.wear;
  return true;
}

/**
 * Puts a set of the reserve into an empty slot of the build in this garage, starting a build of `blueprint` when
 * the bay is empty (a car can be put together from worn sets alone). When every required slot is full the car rolls
 * out with the wear of its sets. Null when nothing changed: set not in the reserve, a car in the bay, a build of
 * another blueprint, a slot that does not take it or already holds parts.
 */
export function installWornInBuild(
  state: GameState,
  garage: GarageSpot,
  blueprint: BlueprintId,
  slotId: string,
  set: WornSet,
  blocker?: BayBlocker,
): { car: CarInstance | null } | null {
  const i = state.worn.indexOf(set);
  if (i < 0) return null;
  let build = buildIn(state, garage.id);
  const fresh = !build;
  if (!build) {
    if (!blueprintById(blueprint)?.buildable || bayOccupant(state.cars, garage, blocker)) return null;
    build = newBuild(garage.id, blueprint);
  } else if (build.blueprint !== blueprint) return null;
  const slot = slotOf(build, slotId);
  if (!slot || !slot.accepts.includes(set.item) || set.n !== slot.count || (build.parts[slot.id]?.n ?? 0) > 0) return null;
  state.worn.splice(i, 1);
  build.parts[slot.id] = { item: set.item, n: set.n, wear: set.wear };
  if (fresh) state.builds.push(build);
  return { car: buildComplete(build) ? rollOut(state, build, garage) : null };
}
