import { WEAR } from './balance';
import type { SlotId } from './blueprints';
import { condition, slotWear, worstSlotOf, type WearCar } from './wear';

/*
 * Texts of the wear (pure, French UI). The slots' genders differ (les roues, la carrosserie, le châssis, le moteur,
 * l'aileron): a sentence about a slot goes through a table, never a shared ending. What a HUD reads every frame
 * allocates nothing but its string: the words are static, the worst slot is found without a list.
 */

export type WearTone = 'good' | 'warn' | 'bad';

/** Colour of a wear: green, orange above WEAR.WARN_ABOVE, red above WEAR.BLOCK_ABOVE (the race limit). */
export function wearTone(w = 0): WearTone {
  return w > WEAR.BLOCK_ABOVE ? 'bad' : w > WEAR.WARN_ABOVE ? 'warn' : 'good';
}

/** Lower-case word of each slot, in a sentence (« roues 46 % »). */
export const SLOT_WORD: Record<SlotId, string> = { chassis: 'châssis', engine: 'moteur', wheels: 'roues', panels: 'carrosserie', spoiler: 'aileron' };

/** State shown for a wear: « 46 % ». */
export function pct(w?: number): string {
  return `${condition(w)} %`;
}

/** A car's state by its most worn part (« roues 46 % »), null when it is new. */
export function stateText(car: WearCar): string | null {
  const s = worstSlotOf(car);
  return s ? `${SLOT_WORD[s.id]} ${pct(slotWear(car, s.id))}` : null;
}

/** `s` with its first letter in capitals (« état : … » → « État : … »). */
export function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Pad tip of a car row in the garage, the pieces that apply only: « Voiture de course · état : roues 46 % »,
 * « État : roues 46 % », « Voiture de course »; undefined for none. `state` is the car's stateText.
 */
export function carRowTip(racing: boolean, state: string | null): string | undefined {
  const tip = [racing ? 'Voiture de course' : '', state ? `état : ${state}` : ''].filter((t) => t).join(' · ');
  return tip ? capFirst(tip) : undefined;
}
