import { WEAR } from '../data/balance';
import { condition } from '../data/wear';
import { pct, wearTone } from '../data/wearText';
import { el } from './dom';

/**
 * Wear gauge of a part (full = new): a bar coloured by threshold (green, orange above WEAR.WARN_ABOVE, red above
 * WEAR.BLOCK_ABOVE) with a tick at the race limit. `mini` for the lists; `title` defaults to « État : 46 % ».
 */
export function wearGauge(w = 0, size: 'full' | 'mini' = 'full', title = `État : ${pct(w)}`): HTMLElement {
  return el('span', { class: `wear-gauge ${wearTone(w)}${size === 'mini' ? ' mini' : ''}`, title },
    el('i', { style: `width:${condition(w)}%` }),
    el('b', { style: `left:${condition(WEAR.BLOCK_ABOVE)}%` }),
  );
}

/** « 46 % » in the gauge's colour. */
export function wearPct(w = 0): HTMLElement {
  return el('b', { class: `wear-pct ${wearTone(w)}` }, pct(w));
}
