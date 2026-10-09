import { BLUEPRINTS, BLUEPRINT_IDS, blueprintById, type Blueprint, type BlueprintId, type SlotDef } from '../data/blueprints';
import { ITEMS, ITEM_IDS, countLabel, type Inventory as ItemCounts, type ItemId } from '../data/items';
import { PART_MODIFIERS } from '../data/parts';
import { WEAR } from '../data/balance';
import type { CarSpec } from '../car/stats';
import { wearEffects } from '../car/wornTuning';
import type { ItemIcons } from '../core/assets/IconRenderer';
import type { GameState } from '../state/GameState';
import { SaveManager } from '../state/SaveManager';
import { carStatsBlock } from '../ui/carStats';
import { append, clear, el, toast } from '../ui/dom';
import { html, padGlyph } from '../ui/padHints';
import { bestChoices, checkAssembly, specOf, type CarInstance, type PartChoices } from './assembly';
import { CAR_PARTS, assembleCar, carLocation, checkAssembleIn, disassembleCar, findCar, partStock, selectRaceCar, sellCar, swapCarPart, type CarLocation } from './actions';
import { carPrice, formatCredits } from '../data/sales';
import { bayOccupant, type BayBlocker, type GarageSpot } from './parking';
import { buildProgress, type CarBuild } from './build';
import { abandonBuild, buildIn, installBuildPart, removeBuildPart } from './buildActions';
import { condition, isBlocked, slotWear, worstWear, wornCarPrice, wornSetPrice } from '../data/wear';
import {
  BUILD_SLOT_BUSY, BUILD_WORN_TITLE, CREDITS_TITLE, POSE_WORN_TITLE, REMOVE_WORN_TITLE, RENEW_TITLE, REPAIR_ALL_TITLE, TO_REPAIR, TO_REPAIR_TAG,
  VALUE_TITLE, WORN_INTRO, WORN_NO_TARGET, WORN_POSE_REFUSED, abandonQuestion, abandonedText, blockAlert, blockText, carRepairedText, carRowTip,
  disassembleQuestion, disassembledText, effectsText, garageRaceTip, installTitle, installedInBuildText, installedOnCarText, missingTip, pct,
  poseWornLabel, refusedText, renewLabel, renewTip, repairTitle, repairedValueText, reserveHint, reserveRowText, reserveSummary, sellSetQuestion,
  sellSetTitle, setRepairedText, setSoldText, shortTip, slotRepairedText, stateText, swappedText, takeOffTitle, wornRemovedText, wornSaleNote,
} from '../data/wearText';
import {
  carQuote, installWornInBuild, installWornSet, payCheck, quoteCaps, renewCarSlot, repairCar, repairCarSlot, repairWornSet, sellWornSet,
  setQuote, slotForSet, slotQuote, wornGroups, type Pay, type RepairQuote, type WornGroup,
} from './wearActions';
import { wearGauge, wearPct } from '../ui/wearGauge';

export interface GaragePanelCallbacks {
  /** « Fermer »: the owner calls close() and gives the controls back. */
  close(): void;
  /** « Courir » with this car (already made the race car; null = the loaner): go to the track selection. */
  race(carId: string | null): void;
  /** Cars changed (assembled, dismantled, parts swapped): re-sync the physical cars. */
  changed(): void;
  /** Car being driven right now, listed « En route » (optional). */
  drivenCarId?(): string | null;
  /** Car whose body blocks the bay (optional; default: a car centered in the garage). */
  bayBlocker?: BayBlocker;
}

type View = { kind: 'car'; id: string | null } | { kind: 'draft'; blueprint: BlueprintId; choices: PartChoices } | { kind: 'build' } | { kind: 'worn' };
/**
 * Who takes the pad focus when a click made the focused control go away: the view's main action (else its row),
 * its row on the left (after a car was finished or taken apart: a second A press does nothing), a button, the
 * active part of a slot (after a repair: A on it does nothing), or a button of a group of the reserve.
 */
type PadRefocus = 'main' | 'row' | 'disassemble' | 'abandon' | 'sell' | { slot: string } | { worn: string; action: 'sell-worn' | 'repair-worn'; pay?: Pay };

/** Key of a pending « Vendre » confirmation (a bare car id is a pending « Démonter », 'build' an « Abandonner »). */
const sellKey = (carId: string) => `sell:${carId}`;
/** Key of a pending « Vendre » of a set of the reserve (by its group). */
const sellWornKey = (group: string) => `sellworn:${group}`;

const LOCATION_LABEL: Record<CarLocation, string> = { here: 'Dans ce garage', elsewhere: 'Garée ailleurs', driving: 'En route', unplaced: 'À ranger' };

const LOCATION_NOTE: Record<Exclude<CarLocation, 'here'>, string> = {
  elsewhere: 'Garée hors de ce garage : amène-la dans la place pour la réparer, changer ses pièces, la démonter ou la vendre.',
  driving: 'Tu la conduis : gare-la dans ce garage pour la réparer, changer ses pièces, la démonter ou la vendre.',
  unplaced: 'Elle attend une place libre : pose un garage ou libère une place.',
};

/** Repair quotes the current view shows: per slot of the car in the bay, « Tout réparer », per group of the reserve. */
interface ShownQuotes {
  slots: Partial<Record<string, RepairQuote>>;
  all: RepairQuote | null;
  sets: Record<string, RepairQuote>;
}

function blueprintOf(car: CarInstance | null): Blueprint | undefined {
  return blueprintById(car?.blueprint ?? 'loaner');
}

/** The state shown of each installed part (%), for the refresh key: a thousandth more does not redraw the panel. */
function shownWear(car: CarInstance): string {
  return (blueprintOf(car)?.slots ?? []).map((s) => (car.parts[s.id] ? condition(slotWear(car, s.id)) : '-')).join('.');
}

/** Installed slots of a car: how many hold new parts, how many worn ones (where its parts go when taken apart). */
function partsByState(car: CarInstance): { fresh: number; worn: number } {
  let fresh = 0;
  let worn = 0;
  for (const s of blueprintOf(car)?.slots ?? []) {
    if (!car.parts[s.id]) continue;
    if (slotWear(car, s.id) > 0) worn++;
    else fresh++;
  }
  return { fresh, worn };
}

/** A build's started slots: how many hold new parts, how many worn sets of the reserve. */
function buildByState(build: CarBuild): { fresh: number; worn: number } {
  let fresh = 0;
  let worn = 0;
  for (const p of Object.values(build.parts)) {
    if (p.n <= 0) continue;
    if (p.wear) worn++;
    else fresh++;
  }
  return { fresh, worn };
}

/**
 * Garage panel over the factory (E on a garage): the cars and where they are, new-car drafts, part swaps, repairs,
 * dismantling and selling for the car standing in this garage's bay, the reserve of worn parts (shared by every
 * garage), the race car and « Courir ». Two side columns so the bay stays visible in the middle of the screen.
 * Pad (PadNav scope): B closes (or cancels a pending confirmation), LB/RB step through the left list, the
 * focus starts on the view's main action (« Assembler », the next « Poser », « Courir »), never on a button that
 * pays a repair; every button carries data-* attributes, its focus identity across the re-renders.
 */
export class GaragePanel {
  private root: HTMLElement | null = null;
  private left = el('div', { class: 'panel garage-left' });
  private right = el('div', { class: 'panel garage-right' });
  private spot: GarageSpot | null = null;
  private view: View = { kind: 'car', id: null };
  /** Car whose « Démonter » was clicked once (the second click confirms). */
  private confirming: string | null = null;
  private key = '';
  /** Set by a click that changes the view, read by the next render (data-pad-autofocus). */
  private padRefocus: PadRefocus | null = null;
  private previewMemo: { key: string; value: { spec: CarSpec } } | null = null;
  /** Renders so far (automated checks: the panel must not redraw while nothing it shows changed). */
  private renders = 0;

