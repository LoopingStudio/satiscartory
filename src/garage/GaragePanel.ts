import { BLUEPRINTS, BLUEPRINT_IDS, type Blueprint, type BlueprintId } from '../data/blueprints';
import { ITEMS, countLabel, type Inventory as ItemCounts, type ItemId } from '../data/items';
import { PART_MODIFIERS } from '../data/parts';
import type { CarSpec } from '../car/stats';
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

type View = { kind: 'car'; id: string | null } | { kind: 'draft'; blueprint: BlueprintId; choices: PartChoices } | { kind: 'build' };
/**
 * Who takes the pad focus when a click made the focused control go away: the view's main action (else its row),
 * its row on the left (after a car was finished or taken apart: a second A press does nothing), or a button.
 */
type PadRefocus = 'main' | 'row' | 'disassemble' | 'abandon' | 'sell';

/** Key of a pending « Vendre » confirmation (a bare car id is a pending « Démonter », 'build' an « Abandonner »). */
const sellKey = (carId: string) => `sell:${carId}`;

const LOCATION_LABEL: Record<CarLocation, string> = { here: 'Dans ce garage', elsewhere: 'Garée ailleurs', driving: 'En route', unplaced: 'À ranger' };

const LOCATION_NOTE: Record<Exclude<CarLocation, 'here'>, string> = {
  elsewhere: 'Garée hors de ce garage : amène-la dans la place pour changer ses pièces, la démonter ou la vendre.',
  driving: 'Tu la conduis : gare-la dans ce garage pour changer ses pièces, la démonter ou la vendre.',
  unplaced: 'Elle attend une place libre : pose un garage ou libère une place.',
};

function blueprintOf(car: CarInstance | null): Blueprint | undefined {
  return BLUEPRINTS[(car?.blueprint ?? 'loaner') as BlueprintId];
}

