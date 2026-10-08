import { FACTORY_HZ } from '../config/constants';
import type { Recipe } from './recipes';
import type { ItemId } from './items';

/** Factory ticks per minute. */
export const TICKS_PER_MIN = FACTORY_HZ * 60;

/** How many times per minute something that takes `ticks` happens at full speed. */
export function perMinute(ticks: number): number {
  return TICKS_PER_MIN / ticks;
}

/** A recipe's inputs and outputs per minute at full speed (one machine). */
export function recipeRates(r: Recipe): { inputs: { item: ItemId; perMin: number }[]; outputs: { item: ItemId; perMin: number }[] } {
  const crafts = perMinute(r.ticks);
  return {
    inputs: r.inputs.map((s) => ({ item: s.item, perMin: s.count * crafts })),
    outputs: r.outputs.map((s) => ({ item: s.item, perMin: s.count * crafts })),
  };
}

/** A rate as shown: « 7,5 », « 0,4 », « 20 » (one decimal under 10, whole above; no « ,0 »). */
export function rateNumber(n: number): string {
  const v = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return String(v).replace('.', ',');
}

/** « 7,5/min ». */
export function perMinLabel(n: number): string {
  return `${rateNumber(n)}/min`;
}