  constructor(
    private readonly layer: HTMLElement,
    private readonly state: GameState,
    private readonly icons: ItemIcons | null,
    private readonly cb: GaragePanelCallbacks,
  ) {}

  get isOpen(): boolean {
    return this.root !== null;
  }

  get garage(): GarageSpot | null {
    return this.spot;
  }

  /** Opens on the car standing in the bay, else on a new-car draft (the one whose parts are in stock first). */
  open(garage: GarageSpot): void {
    this.close();
    // With its pad height: the bay, the draft ghost and the camera stand on the pad on the relief.
    this.spot = { id: garage.id, x: garage.x, z: garage.z, rot: garage.rot, ...(garage.py !== undefined ? { py: garage.py } : {}) };
    this.view = this.defaultView();
    this.root = el('div', { class: 'garage-panel', 'data-pad-scope': '' }, this.left, this.right);
    this.layer.appendChild(this.root);
    // Hides the factory HUD parts that would sit under the columns (see main.css).
    this.layer.classList.add('garage-open');
    this.render();
  }

  /** Removes the panel (does not call cb.close). */
  close(): void {
    this.root?.remove();
    this.root = null;
    this.spot = null;
    this.confirming = null;
    this.padRefocus = null;
    this.key = '';
    this.layer.classList.remove('garage-open');
  }

  /** Live update (~5 Hz): re-renders only when parts in stock, cars, the race car, the reserve or the view changed. */
  refresh(): void {
    const spot = this.spot;
    if (!spot) return;
    // The garage was dismantled (or the game replaced) under the panel.
    if (this.state.sim.buildings.get(spot.id)?.type !== 'garage') return this.cb.close();
    const gone =
      (this.view.kind === 'car' && this.view.id !== null && !findCar(this.state, this.view.id)) ||
      (this.view.kind === 'build' && !this.build) ||
      (this.view.kind === 'worn' && !this.state.worn.length);
    // Back to the default view (show(): its main action or its row takes the pad focus, never a button that pays).
    if (gone) return this.show(this.defaultView());
    if (this.contentKey() !== this.key) this.render();
  }

  /** Car blocking this garage's bay (centered in it, or overlapping it). */
  private occupant(spot: GarageSpot): CarInstance | null {
    return bayOccupant(this.state.cars, spot, this.cb.bayBlocker);
  }

  /**
   * The car standing in this garage's bay (`here`, the car `id` only when given): the one repairs and the reserve's
   * « Poser » act on, like « Démonter » and « Vendre ».
   */
  private hereCar(id?: string): CarInstance | null {
    const spot = this.spot;
    if (!spot) return null;
    const driven = this.driven;
    return this.state.cars.find((c) => (id === undefined || c.id === id) && carLocation(c, spot, driven) === 'here') ?? null;
  }

  /** The car under construction in this garage's bay, if any. */
  private get build(): CarBuild | null {
    return this.spot ? buildIn(this.state, this.spot.id) : null;
  }

  /** Draft to show as a ghost in the empty bay (same object while it does not change), null otherwise. */
  get preview(): { spec: CarSpec } | null {
    if (!this.spot || this.view.kind !== 'draft' || this.occupant(this.spot) || this.build) return null;
    const spec = this.draftSpec(this.view);
    const key = JSON.stringify(spec);
    if (this.previewMemo?.key !== key) this.previewMemo = { key, value: { spec } };
    return this.previewMemo.value;
  }

  dispose(): void {
    this.close();
  }

  // ------------------------------------------------------------------ helpers

  private icon(item: ItemId, cls = 'item-icon tiny'): HTMLElement {
    const url = this.icons?.url(item);
    return url ? el('img', { class: cls, src: url, alt: ITEMS[item].name, draggable: 'false' }) : el('span', { class: `${cls} item-icon-text` }, ITEMS[item].name.slice(0, 2));
  }

  private get driven(): string | null {
    return this.cb.drivenCarId?.() ?? null;
  }

  private draftSpec(view: Extract<View, { kind: 'draft' }>): CarSpec {
    const parts: CarSpec['parts'] = {};
    for (const [slot, item] of Object.entries(view.choices)) if (item) parts[slot] = item;
    return { blueprint: view.blueprint, parts };
  }

  private newDraft(bp: BlueprintId, stock: ItemCounts = partStock(this.state)): View {
    return { kind: 'draft', blueprint: bp, choices: bestChoices(BLUEPRINTS[bp], stock) };
  }

  /** Never the reserve: it is a side list, the bay comes first. */
  private defaultView(): View {
    const here = this.spot ? this.occupant(this.spot) : null;
    if (here) return { kind: 'car', id: here.id };
    if (this.build) return { kind: 'build' };
    const stock = partStock(this.state);
    const buildable = BLUEPRINT_IDS.filter((id) => BLUEPRINTS[id].buildable);
    const ready = buildable.find((id) => checkAssembly(stock, id, bestChoices(BLUEPRINTS[id], stock)).ok);
    const bp = ready ?? buildable[0];
    return bp ? this.newDraft(bp, stock) : { kind: 'car', id: this.state.selectedCarId };
  }

  /**
   * Another view (a row on the left, LB/RB, the default one when the shown one is gone): a focused control that is
   * still there keeps the focus (a tab, « Courir » of both views), else the view's main action or its row takes it,
   * never the nearest control (the reserve and the car in the bay put « Réparer » buttons that pay where « Courir » or
   * « Assembler » stood).
   */
  private show(view: View): void {
    this.view = view;
    this.confirming = null;
    this.padRefocus = 'main';
    this.render();
  }

  /** Cars changed: save, let the owner re-sync the physical cars, redraw. */
  private commit(): void {
    SaveManager.save(this.state);
    this.cb.changed();
    this.render();
  }

  /** The group of the reserve with this key (its sets are the reserve's own), null once it is gone. */
  private wornGroup(key: string): WornGroup | null {
    return wornGroups(this.state.worn).find((g) => g.key === key) ?? null;
  }

  /**
   * The repair quotes of the current view: each worn slot of the car standing in the bay and « Tout réparer » (from 2
   * worn slots), or each group of the reserve. Shared by the render and the refresh key.
   */
  private shownQuotes(): ShownQuotes {
    const out: ShownQuotes = { slots: {}, all: null, sets: {} };
    const view = this.view;
    if (view.kind === 'worn') {
      for (const g of wornGroups(this.state.worn)) out.sets[g.key] = setQuote(g.set.item, g.set.n, g.set.wear);
    } else if (view.kind === 'car') {
      const car = findCar(this.state, view.id);
      if (car && this.spot && carLocation(car, this.spot, this.driven) === 'here') {
        let worn = 0;
        for (const s of blueprintOf(car)?.slots ?? []) {
          const q = slotQuote(car, s.id);
          if (!q) continue;
          out.slots[s.id] = q;
          worn++;
        }
        if (worn >= 2) out.all = carQuote(car);
      }
    }
    return out;
  }

  /**
   * The repair items in stock (backpack + hub), each capped at the most a shown quote asks for: what the « j'ai /
   * il faut » chips and the enabled « Réparer » show, and nothing more (a busy plate machine redraws nothing).
   */
  private repairStockKey(q: ShownQuotes): string {
    const quotes = [...Object.values(q.slots), ...Object.values(q.sets), q.all].filter((x): x is RepairQuote => !!x);
    if (!quotes.length) return '';
    const caps = quoteCaps(quotes);
    const wallet = this.state.wallet();
    return ITEM_IDS.filter((i) => caps[i]).map((i) => `${i}=${Math.min(wallet.count(i), caps[i]!)}`).join(',');
  }

