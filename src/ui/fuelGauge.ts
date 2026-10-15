import { FUEL } from '../data/balance';
import { fuelPct, fuelTone, fuelUsed, isDry, litersLeft, tankLiters, type FuelCar } from '../data/fuel';
import { el } from './dom';

/**
 * Fuel gauge (full = a full tank): a bar coloured by level (green, orange under 25 %, red in the reserve) with a tick
 * at the reserve (the race limit). Reuses the wear gauge's look. `mini` for the lists and the HUD.
 */
export function fuelGauge(used = 0, size: 'full' | 'mini' = 'full', title = `Essence : ${fuelPct(used)} %`): HTMLElement {
  return el('span', { class: `wear-gauge fuel ${fuelTone(used)}${size === 'mini' ? ' mini' : ''}`, title },
    el('i', { style: `width:${fuelPct(used)}%` }),
    el('b', { style: `left:${fuelPct(FUEL.BLOCK_ABOVE)}%` }),
  );
}

/** « Essence 62 % · 6,2 L » (« Panne sèche » once dry); null for a car without a tank. */
export function fuelText(car: FuelCar): string | null {
  if (tankLiters(car.blueprint) <= 0) return null;
  if (isDry(car)) return 'Panne sèche';
  return `Essence ${fuelPct(fuelUsed(car))} % · ${litersLeft(car).toLocaleString('fr-FR')} L`;
}

/**
 * Fuel pill of the race HUD and of the factory's driving hint: a mini gauge and « Essence 62 % · 6,2 L ». Called every
 * frame, it touches the DOM only when the percentage shown changes.
 */
export class FuelPill {
  readonly el: HTMLElement;
  private readonly gauge = fuelGauge(0, 'mini', '');
  private readonly bar = this.gauge.firstElementChild as HTMLElement;
  private readonly text = el('span');
  private shown = -1;

  constructor() {
    this.el = el('div', { class: 'race-wear race-fuel' }, this.gauge, this.text);
  }

  update(car: FuelCar): void {
    const used = fuelUsed(car);
    const pct = isDry(car) ? -2 : fuelPct(used);
    if (pct === this.shown) return;
    this.shown = pct;
    const tone = fuelTone(used);
    this.gauge.className = `wear-gauge fuel mini ${tone}`;
    this.bar.style.width = `${fuelPct(used)}%`;
    this.text.className = tone === 'good' ? '' : tone;
    this.text.textContent = fuelText(car) ?? '';
  }
}
