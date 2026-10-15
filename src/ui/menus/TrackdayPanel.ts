import type { GameState } from '../../state/GameState';
import { SaveManager } from '../../state/SaveManager';
import type { TrackData } from '../../track/TrackData';
import { append, clear, el, toast } from '../dom';
import { html, padGlyph } from '../padHints';
import { formatCredits } from '../../data/sales';
import { MEDAL_LABEL, medalFor } from '../../race/medals';
import {
  COACHING, DRINKS, MEALS, TRACKDAY, carRefusal, forecastTrackday, satisfactionText, type CoachingId, type DrinkId, type MealId, type TrackdayPlan,
} from '../../data/trackday';

/** « 2:00 » */
function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** What a running trackday shows: « Trackday sur Ovale : 12 clients, fin dans 1:12 ». Null when none runs. */
export function trackdayStatus(state: GameState): string | null {
  const t = state.trackday;
  if (!t) return null;
  const left = (t.endTick - state.sim.tickCount) / 20;
  return `Trackday sur ${t.trackName} : ${t.forecast.guests} client${t.forecast.guests > 1 ? 's' : ''}, fin dans ${clock(left)}`;
}

/**
 * « Organiser un trackday » on a circuit: which of the player's cars go (a car to repair, to refuel or short of fuel for
 * the day cannot), the meal, the drinks, the coaching and the ticket. The forecast under it is what will happen:
 * guests, tickets, costs, how happy they will be, the new reputation and what each car takes. « Lancer » pays the
 * catering and sends the cars away for two minutes. `onStarted` after a start, `onClose` when dismissed.
 */