  /**
   * The part counts, cars (parts, location, state in %), bay occupant, race car, view, reserve, balance and the
   * repair items a shown quote asks for: what the panel shows.
   */
  private contentKey(): string {
    const spot = this.spot!;
    const stock = partStock(this.state);
    const driven = this.driven;
    const cars = this.state.cars.map((c) => `${c.id}:${c.name}:${JSON.stringify(c.parts)}:${carLocation(c, spot, driven)}:${shownWear(c)}`).join('|');
    const worn = this.state.worn.map((s) => `${s.item}.${s.n}.${s.wear}`).join(',');
    return [
      CAR_PARTS.map((i) => stock[i] ?? 0).join(','),
      cars,
      this.occupant(spot)?.id,
      JSON.stringify(this.build),
      this.state.selectedCarId,
      JSON.stringify(this.view),
      this.confirming,
      this.state.sim.credits,
      worn,
      this.repairStockKey(this.shownQuotes()),
    ].join('#');
  }

  // ------------------------------------------------------------------ UI

  private render(): void {
    if (!this.root || !this.spot) return;
    this.key = this.contentKey();
    this.renders++;
    const stock = partStock(this.state);
    const row = this.renderLeft(stock);
    const main = this.renderRight(stock, this.shownQuotes());
    this.markPadFocus(main, row);
  }

  /**
   * Pad focus (PadNav): the view's main action (else its row on the left) is focused when the panel opens;
   * after a click that changed the view, padRefocus takes the focus from the control that went away.
   */
  private markPadFocus(main: HTMLElement | null, row: HTMLElement | null): void {
    (main ?? row)?.setAttribute('data-pad-default', '');
    const refocus = this.padRefocus;
    this.padRefocus = null;
    // A pending confirmation's « Annuler » asks for the focus itself.
    if (!refocus || this.confirming) return;
    let target: Element | null;
    if (refocus === 'main') target = main ?? row;
    else if (refocus === 'row') target = row;
    else if (typeof refocus === 'string') target = this.right.querySelector(`[data-action="${refocus}"]`);
    else if ('slot' in refocus) target = this.right.querySelector(`.part-btn.selected[data-part-slot="${refocus.slot}"]`) ?? row;
    else target = this.right.querySelector(`[data-action="${refocus.action}"][data-worn="${refocus.worn}"]${refocus.pay ? `[data-pay="${refocus.pay}"]` : ''}`) ?? row;
    target?.setAttribute('data-pad-autofocus', '');
  }

  /** Returns the row of the current view (selected). */
  private renderLeft(stock: ItemCounts): HTMLElement | null {
    const l = this.left;
    const scroll = l.scrollTop;
    clear(l);
    const occupant = this.occupant(this.spot!);
    const build = this.build;
    const progress = build ? buildProgress(build) : null;
    l.append(
      el('div', { class: 'row' },
        el('h2', {}, 'Garage'),
        el('span', { class: 'spacer' }),
        // Always shown: cars sell and repairs are paid here (the storage panel with the balance is hidden while the garage is open).
        el('span', { class: 'credits', title: CREDITS_TITLE }, formatCredits(this.state.sim.credits)),
        el('button', { class: 'small', 'data-action': 'close', 'data-pad-btn': 'b', onclick: () => this.cb.close() }, 'Fermer'),
      ),
      el('div', { class: 'muted small' },
        occupant
          ? `Dans la place : ${occupant.name}${isBlocked(occupant) ? ` · ${TO_REPAIR}` : ''}`
          : build && progress
            ? `Dans la place : ${BLUEPRINTS[build.blueprint].name} en construction (${progress.done}/${progress.total} pièces)`
            : 'Place libre : assemble une voiture ici, ou pose ses pièces au fur et à mesure.'),
      el('div', { class: 'muted small pad-only' }, html(`${padGlyph('lb')}${padGlyph('rb')} voiture précédente / suivante · ${padGlyph('b')} fermer`)),
      el('h3', { style: 'margin-top:10px' }, 'Mes voitures'),
    );
    const driven = this.driven;
    // The rows are the views of the right column: LB/RB step through them (data-pad-tab, current = selected).
    let selected: HTMLElement | null = null;
    const pick = (b: HTMLElement, current: boolean) => {
      if (current) selected = b;
      return b;
    };
    // A worn car shows its most worn part on a mini gauge, and in the pad tip (PadNav reads the focused row only);
    // past the race limit, the tag « À réparer ».
    const row = (id: string | null, name: string, sub: HTMLElement, worn: CarInstance | null = null) => {
      const viewing = this.view.kind === 'car' && this.view.id === id;
      const racing = (this.state.selectedCarId ?? null) === id;
      const state = worn ? stateText(worn) : null;
      const blocked = !!worn && isBlocked(worn);
      return pick(
        el('button', { class: `car-row${viewing ? ' selected' : ''}`, 'data-car': id ?? 'loaner', 'data-pad-tab': true, 'data-pad-tip': carRowTip(racing, state, blocked), onclick: () => this.show({ kind: 'car', id }) },
          el('span', { class: 'car-star', title: racing ? 'Voiture de course' : '' }, racing ? '★' : '☆'),
          el('span', { class: 'col', style: 'gap:0' }, el('b', {}, name), sub),
          worn && state ? el('span', { class: 'spacer' }) : null,
          worn && state ? wearGauge(worstWear(worn), 'mini', `État : ${state}`) : null,
          blocked ? el('span', { class: 'wear-tag' }, TO_REPAIR_TAG) : null,
        ),
        viewing,
      );
    };
    l.appendChild(row(null, BLUEPRINTS.loaner.name, el('span', { class: 'muted small' }, 'Prêt du circuit · courses seulement · ne s’use pas')));
    for (const c of this.state.cars) {
      const loc = carLocation(c, this.spot!, driven);
      l.appendChild(
        row(c.id, c.name, el('span', { class: 'small' },
          el('span', { class: 'muted' }, `${blueprintOf(c)?.name ?? c.blueprint} · `),
          el('span', { class: loc === 'here' ? 'good' : 'muted' }, LOCATION_LABEL[loc]),
        ), c),
      );
    }

    l.appendChild(el('h3', { style: 'margin-top:12px' }, 'Nouvelle voiture'));
    if (build && progress) {
      const current = this.view.kind === 'build';
      l.appendChild(
        pick(
          el('button', { class: `car-row${current ? ' selected' : ''}`, 'data-action': 'build', 'data-pad-tab': true, onclick: () => this.show({ kind: 'build' }) },
            el('span', { class: 'car-star' }, '🔧'),
            el('span', { class: 'col', style: 'gap:0' }, el('b', {}, `${BLUEPRINTS[build.blueprint].name} (en construction)`), el('span', { class: 'muted small' }, `${progress.done}/${progress.total} pièces posées`)),
          ),
          current,
        ),
      );
    }
    for (const id of BLUEPRINT_IDS) {
      const bp = BLUEPRINTS[id];
      if (!bp.buildable) continue;
      const drafting = this.view.kind === 'draft' && this.view.blueprint === id;
      const ok = checkAssembly(stock, id, bestChoices(bp, stock)).ok;
      l.appendChild(
        pick(
          el('button', { class: `car-row${drafting ? ' selected' : ''}`, 'data-blueprint': id, 'data-pad-tab': true, onclick: () => this.show(this.newDraft(id)) },
            el('span', { class: 'car-star' }, '+'),
            el('span', { class: 'col', style: 'gap:0' }, el('b', {}, bp.name), el('span', { class: ok ? 'good small' : 'muted small' }, ok ? 'Pièces disponibles !' : 'Pièces à produire')),
          ),
          drafting,
        ),
      );
    }

    // The reserve of worn parts, the last tab (LB/RB reach it): only once something is in it.
    if (this.state.worn.length) {
      const current = this.view.kind === 'worn';
      l.append(
        el('h3', { style: 'margin-top:12px' }, 'Pièces usées'),
        pick(
          el('button', { class: `car-row${current ? ' selected' : ''}`, 'data-action': 'worn', 'data-pad-tab': true, onclick: () => this.show({ kind: 'worn' }) },
            el('span', { class: 'car-star' }, '🔩'),
            el('span', { class: 'col', style: 'gap:0' }, el('b', {}, 'Réserve'), el('span', { class: 'muted small' }, reserveRowText(this.state.worn.length))),
          ),
          current,
        ),
      );
    }

    l.appendChild(el('h3', { style: 'margin-top:12px' }, 'Pièces (sac + hangar)'));
    const grid = el('div', { class: 'stock-grid small' });
    for (const p of CAR_PARTS) {
      grid.appendChild(el('div', { class: 'row' }, this.icon(p), el('span', {}, ITEMS[p].name), el('span', { class: 'spacer' }), el('b', { class: 'mono' }, stock[p] ?? 0)));
    }
    l.appendChild(grid);
    l.scrollTop = scroll;
    return selected;
  }

