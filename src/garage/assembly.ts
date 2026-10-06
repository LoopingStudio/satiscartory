import type { ItemId } from '../data/items';

/** A car built in the garage from parts produced by the factory. */
export interface CarInstance {
  id: string;
  name: string;
  blueprint: string;
  /** Installed part per slot (slot id → item id). */
  parts: Record<string, ItemId>;
}
