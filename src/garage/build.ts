import { BLUEPRINTS, type BlueprintId, type SlotDef } from '../data/blueprints';
import { isItemId, type Inventory as ItemCounts, type ItemId } from '../data/items';
import { sanitizeSetWear, type CarWear, type WornSet } from '../data/wear';
import type { CarInstance } from './assembly';

/*
 * A car put together in a garage bay part by part (« chantier »), pure: parts go in slot by slot as they
 * come out of the factory (two wheels now, the engine later), and the car rolls out when every required
 * slot is full. Storage is a plain count snapshot (mutated); the state actions pay it from the wallet.
 */

/** Installed parts of one slot: the item and how many of the slot's count. */
export interface BuildSlot {
  item: ItemId;
  n: number;
  /** A worn set put in from the reserve (always a whole slot): its wear (‰, 1..1000). Absent: new parts. */
  wear?: number;
}

/** A car under construction in a garage's bay. */
export interface CarBuild {
  /** Garage (building id) whose bay holds it. */
  garage: number;
  blueprint: BlueprintId;
  /** Installed parts per slot id (absent: nothing installed). */
  parts: Record<string, BuildSlot>;
}

export function newBuild(garage: number, blueprint: BlueprintId): CarBuild {
  return { garage, blueprint, parts: {} };
}

export function slotOf(build: CarBuild, slotId: string): SlotDef | undefined {
  return BLUEPRINTS[build.blueprint].slots.find((s) => s.id === slotId);
}

/** Parts installed and needed over the required slots (optional ones are extras). */
export function buildProgress(build: CarBuild): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const s of BLUEPRINTS[build.blueprint].slots) {
    if (s.optional) continue;
    total += s.count;
    done += Math.min(s.count, build.parts[s.id]?.n ?? 0);
  }
  return { done, total };
}

/** Every required slot full: the car can roll out. */
export function buildComplete(build: CarBuild): boolean {
  const p = buildProgress(build);
  return p.done === p.total;
}

/** Nothing installed yet. */
export function buildEmpty(build: CarBuild): boolean {
  return Object.values(build.parts).every((p) => p.n <= 0);
}

/**
 * Installs up to the slot's missing count of `item`, taken from `storage` (mutated). A slot holds one kind
 * of item: another kind is refused while some are installed (take them off first). Returns how many went in.
 */
export function installPart(storage: ItemCounts, build: CarBuild, slotId: string, item: ItemId): number {
  const slot = slotOf(build, slotId);
  if (!slot || !slot.accepts.includes(item)) return 0;
  const cur = build.parts[slotId];
  if (cur && cur.n > 0 && cur.item !== item) return 0;
  const have = cur && cur.item === item ? cur.n : 0;
  const k = Math.max(0, Math.min(slot.count - have, storage[item] ?? 0));
  if (k === 0) return 0;
  storage[item] = (storage[item] ?? 0) - k;
  build.parts[slotId] = { item, n: have + k };
  return k;
}

/**
 * Takes a slot's parts back: new parts into `storage` (mutated), a worn set into the reserve `worn` (mutated, it
 * keeps its wear). Returns how many parts.
 */
export function removePart(storage: ItemCounts, build: CarBuild, slotId: string, worn: WornSet[]): number {
  const cur = build.parts[slotId];
  if (!cur) return 0;
  delete build.parts[slotId];
  if (cur.n > 0 && cur.wear) worn.push({ item: cur.item, n: cur.n, wear: cur.wear });
  else if (cur.n > 0) storage[cur.item] = (storage[cur.item] ?? 0) + cur.n;
  return Math.max(0, cur.n);
}

/** Every installed part back: new ones into `storage`, worn sets into the reserve `worn` (both mutated). */
export function refundBuild(storage: ItemCounts, build: CarBuild, worn: WornSet[]): void {
  for (const id of Object.keys(build.parts)) removePart(storage, build, id, worn);
}

/**
 * The finished car of a complete build (null otherwise); an optional slot comes along only when full. A worn set
 * keeps its wear on the car (the `wear` key only when one is worn: a new car has none).
 */
export function carFromBuild(build: CarBuild, serial: number): CarInstance | null {
  if (!buildComplete(build)) return null;
  const bp = BLUEPRINTS[build.blueprint];
  const parts: Record<string, ItemId> = {};
  let wear: CarWear | undefined;
  for (const s of bp.slots) {
    const p = build.parts[s.id];
    if (!p || p.n < s.count) continue;
    parts[s.id] = p.item;
    if (p.wear) (wear ??= {})[s.id] = p.wear;
  }
  const car: CarInstance = { id: `car-${serial}`, name: `${bp.name} n°${serial}`, blueprint: build.blueprint, parts };
  if (wear) car.wear = wear;
  return car;
}

/** Parts left over when a build turns into a car: an optional slot only partly filled (they go back). */
export function leftovers(build: CarBuild): ItemCounts {
  const out: ItemCounts = {};
  for (const s of BLUEPRINTS[build.blueprint].slots) {
    const p = build.parts[s.id];
    if (p && p.n > 0 && p.n < s.count) out[p.item] = (out[p.item] ?? 0) + p.n;
  }
  return out;
}

/** What the bay shows: the body (see-through until the chassis is in, bare metal until every panel is), wheels, extras. */
export interface BuildLook {
  body: 'ghost' | 'bare' | 'solid';
  /** Wheels installed (they go on front first, left first). */
  wheels: number;
  wheelItem: ItemId | null;
  engine: boolean;
  spoiler: boolean;
}

export function buildLook(build: CarBuild): BuildLook {
  const bp = BLUEPRINTS[build.blueprint];
  const n = (id: string) => build.parts[id]?.n ?? 0;
  const full = (id: string) => {
    const s = bp.slots.find((x) => x.id === id);
    return !!s && n(id) >= s.count;
  };
  const hasPanels = bp.slots.some((s) => s.id === 'panels');
  return {
    body: n('chassis') === 0 ? 'ghost' : hasPanels && !full('panels') ? 'bare' : 'solid',
    wheels: n('wheels'),
    wheelItem: build.parts.wheels?.item ?? null,
    engine: n('engine') > 0,
    spoiler: full('spoiler'),
  };
}

/**
 * Restores a build from untrusted save data: known blueprint and slots, accepted items, counts clamped; null if
 * invalid. A worn set (`wear` present and not 0) keeps a wear in 1..1000 (one that is not a number is worn out) and
 * must fill its slot: a partial one is dropped, never turned into new parts.
 */
export function sanitizeBuild(raw: unknown): CarBuild | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<CarBuild>;
  const bp = typeof r.blueprint === 'string' ? BLUEPRINTS[r.blueprint as BlueprintId] : undefined;
  if (!bp || !bp.buildable || typeof r.garage !== 'number' || !Number.isInteger(r.garage)) return null;
  const parts: Record<string, BuildSlot> = {};
  for (const s of bp.slots) {
    const p = (r.parts as Record<string, unknown> | undefined)?.[s.id] as Partial<BuildSlot> | undefined;
    if (!p || !isItemId(p.item) || !s.accepts.includes(p.item) || typeof p.n !== 'number' || !Number.isFinite(p.n)) continue;
    const n = Math.max(0, Math.min(s.count, Math.floor(p.n)));
    if (n <= 0) continue;
    if (p.wear === undefined || p.wear === 0) parts[s.id] = { item: p.item, n };
    else if (n === s.count) parts[s.id] = { item: p.item, n, wear: sanitizeSetWear(p.wear) };
  }
  return { garage: r.garage, blueprint: bp.id, parts };
}