  /** Returns the view's main action when it can be done (null otherwise). */
  private renderRight(stock: ItemCounts, quotes: ShownQuotes): HTMLElement | null {
    const r = this.right;
    const scroll = r.scrollTop;
    clear(r);
    const build = this.build;
    let main: HTMLElement | null = null;
    if (this.view.kind === 'draft') main = this.renderDraft(r, this.view, stock);
    else if (this.view.kind === 'build' && build) main = this.renderBuild(r, build, stock);
    else if (this.view.kind === 'car') main = this.renderCar(r, findCar(this.state, this.view.id), stock, quotes);
    else if (this.view.kind === 'worn') main = this.renderWorn(r, quotes);
    r.scrollTop = scroll;
    return main;
  }

  /** `tip`: why it is disabled, for the pad (no hover). */
  private partButton(item: ItemId | null, label: string, attrs: { active: boolean; disabled?: boolean; tip?: string; title?: string; slot: string; onclick: () => void }): HTMLElement {
    return el('button', {
      class: `small part-btn${attrs.active ? ' selected' : ''}`,
      disabled: attrs.disabled,
      title: attrs.title,
      'data-part-slot': attrs.slot,
      'data-item': item ?? 'none',
      // Part of the pad focus identity: the same part in another view (build → finished car) is another control.
      'data-view': this.view.kind,
      'data-pad-tip': attrs.disabled ? attrs.tip : undefined,
      onclick: attrs.onclick,
    }, item ? this.icon(item) : null, label);
  }

  /** A slot's name (or `label`), then the wear of its part (gauge and %) when it holds one. */
  private slotHead(car: CarInstance, slot: SlotDef, label = slot.name): HTMLElement {
    const installed = !!car.parts[slot.id];
    const w = slotWear(car, slot.id);
    return el('div', { class: 'row slot-head' },
      el('b', {}, label),
      el('span', { class: 'spacer' }),
      installed ? wearGauge(w, 'full', `${slot.name} : ${pct(w)}`) : null,
      installed ? wearPct(w) : null,
    );
  }

  /** « Annuler » of a pending confirmation: wins B over « Fermer », takes the focus from the button it replaced. */
  private cancelButton(action: string, onclick: () => void): HTMLElement {
    return el('button', { class: 'small', 'data-action': action, 'data-pad-btn': 'b', 'data-pad-prio': 1, 'data-pad-autofocus': true, onclick }, 'Annuler');
  }

  /** « j'ai / il faut » of each item of a quote (the hub tiers' chips): green when the stock covers it, red otherwise. */
  private chips(items: ItemCounts): HTMLElement[] {
    const wallet = this.state.wallet();
    return ITEM_IDS.filter((i) => (items[i] ?? 0) > 0).map((i) => {
      const need = items[i]!;
      const have = wallet.count(i);
      return el('span', { class: `tier-item ${have >= need ? 'good' : 'bad'}` }, this.icon(i), el('span', { class: 'mono' }, `${Math.min(have, need)}/${need}`));
    });
  }

  /**
   * The two ways to pay a repair: [label + chips] in items, [label · 290 cr] in credits. A button that cannot pay is
   * disabled, still reachable by the pad, which shows why (data-pad-tip). `attrs` is their focus identity (data-*),
   * data-pay tells them apart.
   */
  private payButtons(label: string, q: RepairQuote, attrs: Record<string, string>, onPay: (pay: Pay) => void, title?: string): HTMLElement[] {
    const items = payCheck(this.state, q, 'items');
    const credits = payCheck(this.state, q, 'credits');
    const itemsTip = items.missing ? missingTip(items.missing) : undefined;
    const creditsTip = credits.short ? shortTip(credits.short, this.state.sim.credits) : undefined;
    return [
      el('button', { class: 'small repair-btn', ...attrs, 'data-pay': 'items', disabled: !items.ok, title: itemsTip ?? title ?? repairTitle(q.items), 'data-pad-tip': itemsTip, onclick: () => onPay('items') },
        label, ...this.chips(q.items)),
      el('button', { class: 'small repair-btn', ...attrs, 'data-pay': 'credits', disabled: !credits.ok, title: creditsTip ?? title, 'data-pad-tip': creditsTip, onclick: () => onPay('credits') },
        `${label} · `, el('span', { class: 'credits-text' }, formatCredits(q.credits))),
    ];
  }

