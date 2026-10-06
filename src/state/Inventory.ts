import { ITEMS, isItemId, type Inventory as ItemCounts, type ItemId } from '../data/items';
import { INVENTORY } from '../data/inventory';
import type { ItemSink, ItemSource } from '../factory/sim/types';

export interface Stack {
  item: ItemId;
  count: number;
}

/** Player backpack: fixed number of slots, per-item stack sizes. Pure. */
export class Inventory implements ItemSource, ItemSink {
  readonly slots: (Stack | null)[];

  constructor(size: number = INVENTORY.SLOTS) {
    this.slots = Array.from({ length: size }, () => null);
  }

  count(item: ItemId): number {
    let n = 0;
    for (const s of this.slots) if (s?.item === item) n += s.count;
    return n;
  }

  /** How many more of `item` would fit. */
  room(item: ItemId): number {
    const max = ITEMS[item].stack;
    let n = 0;
    for (const s of this.slots) {
      if (!s) n += max;
      else if (s.item === item) n += max - s.count;
    }
    return n;
  }

  add(item: ItemId, n: number): number {
    if (n <= 0) return 0;
    const max = ITEMS[item].stack;
    let left = n;
    // Top up existing stacks first, then fill empty slots.
    for (const s of this.slots) {
      if (left === 0) break;
      if (s?.item === item && s.count < max) {
        const k = Math.min(max - s.count, left);
        s.count += k;
        left -= k;
      }
    }
    for (let i = 0; i < this.slots.length && left > 0; i++) {
      if (this.slots[i]) continue;
      const k = Math.min(max, left);
      this.slots[i] = { item, count: k };
      left -= k;
    }
    return n - left;
  }

  remove(item: ItemId, n: number): number {
    let left = n;
    // Take from the smallest stacks last-to-first so full stacks stay tidy.
    for (let i = this.slots.length - 1; i >= 0 && left > 0; i--) {
      const s = this.slots[i];
      if (s?.item !== item) continue;
      const k = Math.min(s.count, left);
      s.count -= k;
      left -= k;
      if (s.count === 0) this.slots[i] = null;
    }
    return n - left;
  }

  /** Empties one slot, returning its stack. */
  takeSlot(i: number): Stack | null {
    const s = this.slots[i] ?? null;
    this.slots[i] = null;
    return s;
  }

  get usedSlots(): number {
    return this.slots.filter(Boolean).length;
  }

  totals(): ItemCounts {
    const t: ItemCounts = {};
    for (const s of this.slots) if (s) t[s.item] = (t[s.item] ?? 0) + s.count;
    return t;
  }

  serialize(): (Stack | null)[] {
    return this.slots.map((s) => (s ? { ...s } : null));
  }

  /** Restores from untrusted save data (unknown items dropped, stacks clamped). */
  static fromSave(data: unknown, size: number = INVENTORY.SLOTS): Inventory {
    const inv = new Inventory(size);
    if (!Array.isArray(data)) return inv;
    data.slice(0, size).forEach((s, i) => {
      if (!s || typeof s !== 'object') return;
      const { item, count } = s as Stack;
      if (!isItemId(item) || typeof count !== 'number' || !(count > 0)) return;
      inv.slots[i] = { item, count: Math.min(Math.floor(count), ITEMS[item].stack) };
    });
    return inv;
  }
}

/**
 * Backpack first, then the hub: counts add up, removals drain the backpack
 * before the hub, and incoming items fill the backpack then overflow to the hub.
 */
export class Wallet implements ItemSource, ItemSink {
  constructor(
    readonly primary: ItemSource & ItemSink,
    readonly fallback: ItemSource & ItemSink,
  ) {}

  count(item: ItemId): number {
    return this.primary.count(item) + this.fallback.count(item);
  }

  remove(item: ItemId, n: number): number {
    const a = this.primary.remove(item, n);
    return a + (a < n ? this.fallback.remove(item, n - a) : 0);
  }

  add(item: ItemId, n: number): number {
    const a = this.primary.add(item, n);
    return a + (a < n ? this.fallback.add(item, n - a) : 0);
  }

  /** Missing quantities to pay `cost`, or null if affordable. */
  missingFor(cost: ItemCounts): ItemCounts | null {
    const missing: ItemCounts = {};
    let any = false;
    for (const [item, n] of Object.entries(cost) as [ItemId, number][]) {
      const have = this.count(item);
      if (have < n) {
        missing[item] = n - have;
        any = true;
      }
    }
    return any ? missing : null;
  }

  totals(items: readonly ItemId[]): ItemCounts {
    const t: ItemCounts = {};
    for (const i of items) {
      const n = this.count(i);
      if (n) t[i] = n;
    }
    return t;
  }
}
