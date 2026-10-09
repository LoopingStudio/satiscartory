import type { WearHit } from '../car/wearMeter';
import { shownWorst, worstWear, type ShownWorst, type WearCar } from '../data/wear';
import { hitText, pillText, wearTone } from '../data/wearText';
import { el } from './dom';
import { wearGauge } from './wearGauge';

/**
 * Damage flash of a driven car (« Choc : carrosserie −3 % »), above the speedometer in a race, above the hint in the
 * factory. Never a toast: the toast is single and global. The animation restarts on every hit, and its class goes
 * when it ends (or is cancelled): an element shown again after display: none never replays it (like the credits).
 */
export class WearFlash {
  readonly el = el('div', { class: 'wear-hit' });

  constructor() {
    const done = () => this.el.classList.remove('flash');
    this.el.addEventListener('animationend', done);
    this.el.addEventListener('animationcancel', done);
  }

  show(text: string): void {
    this.el.textContent = text;
    this.el.classList.remove('flash');
    void this.el.offsetWidth;
    this.el.classList.add('flash');
  }

  /** Drops a flash under way (getting in or out of a car): hidden, then shown again, it does not replay. */
  stop(): void {
    this.el.classList.remove('flash');
  }
}

/**
 * Wear in the race HUD, for a car that wears: a pill under the speedometer (mini gauge, « Roues 46 % » or « Neuve »)
 * and the damage flash. Called every frame, it allocates nothing and touches the DOM only when the part shown or its
 * percentage changes (shownWorst), or on a new hit (WearMeter.last.seq).
 */
export class WearHud {
  readonly pill: HTMLElement;
  readonly flash = new WearFlash();
  private readonly gauge = wearGauge(0, 'mini', '');
  private readonly bar = this.gauge.firstElementChild as HTMLElement;
  private readonly text = el('span');
  private readonly shown: ShownWorst = { slot: null, pct: -1 };
  /** Last hit flashed (a new meter starts at 0). */
  private seq = 0;

  constructor() {
    this.pill = el('div', { class: 'race-wear' }, this.gauge, this.text);
  }

  update(car: WearCar): void {
    if (!shownWorst(car, this.shown)) return;
    const tone = wearTone(worstWear(car));
    this.gauge.className = `wear-gauge mini ${tone}`;
    this.bar.style.width = `${this.shown.pct}%`;
    this.text.className = tone === 'good' ? '' : tone;
    this.text.textContent = pillText(car);
  }

  /** Flashes the meter's last hit once (from WEAR.FLASH_MIN on: hitText). */
  onHit(last: WearHit): void {
    if (last.seq === this.seq) return;
    this.seq = last.seq;
    const text = hitText(last);
    if (text) this.flash.show(text);
  }
}