/**
 * Garage panel over the factory (E on a garage): the cars and where they are, new-car drafts, part swaps,
 * dismantling and selling for the car standing in this garage's bay, the race car and « Courir ».
 * Two side columns so the bay stays visible in the middle of the screen.
 * Pad (PadNav scope): B closes (or cancels a pending confirmation), LB/RB step through the left list, the
 * focus starts on the view's main action (« Assembler », the next « Poser », « Courir »).
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

  /** Live update (~5 Hz): re-renders only when parts in stock, cars, the race car or the view changed. */
  refresh(): void {
    const spot = this.spot;
    if (!spot) return;
    // The garage was dismantled (or the game replaced) under the panel.
    if (this.state.sim.buildings.get(spot.id)?.type !== 'garage') return this.cb.close();
    if (this.view.kind === 'car' && this.view.id !== null && !findCar(this.state, this.view.id)) this.view = this.defaultView();
    if (this.view.kind === 'build' && !this.build) this.view = this.defaultView();
    if (this.contentKey() !== this.key) this.render();
  }

  /** Car blocking this garage's bay (centered in it, or overlapping it). */
  private occupant(spot: GarageSpot): CarInstance | null {
    return bayOccupant(this.state.cars, spot, this.cb.bayBlocker);
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

  private show(view: View): void {
    this.view = view;
    this.confirming = null;
    this.render();
  }

  /** Cars changed: save, let the owner re-sync the physical cars, redraw. */
  private commit(): void {
    SaveManager.save(this.state);
    this.cb.changed();
    this.render();
  }

  /** The part counts, cars (parts and location), bay occupant, race car and view: what the panel shows. */
  private contentKey(): string {
    const spot = this.spot!;
    const stock = partStock(this.state);
    const driven = this.driven;
    const cars = this.state.cars.map((c) => `${c.id}:${c.name}:${JSON.stringify(c.parts)}:${carLocation(c, spot, driven)}`).join('|');
    return [CAR_PARTS.map((i) => stock[i] ?? 0).join(','), cars, this.occupant(spot)?.id, JSON.stringify(this.build), this.state.selectedCarId, JSON.stringify(this.view), this.confirming, this.state.sim.credits].join('#');
  }

  // ------------------------------------------------------------------ UI

  private render(): void {
    if (!this.root || !this.spot) return;
    this.key = this.contentKey();
    const stock = partStock(this.state);
    const row = this.renderLeft(stock);
    const main = this.renderRight(stock);
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
    const target = refocus === 'main' ? (main ?? row) : refocus === 'row' ? row : this.right.querySelector(`[data-action="${refocus}"]`);
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
        // Always shown: cars sell here (the storage panel with the balance is hidden while the garage is open).
        el('span', { class: 'credits', title: 'Crédits : ventes de voitures (garages et concessions)' }, formatCredits(this.state.sim.credits)),
        el('button', { class: 'small', 'data-action': 'close', 'data-pad-btn': 'b', onclick: () => this.cb.close() }, 'Fermer'),
      ),
      el('div', { class: 'muted small' },
        occupant
          ? `Dans la place : ${occupant.name}`
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
    const row = (id: string | null, name: string, sub: HTMLElement) => {
      const viewing = this.view.kind === 'car' && this.view.id === id;
      const racing = (this.state.selectedCarId ?? null) === id;
      return pick(
        el('button', { class: `car-row${viewing ? ' selected' : ''}`, 'data-car': id ?? 'loaner', 'data-pad-tab': true, 'data-pad-tip': racing ? 'Voiture de course' : undefined, onclick: () => this.show({ kind: 'car', id }) },
          el('span', { class: 'car-star', title: racing ? 'Voiture de course' : '' }, racing ? '★' : '☆'),
          el('span', { class: 'col', style: 'gap:0' }, el('b', {}, name), sub),
        ),
        viewing,
      );
    };
    l.appendChild(row(null, BLUEPRINTS.loaner.name, el('span', { class: 'muted small' }, 'Prêt du circuit · courses seulement')));
    for (const c of this.state.cars) {
      const loc = carLocation(c, this.spot!, driven);
      l.appendChild(
        row(c.id, c.name, el('span', { class: 'small' },
          el('span', { class: 'muted' }, `${blueprintOf(c)?.name ?? c.blueprint} · `),
          el('span', { class: loc === 'here' ? 'good' : 'muted' }, LOCATION_LABEL[loc]),
        )),
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
  private renderRight(stock: ItemCounts): HTMLElement | null {
    const r = this.right;
    const scroll = r.scrollTop;
    clear(r);
    const build = this.build;
    let main: HTMLElement | null = null;
    if (this.view.kind === 'draft') main = this.renderDraft(r, this.view, stock);
    else if (this.view.kind === 'build' && build) main = this.renderBuild(r, build, stock);
    else if (this.view.kind === 'car') main = this.renderCar(r, findCar(this.state, this.view.id), stock);
    r.scrollTop = scroll;
    return main;
  }

  /** `tip`: why it is disabled, for the pad (no hover). */
  private partButton(item: ItemId | null, label: string, attrs: { active: boolean; disabled?: boolean; tip?: string; slot: string; onclick: () => void }): HTMLElement {
    return el('button', {
      class: `small part-btn${attrs.active ? ' selected' : ''}`,
      disabled: attrs.disabled,
      'data-part-slot': attrs.slot,
      'data-item': item ?? 'none',
      // Part of the pad focus identity: the same part in another view (build → finished car) is another control.
      'data-view': this.view.kind,
      'data-pad-tip': attrs.disabled ? attrs.tip : undefined,
      onclick: attrs.onclick,
    }, item ? this.icon(item) : null, label);
  }

  /** « Annuler » of a pending confirmation: wins B over « Fermer », takes the focus from the button it replaced. */
  private cancelButton(action: string, onclick: () => void): HTMLElement {
    return el('button', { class: 'small', 'data-action': action, 'data-pad-btn': 'b', 'data-pad-prio': 1, 'data-pad-autofocus': true, onclick }, 'Annuler');
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
    const planned: CarSpec['parts'] = {};
    for (const slot of bp.slots) {
      const cur = build.parts[slot.id];
      const n = cur?.n ?? 0;
      if (cur) planned[slot.id] = cur.item;
      else if (!slot.optional) planned[slot.id] = slot.accepts[0]!;
      const row = el('div', { class: `slot-row${n >= slot.count ? '' : ' lacking'}` },
        el('b', {}, `${slot.name}${slot.count > 1 ? ` ×${slot.count}` : ''}${slot.optional ? ' (facultatif)' : ''}`),
        el('div', { class: n >= slot.count ? 'good small' : 'muted small' }, cur ? `${n}/${slot.count} · ${ITEMS[cur.item].name}` : `0/${slot.count}`),
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
      if (n > 0) opts.appendChild(el('button', { class: 'small', 'data-action': 'remove', 'data-part-slot': slot.id, onclick: () => this.doRemove(slot.id) }, 'Retirer'));
      row.appendChild(opts);
      r.appendChild(row);
    }
    const racing = this.state.selectedCar;
    r.append(
      el('h3', { style: 'margin-top:10px' }, 'Une fois finie'),
      el('div', { class: 'muted small' }, `Comparée à ta voiture de course : ${racing?.name ?? BLUEPRINTS.loaner.name}`),
      carStatsBlock({ blueprint: build.blueprint, parts: planned }, specOf(racing)),
      el('div', { class: 'muted small', style: 'margin-top:8px' }, 'Les pièces viennent du sac, puis du hangar ; « Retirer » les rend au sac.'),
    );
    if (this.confirming !== 'build') {
      r.appendChild(el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'danger', 'data-action': 'abandon', onclick: () => { this.confirming = 'build'; this.render(); } }, 'Abandonner')));
    } else {
      r.appendChild(
        el('div', { class: 'garage-confirm' },
          el('div', { class: 'small' }, `Abandonner ce ${bp.name} ? Les pièces posées vont dans ton sac (le surplus au hangar).`),
          el('div', { class: 'row', style: 'margin-top:6px' },
            el('button', { class: 'danger small', 'data-action': 'confirm-abandon', onclick: () => this.doAbandon() }, 'Oui, abandonner'),
            this.cancelButton('cancel-abandon', () => this.cancelConfirm('abandon')),
          ),
        ),
      );
    }
    return main;
  }

  /** Main action: « Courir ». */
  private renderCar(r: HTMLElement, car: CarInstance | null, stock: ItemCounts): HTMLElement {
    const bp = blueprintOf(car);
    const loc = car ? carLocation(car, this.spot!, this.driven) : null;
    append(r,
      el('h2', {}, car?.name ?? BLUEPRINTS.loaner.name),
      el('div', { class: 'small' },
        el('span', { class: 'muted' }, car ? `${bp?.name ?? car.blueprint} · ` : 'Prêt du circuit'),
        loc ? el('span', { class: loc === 'here' ? 'good' : 'muted' }, LOCATION_LABEL[loc]) : null,
      ),
      bp ? el('div', { class: 'muted small', style: 'margin-top:4px' }, bp.description) : null,
    );
    const price = car ? carPrice(car.blueprint, car.parts) : 0;
    if (car) {
      r.appendChild(
        el('div', { class: 'small', style: 'margin-top:4px', title: 'Prix de vente au garage ou dans une concession : la valeur de ses pièces, plus 25 %' },
          el('span', { class: 'muted' }, 'Valeur : '), el('b', { class: 'credits-text' }, formatCredits(price))),
      );
    }
    if (bp) r.appendChild(carStatsBlock(specOf(car)));

    if (car && bp && loc === 'here') {
      r.appendChild(el('h3', { style: 'margin-top:10px' }, 'Pièces'));
      for (const slot of bp.slots) {
        const row = el('div', { class: 'slot-row' }, el('b', {}, `${slot.name}${slot.count > 1 ? ` ×${slot.count}` : ''}`));
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
              slot: slot.id,
              onclick: () => {
                // Same part again (or not enough in stock): nothing changed, no message.
                if (!swapCarPart(this.state, car.id, slot.id, item)) return this.render();
                toast(item ? 'Pièce changée' : 'Pièce retirée', 'success', 1400);
                this.commit();
              },
            }),
          );
        }
        row.appendChild(opts);
        r.appendChild(row);
      }
      r.appendChild(el('div', { class: 'muted small', style: 'margin-top:6px' }, 'Les nouvelles pièces viennent du sac, puis du hangar ; les anciennes retournent dans le sac.'));
    } else if (car && loc) {
      r.appendChild(el('div', { class: 'muted small', style: 'margin-top:8px' }, LOCATION_NOTE[loc as Exclude<CarLocation, 'here'>]));
    } else if (!car) {
      r.appendChild(el('div', { class: 'muted small', style: 'margin-top:8px' }, 'Le kart de location ne roule que sur les circuits. Construis le tien pour le conduire dans l’usine !'));
    }

    const id = car?.id ?? null;
    const isRacing = (this.state.selectedCarId ?? null) === id;
    // One confirmation at a time: « Démonter » and « Vendre » hide while either waits for its answer.
    const pending = !!car && (this.confirming === car.id || this.confirming === sellKey(car.id));
    const race = el('button', { class: 'primary', 'data-action': 'race', title: 'Choisir un circuit avec cette voiture', onclick: () => this.doRace(id) }, 'Courir');
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
          next ? el('div', { class: 'small muted' }, `C’est ta voiture de course : ${next} prendra sa place.`) : null,
          el('div', { class: 'row', style: 'margin-top:6px' },
            el('button', { class: 'danger small', 'data-action': 'confirm-sell', onclick: () => this.doSell(car.id) }, 'Oui, vendre'),
            this.cancelButton('cancel-sell', () => this.cancelConfirm('sell')),
          ),
        ),
      );
    }
    if (car && loc === 'here' && this.confirming === car.id) {
      r.appendChild(
        el('div', { class: 'garage-confirm' },
          el('div', { class: 'small' }, `Démonter « ${car.name} » ? Les pièces vont dans ton sac (le surplus au hangar).`),
          el('div', { class: 'row', style: 'margin-top:6px' },
            el('button', { class: 'danger small', 'data-action': 'confirm-disassemble', onclick: () => this.doDisassemble(car.id) }, 'Oui, démonter'),
            this.cancelButton('cancel-disassemble', () => this.cancelConfirm('disassemble')),
          ),
        ),
      );
    }
    return race;
  }

  // ------------------------------------------------------------------ actions

  /** « Annuler »: the button that asked for the confirmation is back, and takes the pad focus again. */
  private cancelConfirm(button: 'disassemble' | 'abandon' | 'sell'): void {
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
    const res = removeBuildPart(this.state, this.spot.id, slotId);
    if (!res.n) return this.render();
    toast(res.toHub ? `Retiré : ${res.n} pièce${res.n > 1 ? 's' : ''} (${res.toHub} au hangar, sac plein)` : `Retiré : ${res.n} pièce${res.n > 1 ? 's' : ''}, dans ton sac`, 'success', 1600);
    if (!this.build) {
      this.view = this.defaultView();
      this.padRefocus = 'row';
    }
    this.commit();
  }

  private doAbandon(): void {
    this.confirming = null;
    if (!this.spot) return;
    const res = abandonBuild(this.state, this.spot.id);
    if (!res) return this.render();
    toast(res.toHub ? `Chantier abandonné : pièces dans ton sac, ${res.toHub} au hangar (sac plein)` : 'Chantier abandonné : pièces dans ton sac', 'success', 2200);
    this.view = this.defaultView();
    this.padRefocus = 'row';
    this.commit();
  }

  private doDisassemble(carId: string): void {
    this.confirming = null;
    const res = disassembleCar(this.state, carId);
    if (!res) return this.render();
    const n = res.toHub;
    toast(n ? `${res.car.name} démontée : pièces dans ton sac, ${n} au hangar (sac plein)` : `${res.car.name} démontée : pièces dans ton sac`, 'success', 2400);
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
    };
  }
}