  /** Main action: « Assembler ». */
  private renderDraft(r: HTMLElement, view: Extract<View, { kind: 'draft' }>, stock: ItemCounts): HTMLElement | null {
    const bp = BLUEPRINTS[view.blueprint];
    const check = checkAssembleIn(this.state, view.blueprint, view.choices, this.spot!, this.cb.bayBlocker);
    // « Poser » starts building this car in the bay with what is in stock (the bay must be empty).
    const canPose = !check.occupant && !check.build;
    let reason = '';
    if (check.occupant) reason = `La place est prise par ${check.occupant.name} : sors-la du garage pour en assembler une autre ici.`;
    else if (check.build) reason = 'Une voiture est en construction dans la place : termine-la ou abandonne-la (🔧 à gauche).';
    else if (Object.keys(check.missing).length) {
      const missing = Object.entries(check.missing).map(([i, n]) => countLabel(i as ItemId, n ?? 0));
      reason = `Il manque : ${missing.join(', ')}. Produis-les à l’usine (assembleuse).`;
    } else if (!check.ok) reason = 'Choisis toutes les pièces.';
    r.append(el('h2', {}, `Nouvelle voiture : ${bp.name}`), el('div', { class: 'muted small' }, bp.description));
    const groups = wornGroups(this.state.worn);
    for (const slot of bp.slots) {
      const row = el('div', { class: 'slot-row' }, el('b', {}, `${slot.name}${slot.count > 1 ? ` ×${slot.count}` : ''}`));
      const opts = el('div', { class: 'row', style: 'flex-wrap:wrap' });
      const options: (ItemId | null)[] = [...(slot.optional ? [null] : []), ...slot.accepts];
      for (const item of options) {
        const have = item ? (stock[item] ?? 0) : Infinity;
        const active = view.choices[slot.id] === item;
        opts.appendChild(
          this.partButton(item, item ? `${ITEMS[item].name} (${have}/${slot.count})` : 'Aucun', {
            active,
            slot: slot.id,
            onclick: () => {
              view.choices[slot.id] = item;
              this.render();
            },
          }),
        );
        if (active && item && have < slot.count) row.classList.add('lacking');
      }
      row.appendChild(opts);
      const chosen = view.choices[slot.id];
      const mod = chosen ? PART_MODIFIERS[chosen] : undefined;
      if (mod?.label && chosen !== slot.accepts[0]) row.appendChild(el('div', { class: 'muted small' }, mod.label));
      if (chosen) {
        const n = Math.min(stock[chosen] ?? 0, slot.count);
        row.appendChild(
          el('button', {
            class: 'small',
            disabled: !canPose || n === 0,
            title: n ? `Poser ${countLabel(chosen, n)} dans la place, sans attendre le reste` : `Pas de ${ITEMS[chosen].name.toLowerCase()} en stock`,
            // The title does not say why the bay refuses it.
            'data-pad-tip': canPose ? undefined : reason,
            'data-action': 'pose',
            'data-part-slot': slot.id,
            onclick: () => this.doInstall(view.blueprint, slot.id, chosen),
          }, n ? `Poser maintenant (${n}/${slot.count})` : 'Poser maintenant'),
        );
      }
      // The sets of the reserve this slot takes: one of them starts the car in the bay, with its wear.
      const fits = groups.filter((g) => slotForSet(view.blueprint, g.set)?.id === slot.id);
      if (fits.length) {
        row.appendChild(
          el('div', { class: 'row repair-row' },
            ...fits.map((g) =>
              el('button', {
                class: 'small repair-btn',
                disabled: !canPose,
                title: POSE_WORN_TITLE,
                'data-pad-tip': canPose ? undefined : reason,
                'data-action': 'pose-worn',
                'data-part-slot': slot.id,
                'data-worn': g.key,
                onclick: () => this.doInstallWornInBuild(g.key, view.blueprint, slot.id),
              }, this.icon(g.set.item), poseWornLabel(g.set)),
            ),
          ),
        );
      }
      r.appendChild(row);
    }

    const racing = this.state.selectedCar;
    r.append(
      el('h3', { style: 'margin-top:10px' }, 'Performances'),
      el('div', { class: 'muted small' }, `Comparée à ta voiture de course : ${racing?.name ?? BLUEPRINTS.loaner.name}`),
      carStatsBlock(this.draftSpec(view), specOf(racing)),
    );

    const assemble = el('button', { class: 'primary', disabled: !check.ok, title: reason, 'data-action': 'assemble', onclick: () => this.doAssemble() }, 'Assembler');
    r.append(
      el('div', { class: reason ? 'bad small' : 'muted small', style: 'margin-top:8px' }, reason || 'Le sac paie d’abord, puis le hangar. « Assembler » pose tout d’un coup ; « Poser maintenant » commence la voiture dans la place avec ce que tu as, le reste viendra plus tard.'),
      el('div', { class: 'row', style: 'margin-top:10px' }, assemble),
    );
    return check.ok ? assemble : null;
  }

