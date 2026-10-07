import { computeCarStats, statBars, type CarSpec, type StatBars } from '../car/stats';
import { el } from './dom';

export const STAT_LABELS: Record<keyof StatBars, string> = { speed: 'Vitesse', accel: 'Accélération', grip: 'Adhérence', weight: 'Poids' };

/**
 * Stat bars of a car (0..10) and a summary line (top speed, mass, grip). With `compare`, each bar shows
 * its difference to that car, green when better (lighter is better for the weight).
 */
export function carStatsBlock(spec: CarSpec, compare: CarSpec | null = null, cls = ''): HTMLElement {
  const stats = computeCarStats(spec);
  const bars = statBars(stats);
  const ref = compare ? statBars(computeCarStats(compare)) : null;
  const block = el('div', { class: `stat-bars ${cls}` });
  for (const k of Object.keys(STAT_LABELS) as (keyof StatBars)[]) {
    const d = ref ? bars[k] - ref[k] : 0;
    block.appendChild(
      el('div', { class: 'stat-bar' },
        el('span', {}, STAT_LABELS[k]),
        el('div', { class: 'bar' }, el('div', { style: `width:${bars[k] * 10}%` })),
        ref && Math.abs(d) > 0.05 ? el('span', { class: `small ${(k === 'weight' ? d < 0 : d > 0) ? 'good' : 'bad'}` }, `${d > 0 ? '+' : ''}${d.toFixed(1)}`) : el('span', {}),
      ),
    );
  }
  block.appendChild(el('div', { class: 'muted small' }, `${Math.round(stats.topSpeedMs * 3.6)} km/h max · ${Math.round(stats.massKg)} kg · adhérence ×${stats.grip.toFixed(2)}`));
  return block;
}