export function openTrackdayPanel(state: GameState, track: TrackData, opts: { onClose?: () => void; onStarted?: () => void } = {}): HTMLElement {
  const rec = state.records[track.id];
  const medal = medalFor(rec?.bestMs, track.medals ?? null);
  const official = !!track.builtin;
  const eligible = state.cars.filter((c) => !carRefusal(c));
  const plan: TrackdayPlan = {
    trackId: track.id,
    carIds: eligible.map((c) => c.id),
    meal: 'sandwich',
    drink: 'water',
    coaching: medal ? 'self' : 'none',
    price: 400,
  };
  const body = el('div');
  const panel = el('div', { class: 'panel center modal trackday-panel', 'data-pad-scope': '' },
    el('h2', {}, `Trackday : ${track.name}`),
    el('div', { class: 'muted small' }, 'Prête tes voitures à des clients pour la journée. Ils paient leur billet à la fin ; le repas, les boissons et un moniteur se paient au départ. Les voitures reviennent usées et avec moins d’essence.'),
    body,
  );

  const select = <T extends string>(label: string, options: { id: T; name: string; cost: number }[], get: () => T, set: (v: T) => void, disabled?: (id: T) => string | null) => {
    const s = el('select', { 'data-action': label }) as HTMLSelectElement;
    for (const o of options) {
      const why = disabled?.(o.id) ?? null;
      const opt = el('option', { value: o.id }, `${o.name}${o.cost ? ` · ${formatCredits(o.cost)} / client` : ''}${why ? ` (${why})` : ''}`) as HTMLOptionElement;
      opt.disabled = !!why;
      opt.selected = o.id === get();
      s.appendChild(opt);
    }
    s.addEventListener('change', () => {
      set(s.value as T);
      render();
    });
    return el('label', { class: 'row setting' }, el('span', {}, label), el('span', { class: 'spacer' }), s);
  };

  const render = () => {
    clear(body);
    // Cars
    body.appendChild(el('h3', { style: 'margin-top:10px' }, 'Voitures prêtées'));
    if (!state.cars.length) body.appendChild(el('div', { class: 'muted small' }, 'Aucune voiture construite : assemble-en une au garage.'));
    for (const c of state.cars) {
      const why = carRefusal(c);
      const box = el('input', { type: 'checkbox', 'data-car': c.id }) as HTMLInputElement;
      box.checked = plan.carIds.includes(c.id);
      box.disabled = !!why;
      box.addEventListener('change', () => {
        plan.carIds = box.checked ? [...plan.carIds, c.id] : plan.carIds.filter((id) => id !== c.id);
        render();
      });
      body.appendChild(el('label', { class: 'row setting' }, box, el('span', {}, c.name), el('span', { class: 'spacer' }), why ? el('span', { class: 'bad small' }, why) : null));
    }
    // Services
    body.appendChild(el('h3', { style: 'margin-top:10px' }, 'Accueil'));
    body.append(
      select<MealId>('Repas', MEALS, () => plan.meal, (v) => (plan.meal = v)),
      select<DrinkId>('Boissons', DRINKS, () => plan.drink, (v) => (plan.drink = v)),
      select<CoachingId>('Coaching', COACHING.map((c) => (c.id === 'self' && medal ? { ...c, name: `${c.name} (médaille ${MEDAL_LABEL[medal]})` } : c)), () => plan.coaching, (v) => (plan.coaching = v),
        (id) => (id === 'self' && !medal ? 'il te faut une médaille ici' : null)),
    );
    // Ticket
    const price = el('input', { type: 'range', min: TRACKDAY.PRICE_MIN, max: TRACKDAY.PRICE_MAX, step: TRACKDAY.PRICE_STEP, value: plan.price, 'data-action': 'price' }) as HTMLInputElement;
    const priceLabel = el('b', { class: 'mono' }, formatCredits(plan.price));
    price.addEventListener('input', () => {
      plan.price = Number(price.value);
      priceLabel.textContent = formatCredits(plan.price);
      renderForecast();
    });
    body.appendChild(el('label', { class: 'row setting' }, el('span', {}, 'Billet'), el('span', { class: 'spacer' }), price, priceLabel));
    body.appendChild(forecastBox);
    renderForecast();
    body.appendChild(
      el('div', { class: 'row', style: 'margin-top:12px' },
        el('span', { class: 'muted small pad-only' }, html(`${padGlyph('a')} choisir · ${padGlyph('b')} fermer`)),
        el('span', { class: 'spacer' }),
        el('button', { 'data-pad-btn': 'b', onclick: () => close() }, 'Fermer'),
        launch,
      ),
    );
  };

  const forecastBox = el('div', { class: 'trackday-forecast' });
  const launch = el('button', {
    class: 'primary',
    'data-action': 'launch',
    onclick: () => {
      const f = forecastTrackday(plan, state.cars, { medal, official, reputation: state.trackdayRep });
      const err = state.startTrackday(plan, f, track.name);
      if (err) return toast(err, 'error');
      SaveManager.save(state);
      toast(`Trackday lancé sur ${track.name} : ${f.guests} client${f.guests > 1 ? 's' : ''} attendus`, 'success', 3000);
      close();
      opts.onStarted?.();
    },
  }, 'Lancer le trackday') as HTMLButtonElement;

  const renderForecast = () => {
    const f = forecastTrackday(plan, state.cars, { medal, official, reputation: state.trackdayRep });
    clear(forecastBox);
    const net = f.net;
    append(forecastBox,
      el('h3', { style: 'margin-top:10px' }, 'Prévision'),
      el('div', { class: 'row' }, el('span', {}, 'Clients'), el('span', { class: 'spacer' }), el('b', {}, `${f.guests} / ${f.places}`)),
      el('div', { class: 'row muted small' }, el('span', {}, 'Ce que la journée vaut pour eux'), el('span', { class: 'spacer' }), `${formatCredits(f.fairPrice)} / client`),
      el('div', { class: 'row' }, el('span', {}, 'Billets (à la fin)'), el('span', { class: 'spacer' }), el('b', { class: 'credits-text' }, `+${formatCredits(f.revenue)}`)),
      el('div', { class: 'row' }, el('span', {}, 'Repas, boissons, moniteur (au départ)'), el('span', { class: 'spacer' }), el('b', {}, `−${formatCredits(f.costs)}`)),
      el('div', { class: 'row' }, el('span', {}, 'Bilan'), el('span', { class: 'spacer' }), el('b', { class: net >= 0 ? 'good' : 'bad' }, `${net >= 0 ? '+' : ''}${formatCredits(net)}`)),
      el('div', { class: 'row' }, el('span', {}, 'Satisfaction'), el('span', { class: 'spacer' }), el('b', {}, f.guests ? `${satisfactionText(f.satisfaction)} (${f.satisfaction}/100)` : '—')),
      el('div', { class: 'row muted small' }, el('span', {}, 'Réputation'), el('span', { class: 'spacer' }), `${state.trackdayRep} → ${f.reputation} / 100`),
      ...f.cars.filter((c) => c.guests).map((c) => {
        const car = state.cars.find((x) => x.id === c.id);
        const tires = c.wear.wheels ? `roues −${Math.round(c.wear.wheels / 10)} %` : '';
        const engine = c.wear.engine ? `moteur −${Math.round(c.wear.engine / 10)} %` : '';
        const fuel = c.fuel ? `essence −${Math.round(c.fuel / 10)} %` : '';
        return el('div', { class: 'muted small' }, `${car?.name ?? c.id} : ${c.guests} client${c.guests > 1 ? 's' : ''} · ${[tires, engine, fuel].filter((x) => x).join(' · ')}`);
      }),
      f.problem ? el('div', { class: 'bad small', style: 'margin-top:4px' }, f.problem) : !f.guests && plan.carIds.length ? el('div', { class: 'bad small', style: 'margin-top:4px' }, 'Personne ne viendrait à ce prix : baisse le billet ou soigne l’accueil.') : null,
      f.costs > state.sim.credits ? el('div', { class: 'bad small', style: 'margin-top:4px' }, `Il te manque ${formatCredits(f.costs - state.sim.credits)} pour l’accueil.`) : null,
    );
    launch.disabled = !!f.problem || f.guests <= 0 || f.costs > state.sim.credits || !!state.trackday;
  };

  render();
  const layer = el('div', { class: 'ui-layer settings-layer' }, panel);
  let closed = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey, true);
    layer.remove();
    opts.onClose?.();
  };
  window.addEventListener('keydown', onKey, true);
  layer.addEventListener('click', (e) => e.target === layer && close());
  document.getElementById('ui-root')!.appendChild(layer);
  return panel;
}