  /** The car under construction in the bay: what is installed, « Poser » / « Retirer » per slot, give up. Main action: the first « Poser » in stock. */
  private renderBuild(r: HTMLElement, build: CarBuild, stock: ItemCounts): HTMLElement | null {
    let main: HTMLElement | null = null;
    const bp = BLUEPRINTS[build.blueprint];
    const { done, total } = buildProgress(build);
    r.append(
      el('h2', {}, `En construction : ${bp.name}`),
      el('div', { class: 'progress', style: 'margin-top:6px' }, el('div', { style: `width:${Math.round((done / total) * 100)}%` })),
      el('div', { class: 'muted small' }, `${done}/${total} pièces posées · la voiture sort de la place dès que les pièces obligatoires y sont.`),
    );
    const groups = wornGroups(this.state.worn);
    const planned: CarSpec['parts'] = {};
    for (const slot of bp.slots) {
      const cur = build.parts[slot.id];
      const n = cur?.n ?? 0;
      if (cur) planned[slot.id] = cur.item;
      else if (!slot.optional) planned[slot.id] = slot.accepts[0]!;
      const row = el('div', { class: `slot-row${n >= slot.count ? '' : ' lacking'}` },
        el('b', {}, `${slot.name}${slot.count > 1 ? ` ×${slot.count}` : ''}${slot.optional ? ' (facultatif)' : ''}`),
        // A worn set of the reserve shows its state: « 4/4 · Roue · 42 % » and a mini gauge.
        cur?.wear
          ? el('div', { class: 'row small' }, el('span', { class: 'good' }, `${n}/${slot.count} · ${ITEMS[cur.item].name} · ${pct(cur.wear)}`), wearGauge(cur.wear, 'mini'))
          : el('div', { class: n >= slot.count ? 'good small' : 'muted small' }, cur ? `${n}/${slot.count} · ${ITEMS[cur.item].name}` : `0/${slot.count}`),
      );
      const opts = el('div', { class: 'row', style: 'flex-wrap:wrap' });
      if (n < slot.count) {
        // A slot holds one kind of part: once started, only that one.
        for (const item of cur ? [cur.item] : slot.accepts) {
          const have = stock[item] ?? 0;
          const btn = this.partButton(item, `Poser ${ITEMS[item].name} (${have} en stock)`, {
            active: false,
            disabled: have === 0,
            tip: `Pas de ${ITEMS[item].name.toLowerCase()} en stock`,
            slot: slot.id,
            onclick: () => this.doInstall(build.blueprint, slot.id, item),
          });
          if (have > 0) main ??= btn;
          opts.appendChild(btn);
        }
      }
      if (n > 0) {
        opts.appendChild(el('button', { class: 'small', 'data-action': 'remove', 'data-part-slot': slot.id, title: cur?.wear ? REMOVE_WORN_TITLE : undefined, onclick: () => this.doRemove(slot.id) }, 'Retirer'));
      }
      row.appendChild(opts);
      // Nothing in stock for an empty slot, but a set of the reserve fits: where to find it (« Poser » is over there).
      if (n === 0 && slot.accepts.every((i) => !(stock[i] ?? 0))) {
        const fit = groups.find((g) => slotForSet(build.blueprint, g.set)?.id === slot.id);
        if (fit) row.appendChild(el('div', { class: 'muted small' }, reserveHint(fit.set)));
      }
      r.appendChild(row);
    }
    const racing = this.state.selectedCar;
    r.append(
      el('h3', { style: 'margin-top:10px' }, 'Une fois finie'),
      el('div', { class: 'muted small' }, `Comparée à ta voiture de course : ${racing?.name ?? BLUEPRINTS.loaner.name}`),
      carStatsBlock({ blueprint: build.blueprint, parts: planned }, specOf(racing)),
      el('div', { class: 'muted small', style: 'margin-top:8px' }, 'Les pièces viennent du sac, puis du hangar ; « Retirer » les rend au sac, ou à la réserve si elles sont usées.'),
    );
    if (this.confirming !== 'build') {
      r.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'danger', 'data-action': 'abandon', onclick: () => { this.confirming = 'build'; this.render(); } }, 'Abandonner')));
    } else {
      const parts = buildByState(build);
      r.appendChild(
        el('div', { class: 'garage-confirm' },
          el('div', { class: 'small' }, abandonQuestion(bp.name, parts.fresh > 0, parts.worn)),
          el('div', { class: 'row', style: 'margin-top:6px' },
            el('button', { class: 'danger small', 'data-action': 'confirm-abandon', onclick: () => this.doAbandon() }, 'Oui, abandonner'),
            this.cancelButton('cancel-abandon', () => this.cancelConfirm('abandon')),
          ),
        ),
      );
    }
    return main;
  }

  /**
   * Main action: « Courir ». A car past the race limit cannot race: « Courir » is disabled and there is no main action,
   * the focus starts on its row (the « Réparer » buttons just right of it pay; a first A must not).
   */
  private renderCar(r: HTMLElement, car: CarInstance | null, stock: ItemCounts, quotes: ShownQuotes): HTMLElement | null {
    const bp = blueprintOf(car);
    const loc = car ? carLocation(car, this.spot!, this.driven) : null;
    const block = car ? blockText(car) : null;
    append(r,
      el('h2', {}, car?.name ?? BLUEPRINTS.loaner.name),
      el('div', { class: 'small' },
        el('span', { class: 'muted' }, car ? `${bp?.name ?? car.blueprint} · ` : 'Prêt du circuit'),
        loc ? el('span', { class: loc === 'here' ? 'good' : 'muted' }, LOCATION_LABEL[loc]) : null,
      ),
      block !== null ? el('div', { class: 'wear-alert' }, blockAlert(block, loc === 'here')) : null,
      bp ? el('div', { class: 'muted small', style: 'margin-top:4px' }, bp.description) : null,
    );
    // A worn car sells for less: its new price minus its repair in credits (repairing it first brings in the same).
    const price = car ? wornCarPrice(car.blueprint, car.parts, car.wear) : 0;
    const newPrice = car ? carPrice(car.blueprint, car.parts) : 0;
    if (car) {
      r.appendChild(
        el('div', { class: 'small', style: 'margin-top:4px', title: VALUE_TITLE },
          el('span', { class: 'muted' }, 'Valeur : '), el('b', { class: 'credits-text' }, formatCredits(price)),
          price < newPrice ? el('span', { class: 'muted' }, ` ${repairedValueText(newPrice)}`) : null,
        ),
      );
    }
    if (bp) r.appendChild(carStatsBlock(specOf(car)));
    const effects = car && bp ? effectsText(wearEffects(specOf(car), car.wear)) : null;
    if (effects) r.appendChild(el('div', { class: 'muted small', style: 'margin-top:4px' }, `Effets de l’usure : ${effects}`));

    if (car && bp && loc === 'here') {
      r.appendChild(el('h3', { style: 'margin-top:10px' }, 'Pièces'));
      for (const slot of bp.slots) {
        const w = slotWear(car, slot.id);
        // Past the race limit: the slot's name in red, like a missing part.
        const row = el('div', { class: `slot-row${w > WEAR.BLOCK_ABOVE ? ' lacking' : ''}` }, this.slotHead(car, slot, `${slot.name}${slot.count > 1 ? ` ×${slot.count}` : ''}`));
        const opts = el('div', { class: 'row', style: 'flex-wrap:wrap' });
        const options: (ItemId | null)[] = [...(slot.optional ? [null] : []), ...slot.accepts];
        for (const item of options) {
          const active = (car.parts[slot.id] ?? null) === item;
          const have = item ? (stock[item] ?? 0) : 0;
          opts.appendChild(
            this.partButton(item, item ? `${ITEMS[item].name}${active ? '' : ` (${have} en stock)`}` : 'Aucun', {
              active,
              disabled: !active && item !== null && have < slot.count,
              tip: `Pas assez en stock : il en faut ${slot.count}`,
              title: item === null && !active && w > 0 ? takeOffTitle(slot.id, w) : undefined,
              slot: slot.id,
              onclick: () => this.doSwap(car.id, slot, item),
            }),
          );
        }
        row.appendChild(opts);
        const q = quotes.slots[slot.id];
        if (q) row.appendChild(this.slotRepairRow(car, slot, q, stock));
        r.appendChild(row);
      }
      r.appendChild(el('div', { class: 'muted small', style: 'margin-top:6px' }, 'Les nouvelles pièces viennent du sac, puis du hangar ; les anciennes retournent dans le sac, ou dans la réserve si elles sont usées.'));
      if (quotes.all) {
        r.appendChild(
          el('div', { class: 'row repair-row', style: 'margin-top:10px' },
            ...this.payButtons('Tout réparer', quotes.all, { 'data-action': 'repair-all' }, (pay) => this.doRepairCar(car.id, pay), REPAIR_ALL_TITLE),
          ),
        );
      }
    } else if (car && loc) {
      // Read only: the state of the installed parts.
      if (bp) {
        r.appendChild(el('h3', { style: 'margin-top:10px' }, 'État'));
        for (const slot of bp.slots) if (car.parts[slot.id]) r.appendChild(el('div', { class: 'slot-row' }, this.slotHead(car, slot)));
      }
      r.appendChild(el('div', { class: 'muted small', style: 'margin-top:8px' }, LOCATION_NOTE[loc as Exclude<CarLocation, 'here'>]));
    } else if (!car) {
      r.appendChild(el('div', { class: 'muted small', style: 'margin-top:8px' }, 'Le kart de location ne roule que sur les circuits et ne s’use pas. Construis le tien pour le conduire dans l’usine !'));
    }

    const id = car?.id ?? null;
    const isRacing = (this.state.selectedCarId ?? null) === id;
    // One confirmation at a time: « Démonter » and « Vendre » hide while either waits for its answer.
    const pending = !!car && (this.confirming === car.id || this.confirming === sellKey(car.id));
    const raceTip = block !== null ? garageRaceTip(block, loc === 'here') : undefined;
    const race = el('button', {
      class: 'primary',
      'data-action': 'race',
      disabled: block !== null,
      title: raceTip ?? 'Choisir un circuit avec cette voiture',
      'data-pad-tip': raceTip,
      onclick: () => this.doRace(id),
    }, 'Courir');
    r.appendChild(
      el('div', { class: 'row', style: 'margin-top:12px;flex-wrap:wrap' },
        race,
        el('button', { class: isRacing ? 'selected' : '', disabled: isRacing, 'data-action': 'select', onclick: () => this.doSelect(id) }, isRacing ? '★ Voiture de course' : 'Choisir pour courir'),
        car && loc === 'here' && !pending
          ? el('button', { class: 'danger', 'data-action': 'disassemble', onclick: () => { this.confirming = car.id; this.render(); } }, 'Démonter')
          : null,
        car && loc === 'here' && !pending
          ? el('button', { class: 'sell', 'data-action': 'sell', title: `Vendre pour ${formatCredits(price)}`, onclick: () => { this.confirming = sellKey(car.id); this.render(); } }, 'Vendre')
          : null,
      ),
    );
    if (car && loc === 'here' && this.confirming === sellKey(car.id)) {
      const next = isRacing ? (this.state.cars.find((c) => c !== car)?.name ?? 'le kart de location') : null;
      r.appendChild(
        el('div', { class: 'garage-confirm' },
          el('div', { class: 'small' }, `Vendre « ${car.name} » pour ${formatCredits(price)} ? Elle part avec ses pièces.`),
          price < newPrice ? el('div', { class: 'small muted' }, wornSaleNote(newPrice)) : null,
          next ? el('div', { class: 'small muted' }, `C’est ta voiture de course : ${next} prendra sa place.`) : null,
          el('div', { class: 'row', style: 'margin-top:6px' },
            el('button', { class: 'danger small', 'data-action': 'confirm-sell', onclick: () => this.doSell(car.id) }, 'Oui, vendre'),
            this.cancelButton('cancel-sell', () => this.cancelConfirm('sell')),
          ),
        ),
      );
    }
    if (car && loc === 'here' && this.confirming === car.id) {
      const parts = partsByState(car);
      r.appendChild(
        el('div', { class: 'garage-confirm' },
          el('div', { class: 'small' }, disassembleQuestion(car.name, parts.fresh > 0, parts.worn)),
          el('div', { class: 'row', style: 'margin-top:6px' },
            el('button', { class: 'danger small', 'data-action': 'confirm-disassemble', onclick: () => this.doDisassemble(car.id) }, 'Oui, démonter'),
            this.cancelButton('cancel-disassemble', () => this.cancelConfirm('disassemble')),
          ),
        ),
      );
    }
    return block !== null ? null : race;
  }

  /** Under a worn slot of the car in the bay: repair it in items or credits, or put new parts of the same kind on. */
  private slotRepairRow(car: CarInstance, slot: SlotDef, q: RepairQuote, stock: ItemCounts): HTMLElement {
    const item = car.parts[slot.id]!;
    const have = stock[item] ?? 0;
    const short = have < slot.count ? renewTip(slot.count, have) : undefined;
    return el('div', { class: 'row repair-row' },
      ...this.payButtons('Réparer', q, { 'data-action': 'repair', 'data-part-slot': slot.id }, (pay) => this.doRepairSlot(car.id, slot, pay)),
      el('button', {
        class: 'small',
        disabled: !!short,
        title: short ?? RENEW_TITLE,
        'data-pad-tip': short,
        'data-action': 'renew',
        'data-part-slot': slot.id,
        onclick: () => this.doRenew(car.id, slot),
      }, renewLabel(have)),
    );
  }

  /**
   * The reserve of worn parts, shared by every garage: grouped by (item, count, state shown), each group's buttons
   * acting on one set of it (its most worn). Repair (items or credits), sell (confirmed), put on the car in the bay or
   * into its build. No main action: the focus starts on its row (never on a button that pays).
   */
  private renderWorn(r: HTMLElement, quotes: ShownQuotes): null {
    const worn = this.state.worn;
    const car = this.hereCar();
    const build = this.build;
    const value = worn.reduce((sum, s) => sum + wornSetPrice(s.item, s.n, s.wear), 0);
    append(r,
      el('h2', {}, 'Pièces usées'),
      el('div', { class: 'muted small' }, WORN_INTRO),
      el('div', { class: 'small', style: 'margin-top:6px' }, reserveSummary(worn.length, value)),
      !car && !build ? el('div', { class: 'muted small', style: 'margin-top:4px' }, WORN_NO_TARGET) : null,
    );
    const list = el('div', { class: 'worn-list' });
    for (const g of wornGroups(worn)) {
      const s = g.set;
      const id = { 'data-worn': g.key };
      const price = wornSetPrice(s.item, s.n, s.wear);
      const q = quotes.sets[g.key] ?? setQuote(s.item, s.n, s.wear);
      const confirming = this.confirming === sellWornKey(g.key);
      const carSlot = car ? slotForSet(car.blueprint, s) : null;
      const buildSlot = build ? slotForSet(build.blueprint, s) : null;
      const buildBusy = !!buildSlot && (build!.parts[buildSlot.id]?.n ?? 0) > 0;
      const row = el('div', { class: 'worn-row' },
        el('div', { class: 'row' },
          this.icon(s.item),
          el('b', {}, countLabel(s.item, s.n)),
          g.count > 1 ? el('span', { class: 'worn-count', title: `${g.count} lots dans ce même état` }, `×${g.count}`) : null,
          el('span', { class: 'spacer' }),
          wearGauge(s.wear),
          wearPct(s.wear),
        ),
        el('div', { class: 'row repair-row' },
          ...this.payButtons('Réparer', q, { 'data-action': 'repair-worn', ...id }, (pay) => this.doRepairWorn(g.key, pay)),
          // Hidden while its sale waits for an answer (« Annuler » takes the focus, then gives it back).
          confirming
            ? null
            : el('button', { class: 'small sell', 'data-action': 'sell-worn', ...id, title: sellSetTitle(price), onclick: () => { this.confirming = sellWornKey(g.key); this.render(); } },
              'Vendre · ', el('span', { class: 'credits-text' }, formatCredits(price))),
          car && carSlot
            ? el('button', {
              class: 'small',
              'data-action': 'install-worn',
              ...id,
              // What it replaces (‰, or none) is part of its focus identity: once posed, the same group's button
              // (a ×2, or the parts taken off back in it) is another control and a second A does not swap back.
              'data-on': car.parts[carSlot.id] ? slotWear(car, carSlot.id) : 'none',
              title: installTitle(car.parts[carSlot.id] ? slotWear(car, carSlot.id) : null),
              onclick: () => this.doInstallWorn(g.key, car.id, carSlot.id),
            }, `Poser sur ${car.name}`)
            : null,
          build && buildSlot
            ? el('button', {
              class: 'small',
              'data-action': 'install-worn-build',
              ...id,
              disabled: buildBusy,
              title: buildBusy ? BUILD_SLOT_BUSY : BUILD_WORN_TITLE,
              'data-pad-tip': buildBusy ? BUILD_SLOT_BUSY : undefined,
              onclick: () => this.doInstallWornInBuild(g.key, build.blueprint, buildSlot.id),
            }, 'Poser dans le chantier')
            : null,
        ),
      );
      if (confirming) {
        row.appendChild(
          el('div', { class: 'garage-confirm' },
            el('div', { class: 'small' }, sellSetQuestion(s, price)),
            el('div', { class: 'row', style: 'margin-top:6px' },
              el('button', { class: 'danger small', 'data-action': 'confirm-sell-worn', ...id, onclick: () => this.doSellWorn(g.key) }, 'Oui, vendre'),
              this.cancelButton('cancel-sell-worn', () => this.cancelConfirm({ worn: g.key, action: 'sell-worn' })),
            ),
          ),
        );
      }
      list.appendChild(row);
    }
    r.appendChild(list);
    return null;
  }

  // ------------------------------------------------------------------ actions

  /** « Annuler »: the button that asked for the confirmation is back, and takes the pad focus again. */
  private cancelConfirm(button: PadRefocus): void {
    this.confirming = null;
    this.padRefocus = button;
    this.render();
  }

  private doAssemble(): void {
    const view = this.view;
    if (view.kind !== 'draft' || !this.spot) return;
    const check = checkAssembleIn(this.state, view.blueprint, view.choices, this.spot, this.cb.bayBlocker);
    const car = assembleCar(this.state, view.blueprint, view.choices, this.spot, this.cb.bayBlocker);
    if (!car) {
      toast(check.occupant ? 'La place est prise' : 'Pièces insuffisantes', 'error');
      return this.render();
    }
    toast(`${car.name} assemblée !`, 'success');
    this.view = { kind: 'car', id: car.id };
    // The new car's row, where a second A does nothing (« Courir » would leave the factory).
    this.padRefocus = 'row';
    this.commit();
  }

  private doInstall(blueprint: BlueprintId, slotId: string, item: ItemId): void {
    if (!this.spot) return;
    const res = installBuildPart(this.state, this.spot, blueprint, slotId, item, this.cb.bayBlocker);
    if (!res.n) {
      toast('Rien à poser : pièce absente du stock, ou place prise', 'error');
      return this.render();
    }
    this.confirming = null;
    if (res.car) {
      toast(`${res.car.name} terminée !`, 'success', 2400);
      this.view = { kind: 'car', id: res.car.id };
    } else {
      toast(`Posé : ${countLabel(item, res.n)}`, 'success', 1400);
      this.view = { kind: 'build' };
    }
    // A full slot loses its « Poser »: the focus goes to the next part to pose.
    this.padRefocus = res.car ? 'row' : 'main';
    this.commit();
  }

  private doRemove(slotId: string): void {
    if (!this.spot) return;
    // A worn set goes back to the reserve: read it before it leaves the build.
    const cur = this.build?.parts[slotId];
    const worn = cur?.wear ? { item: cur.item, n: cur.n, wear: cur.wear } : null;
    const res = removeBuildPart(this.state, this.spot.id, slotId);
    if (!res.n) return this.render();
    if (worn) toast(wornRemovedText(worn), 'success', 1800);
    else toast(res.toHub ? `Retiré : ${res.n} pièce${res.n > 1 ? 's' : ''} (${res.toHub} au hangar, sac plein)` : `Retiré : ${res.n} pièce${res.n > 1 ? 's' : ''}, dans ton sac`, 'success', 1600);
    if (!this.build) {
      this.view = this.defaultView();
      this.padRefocus = 'row';
    }
    this.commit();
  }

  private doAbandon(): void {
    this.confirming = null;
    if (!this.spot) return;
    const build = this.build;
    const parts = build ? buildByState(build) : { fresh: 0, worn: 0 };
    const res = abandonBuild(this.state, this.spot.id);
    if (!res) return this.render();
    toast(abandonedText(parts.fresh > 0, res.toHub, parts.worn), 'success', 2200);
    this.view = this.defaultView();
    this.padRefocus = 'row';
    this.commit();
  }

  private doDisassemble(carId: string): void {
    this.confirming = null;
    const res = disassembleCar(this.state, carId);
    if (!res) return this.render();
    toast(disassembledText(res.car.name, Object.keys(res.refund).length > 0, res.toHub, res.worn.length), 'success', 2400);
    this.view = this.defaultView();
    this.padRefocus = 'row';
    this.commit();
  }

  private doSell(carId: string): void {
    this.confirming = null;
    const res = sellCar(this.state, carId);
    if (!res) return this.render();
    toast(`${res.car.name} vendue : +${formatCredits(res.price)}`, 'success', 2400);
    this.view = this.defaultView();
    this.padRefocus = 'row';
    this.commit();
  }

  /** Another part (or none) in a slot of the car in the bay: worn parts taken off go to the reserve. */
  private doSwap(carId: string, slot: SlotDef, item: ItemId | null): void {
    const car = findCar(this.state, carId);
    if (!car) return this.render();
    const old = car.parts[slot.id] ?? null;
    const w = slotWear(car, slot.id);
    // Same part again (or not enough in stock): nothing changed, no message.
    if (!swapCarPart(this.state, carId, slot.id, item)) return this.render();
    const worn = old && w > 0 ? { item: old, n: slot.count, wear: w } : null;
    toast(swappedText(item !== null, worn), 'success', worn ? 2200 : 1400);
    this.commit();
  }

  /** Repairs one slot of the car in the bay; the focus goes to its active part (A on it does nothing). */
  private doRepairSlot(carId: string, slot: SlotDef, pay: Pay): void {
    const car = this.hereCar(carId);
    const q = car ? slotQuote(car, slot.id) : null;
    if (!car || !q) return this.render();
    const check = payCheck(this.state, q, pay);
    const res = repairCarSlot(this.state, carId, slot.id, pay);
    if (!res) {
      if (!check.ok) toast(refusedText(check), 'error');
      return this.render();
    }
    toast(slotRepairedText(slot.id, res.paid), 'success', 2000);
    this.padRefocus = { slot: slot.id };
    this.commit();
  }

  /** « Tout réparer »: every worn slot at once; the focus goes to the car's row, never to « Courir ». */
  private doRepairCar(carId: string, pay: Pay): void {
    const car = this.hereCar(carId);
    const q = car ? carQuote(car) : null;
    if (!car || !q) return this.render();
    const check = payCheck(this.state, q, pay);
    const res = repairCar(this.state, carId, pay);
    if (!res) {
      if (!check.ok) toast(refusedText(check), 'error');
      return this.render();
    }
    toast(carRepairedText(car.name, res.paid), 'success', 2400);
    this.padRefocus = 'row';
    this.commit();
  }

  /** « Remplacer par du neuf »: new parts of the same kind from the stock, the worn ones to the reserve. */
  private doRenew(carId: string, slot: SlotDef): void {
    const car = this.hereCar(carId);
    if (!car) return this.render();
    const item = car.parts[slot.id];
    const have = item ? (partStock(this.state)[item] ?? 0) : 0;
    const set = renewCarSlot(this.state, carId, slot.id);
    if (!set) {
      if (item && have < slot.count) toast(renewTip(slot.count, have), 'error');
      return this.render();
    }
    toast(swappedText(true, set), 'success', 2200);
    this.padRefocus = { slot: slot.id };
    this.commit();
  }

  /**
   * After a set of the reserve was repaired, sold or put somewhere: the same button of its group while the group
   * lasts, else the reserve's row; the reserve emptied, back to the bay's view.
   */
  private afterWornChange(key: string, refocus: PadRefocus): void {
    this.confirming = null;
    if (!this.state.worn.length) {
      this.view = this.defaultView();
      this.padRefocus = 'row';
    } else this.padRefocus = this.wornGroup(key) ? refocus : 'row';
  }

  private doRepairWorn(key: string, pay: Pay): void {
    const g = this.wornGroup(key);
    if (!g) return this.render();
    const set = g.set;
    const check = payCheck(this.state, setQuote(set.item, set.n, set.wear), pay);
    const res = repairWornSet(this.state, set, pay);
    if (!res) {
      if (!check.ok) toast(refusedText(check), 'error');
      return this.render();
    }
    toast(setRepairedText(set, res.paid, res.toHub), 'success', 2200);
    this.afterWornChange(key, { worn: key, action: 'repair-worn', pay });
    this.commit();
  }

  private doSellWorn(key: string): void {
    this.confirming = null;
    const g = this.wornGroup(key);
    const res = g ? sellWornSet(this.state, g.set) : null;
    if (!g || !res) return this.render();
    toast(setSoldText(g.set, res.price), 'success', 2200);
    this.afterWornChange(key, { worn: key, action: 'sell-worn' });
    this.commit();
  }

  /** Puts a set of the reserve on the car in the bay; the focus goes to the reserve's row (a second A does not swap back). */
  private doInstallWorn(key: string, carId: string, slotId: string): void {
    const g = this.wornGroup(key);
    const car = this.hereCar(carId);
    if (!g || !car) return this.render();
    const inPlace = car.parts[slotId] ? (slotWear(car, slotId as SlotDef['id']) > 0 ? 'worn' : 'new') : null;
    const set = g.set;
    if (!installWornSet(this.state, carId, slotId, set)) return this.render();
    toast(installedOnCarText(car.name, set, inPlace), 'success', 2400);
    this.afterWornChange(key, 'row');
    this.commit();
  }

  /**
   * Puts a set of the reserve into the build in the bay, or starts one with it (from a draft). The car rolls out when
   * it was the last required slot.
   */
  private doInstallWornInBuild(key: string, blueprint: BlueprintId, slotId: string): void {
    if (!this.spot) return;
    const g = this.wornGroup(key);
    const set = g?.set;
    const res = set ? installWornInBuild(this.state, this.spot, blueprint, slotId, set, this.cb.bayBlocker) : null;
    if (!set || !res) {
      toast(WORN_POSE_REFUSED, 'error');
      return this.render();
    }
    const fromDraft = this.view.kind === 'draft';
    this.afterWornChange(key, 'row');
    if (res.car) {
      toast(`${res.car.name} terminée !`, 'success', 2400);
      this.view = { kind: 'car', id: res.car.id };
      this.padRefocus = 'row';
    } else {
      toast(installedInBuildText(set), 'success', 1800);
      // Started from a draft: the build now stands in the bay, its next « Poser » takes the focus.
      if (fromDraft || this.view.kind !== 'worn') {
        this.view = { kind: 'build' };
        this.padRefocus = 'main';
      }
    }
    this.commit();
  }

  private doSelect(carId: string | null): void {
    if (selectRaceCar(this.state, carId)) SaveManager.save(this.state);
    this.render();
  }

  private doRace(carId: string | null): void {
    if (selectRaceCar(this.state, carId)) SaveManager.save(this.state);
    this.cb.race(carId);
  }

  /** For automated checks. */
  debugState() {
    return {
      open: this.isOpen,
      garage: this.spot,
      view: this.view,
      confirming: this.confirming,
      occupant: this.spot ? (this.occupant(this.spot)?.id ?? null) : null,
      stock: partStock(this.state),
      worn: this.state.worn.length,
      renders: this.renders,
    };
  }
}
