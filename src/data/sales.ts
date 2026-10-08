import { DRILL, SALE } from './balance';
import { BLUEPRINT_IDS, BLUEPRINTS, CAR_PARTS, blueprintById, type BlueprintId } from './blueprints';
import { RESOURCES } from './factoryMap';
import { ITEMS, ITEM_IDS, isItemId, type Inventory, type ItemId } from './items';
import { RECIPES } from './recipes';

/*
 * Car sales (« Concession » and the garage's « Vendre »), pure. A part is worth its materials plus its machine
 * time, in ticks: raw ore and latex the drill's period, anything else the inputs and ticks of its machine recipe
 * divided by the number it makes (bench recipes, a slow start-up shortcut, never count). A car sells for the
 * value of its parts × SALE.MARGIN_NUM / SALE.MARGIN_DEN, rounded to SALE.ROUND credits.
 */

/** A complete car: blueprint and installed part per slot (like CarInstance). */
export interface CarConfig {
  blueprint: BlueprintId;
  parts: Record<string, ItemId>;
}

/** A car a stock can make: its parts, what it consumes and what it sells for. */
export interface Sale extends CarConfig {
  cost: Inventory;
  price: number;
}

function itemValues(): Record<ItemId, number> {
  const raw = new Set<ItemId>(Object.values(RESOURCES).map((r) => r.item));
  const memo = new Map<ItemId, number>();
  const visiting = new Set<ItemId>();
  const value = (item: ItemId): number => {
    const known = memo.get(item);
    if (known !== undefined) return known;
    if (raw.has(item)) return DRILL.PERIOD;
    if (visiting.has(item)) return Infinity;
    visiting.add(item);
    let best = Infinity;
    for (const r of RECIPES) {
      if (r.machine === 'bench' || !r.outputs.some((o) => o.item === item)) continue;
      const made = r.outputs.reduce((n, o) => n + o.count, 0);
      best = Math.min(best, (r.inputs.reduce((n, i) => n + value(i.item) * i.count, 0) + r.ticks) / made);
    }
    visiting.delete(item);
    memo.set(item, best);
    return best;
  };
  const out = {} as Record<ItemId, number>;
  for (const id of ITEM_IDS) {
    const v = value(id);
    out[id] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

/** Value of each item in machine ticks (0: nothing makes it). */
export const PART_VALUES: Readonly<Record<ItemId, number>> = itemValues();

/** Items a car is made of: each slot's part × its count. Unknown blueprints and misplaced parts count for nothing. */
export function carCost(blueprint: unknown, parts: Readonly<Record<string, unknown>>): Inventory {
  const cost: Inventory = {};
  const bp = blueprintById(blueprint);
  if (!bp) return cost;
  for (const s of bp.slots) {
    const item = parts[s.id];
    if (!isItemId(item) || !s.accepts.includes(item)) continue;
    cost[item] = (cost[item] ?? 0) + s.count;
  }
  return cost;
}

/** Value of a car's parts, in machine ticks. */
export function partsValue(blueprint: unknown, parts: Readonly<Record<string, unknown>>): number {
  let v = 0;
  for (const [item, n] of Object.entries(carCost(blueprint, parts)) as [ItemId, number][]) v += PART_VALUES[item] * n;
  return v;
}

/** Sale price in credits: parts × margin, rounded to the nearest SALE.ROUND (halves up). */
export function carPrice(blueprint: unknown, parts: Readonly<Record<string, unknown>>): number {
  const v = partsValue(blueprint, parts);
  return Math.floor((2 * v * SALE.MARGIN_NUM + SALE.MARGIN_DEN * SALE.ROUND) / (2 * SALE.MARGIN_DEN * SALE.ROUND)) * SALE.ROUND;
}

function allSales(): Sale[] {
  const sales: Sale[] = [];
  for (const id of BLUEPRINT_IDS) {
    const bp = BLUEPRINTS[id];
    if (!bp.buildable) continue;
    let configs: Record<string, ItemId>[] = [{}];
    for (const s of bp.slots) {
      const choices: (ItemId | null)[] = [...s.accepts, ...(s.optional ? [null] : [])];
      configs = configs.flatMap((c) => choices.map((item) => (item ? { ...c, [s.id]: item } : c)));
    }
    for (const parts of configs) sales.push({ blueprint: id, parts, cost: carCost(id, parts), price: carPrice(id, parts) });
  }
  // Stable: equal prices keep the blueprint and slot order.
  return sales.sort((a, b) => b.price - a.price);
}

/** Every complete car of the buildable blueprints, the most expensive first. */
export const CAR_SALES: readonly Sale[] = allSales();

function fits(stock: Readonly<Inventory>, cost: Inventory): number {
  let n = Infinity;
  for (const [item, k] of Object.entries(cost) as [ItemId, number][]) n = Math.min(n, Math.floor((stock[item] ?? 0) / k));
  return Number.isFinite(n) ? n : 0;
}

/** The most profitable car a stock can make (null: not even a kart). */
export function bestSale(stock: Readonly<Inventory>): Sale | null {
  return CAR_SALES.find((s) => fits(stock, s.cost) > 0) ?? null;
}

export interface CarPlan {
  /** Cars, the most expensive first, with how many of each. */
  cars: { sale: Sale; n: number }[];
  /** Number of cars. */
  count: number;
  /** Parts they use. */
  parts: Inventory;
  /** What they sell for. */
  total: number;
}

/**
 * Every car a stock makes when the best one is taken again and again (the dealer's rule), without mutating it.
 * The stock only shrinks, so a car that no longer fits never fits again: each one is taken in bulk, in price
 * order. This also makes the most cars: each needs a chassis, an engine and 4 wheels of one sort.
 */
export function planCars(stock: Readonly<Inventory>): CarPlan {
  const left: Inventory = { ...stock };
  const plan: CarPlan = { cars: [], count: 0, parts: {}, total: 0 };
  for (const sale of CAR_SALES) {
    const n = fits(left, sale.cost);
    if (n <= 0) continue;
    for (const [item, k] of Object.entries(sale.cost) as [ItemId, number][]) {
      left[item] = (left[item] ?? 0) - n * k;
      plan.parts[item] = (plan.parts[item] ?? 0) + n * k;
    }
    plan.cars.push({ sale, n });
    plan.count += n;
    plan.total += n * sale.price;
  }
  return plan;
}

/**
 * « Charger »: the parts to take from `available` (backpack + hub) so that the dealer, with what it already
 * holds (`stock`, the car being assembled aside), can make every complete car the whole pool allows.
 * `cars` and `total` count only what the load adds (a stock that already makes a car is not counted again).
 */
export function planLoad(stock: Readonly<Inventory>, available: Readonly<Inventory>): { load: Inventory; items: number; cars: number; total: number } {
  const pool: Inventory = { ...stock };
  for (const p of CAR_PARTS) {
    const n = available[p] ?? 0;
    if (n > 0) pool[p] = (pool[p] ?? 0) + n;
  }
  const all = planCars(pool);
  const mine = planCars(stock);
  const load: Inventory = {};
  let items = 0;
  for (const p of CAR_PARTS) {
    const k = Math.min((all.parts[p] ?? 0) - (stock[p] ?? 0), available[p] ?? 0);
    if (k <= 0) continue;
    load[p] = k;
    items += k;
  }
  return { load, items, cars: all.count - mine.count, total: all.total - mine.total };
}

/** The car closest to complete (fewest parts missing; on a tie the cheapest) and what it misses. */
export function nearestSale(stock: Readonly<Inventory>): { sale: Sale; missing: Inventory } {
  let best: { sale: Sale; missing: Inventory; n: number } | null = null;
  for (let i = CAR_SALES.length - 1; i >= 0; i--) {
    const sale = CAR_SALES[i]!;
    const missing: Inventory = {};
    let n = 0;
    for (const [item, k] of Object.entries(sale.cost) as [ItemId, number][]) {
      const m = k - (stock[item] ?? 0);
      if (m > 0) {
        missing[item] = m;
        n += m;
      }
    }
    if (!best || n < best.n) best = { sale, missing, n };
  }
  return { sale: best!.sale, missing: best!.missing };
}

/** A complete car from untrusted save data, or null (unknown or unbuildable blueprint, missing or wrong part). */
export function sanitizeCar(raw: unknown): CarConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const { blueprint, parts } = raw as { blueprint?: unknown; parts?: unknown };
  const bp = blueprintById(blueprint);
  if (!bp?.buildable || !parts || typeof parts !== 'object') return null;
  const clean: Record<string, ItemId> = {};
  for (const s of bp.slots) {
    const item = (parts as Record<string, unknown>)[s.id];
    if (item === undefined || item === null) {
      if (!s.optional) return null;
      continue;
    }
    if (!isItemId(item) || !s.accepts.includes(item)) return null;
    clean[s.id] = item;
  }
  return { blueprint: bp.id, parts: clean };
}

/** « 4 480 cr »: groups of three digits split by a plain space (the UI keeps it on one line). */
export function formatCredits(n: number): string {
  const digits = String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${n < 0 ? '-' : ''}${digits} cr`;
}

/** « Sportive (roues racing, aileron) »: the name, then every part beyond the basic car. */
export function carLabel(blueprint: BlueprintId, parts: Readonly<Record<string, ItemId>>): string {
  const bp = BLUEPRINTS[blueprint];
  const extras = bp.slots.flatMap((s) => {
    const item = parts[s.id];
    if (!item || (!s.optional && item === s.accepts[0])) return [];
    return [s.count > 1 ? ITEMS[item].plural : ITEMS[item].name.toLowerCase()];
  });
  return extras.length ? `${bp.name} (${extras.join(', ')})` : bp.name;
}

export interface PriceLine {
  blueprint: BlueprintId;
  /** Basic car: the first part of every required slot. */
  parts: Record<string, ItemId>;
  price: number;
  /** What each better or optional part adds to the basic price. */
  bonuses: { slot: string; item: ItemId; label: string; bonus: number }[];
}

/** Basic price of each buildable blueprint and what each option adds (differences of carPrice). */
export function priceList(): PriceLine[] {
  return BLUEPRINT_IDS.filter((id) => BLUEPRINTS[id].buildable).map((id) => {
    const bp = BLUEPRINTS[id];
    const parts: Record<string, ItemId> = {};
    for (const s of bp.slots) if (!s.optional) parts[s.id] = s.accepts[0]!;
    const price = carPrice(id, parts);
    const bonuses = bp.slots.flatMap((s) =>
      (s.optional ? s.accepts : s.accepts.slice(1)).map((item) => ({
        slot: s.id,
        item,
        label: s.count > 1 ? ITEMS[item].plural : ITEMS[item].name.toLowerCase(),
        bonus: carPrice(id, { ...parts, [s.id]: item }) - price,
      })),
    );
    return { blueprint: id, parts, price, bonuses };
  });
}
