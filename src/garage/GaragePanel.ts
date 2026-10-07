import { BLUEPRINTS, BLUEPRINT_IDS, type Blueprint, type BlueprintId } from '../data/blueprints';
import { ITEMS, countLabel, type Inventory as ItemCounts, type ItemId } from '../data/items';
import { PART_MODIFIERS } from '../data/parts';
import type { CarSpec } from '../car/stats';
import type { ItemIcons } from '../core/assets/IconRenderer';
import type { GameState } from '../state/GameState';
import { SaveManager } from '../state/SaveManager';
import { carStatsBlock } from '../ui/carStats';
import { append, clear, el, toast } from '../ui/dom';
import { bestChoices, checkAssembly, specOf, type CarInstance, type PartChoices } from './assembly';
import { CAR_PARTS, assembleCar, carLocation, checkAssembleIn, disassembleCar, findCar, partStock, selectRaceCar, swapCarPart, type CarLocation } from './actions';
import { bayOccupant, type BayBlocker, type GarageSpot } from './parking';

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

type View = { kind: 'car'; id: string | null } | { kind: 'draft'; blueprint: BlueprintId; choices: PartChoices };

const LOCATION_LABEL: Record<CarLocation, string> = { here: 'Dans ce garage', elsewhere: 'Garée ailleurs', driving: 'En route', unplaced: 'À ranger' };

const LOCATION_NOTE: Record<Exclude<CarLocation, 'here'>, string> = {
  elsewhere: 'Garée hors de ce garage : amène-la dans la place pour changer ses pièces ou la démonter.',
  driving: 'Tu la conduis : gare-la dans ce garage pour changer ses pièces ou la démonter.',
  unplaced: 'Elle attend une place libre : pose un garage ou libère une place.',
};

function blueprintOf(car: CarInstance | null): Blueprint | undefined {
  return BLUEPRINTS[(car?.blueprint ?? 'loaner') as BlueprintId];
}

/**
 * Garage panel over the factory (E on a garage): the cars and where they are, new-car drafts, part swaps
 * and dismantling for the car standing in this garage's bay, the race car and « Courir ».
 * Two side columns so the bay stays visible in the middle of the screen.
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
    this.spot = { id: garage.id, x: garage.x, z: garage.z, rot: garage.rot };
    this.view = this.defaultView();
    this.root = el('div', { class: 'garage-panel' }, this.left, this.right);
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
    if (this.contentKey() !== this.key) this.render();
  }

  /** Car blocking this garage's bay (centered in it, or overlapping it). */
  private occupant(spot: GarageSpot): CarInstance | null {
    return bayOccupant(this.state.cars, spot, this.cb.bayBlocker);
  }

  /** Draft to show as a ghost in the empty bay (same object while it does not change), null otherwise. */
  get preview(): { spec: CarSpec } | null {
    if (!this.spot || this.view.kind !== 'draft' || this.occupant(this.spot)) return null;
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
    return [CAR_PARTS.map((i) => stock[i] ?? 0).join(','), cars, this.occupant(spot)?.id, this.state.selectedCarId, JSON.stringify(this.view), this.confirming].join('#');
  }

  // ------------------------------------------------------------------ UI

  private render(): void {
    if (!this.root || !this.spot) return;
    this.key = this.contentKey();
    const stock = partStock(this.state);
    this.renderLeft(stock);
    this.renderRight(stock);
  }

  private renderLeft(stock: ItemCounts): void {
    const l = this.left;
    const scroll = l.scrollTop;
    clear(l);
    const occupant = this.occupant(this.spot!);
    l.append(
      el('div', { class: 'row' }, el('h2', {}, 'Garage'), el('span', { class: 'spacer' }), el('button', { class: 'small', 'data-action': 'close', onclick: () => this.cb.close() }, 'Fermer')),
      el('div', { class: 'muted small' }, occupant ? `Dans la place : ${occupant.name}` : 'Place libre : assemble une voiture ici.'),
      el('h3', { style: 'margin-top:10px' }, 'Mes voitures'),
    );
    const driven = this.driven;
    const row = (id: string | null, name: string, sub: HTMLElement) => {
      const viewing = this.view.kind === 'car' && this.view.id === id;
      const racing = (this.state.selectedCarId ?? null) === id;
      return el('button', { class: `car-row${viewing ? ' selected' : ''}`, 'data-car': id ?? 'loaner', onclick: () => this.show({ kind: 'car', id }) },
        el('span', { class: 'car-star', title: racing ? 'Voiture de course' : '' }, racing ? '★' : '☆'),
        el('span', { class: 'col', style: 'gap:0' }, el('b', {}, name), sub),
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
    for (const id of BLUEPRINT_IDS) {
      const bp = BLUEPRINTS[id];
      if (!bp.buildable) continue;
      const drafting = this.view.kind === 'draft' && this.view.blueprint === id;
      const ok = checkAssembly(stock, id, bestChoices(bp, stock)).ok;
      l.appendChild(
        el('button', { class: `car-row${drafting ? ' selected' : ''}`, 'data-blueprint': id, onclick: () => this.show(this.newDraft(id)) },
          el('span', { class: 'car-star' }, '+'),
          el('span', { class: 'col', style: 'gap:0' }, el('b', {}, bp.name), el('span', { class: ok ? 'good small' : 'muted small' }, ok ? 'Pièces disponibles !' : 'Pièces à produire')),
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
  }

  private renderRight(stock: ItemCounts): void {
    const r = this.right;
    const scroll = r.scrollTop;
    clear(r);
    if (this.view.kind === 'draft') this.renderDraft(r, this.view, stock);
    else this.renderCar(r, findCar(this.state, this.view.id), stock);
    r.scrollTop = scroll;
  }

  private partButton(item: ItemId | null, label: string, attrs: { active: boolean; disabled?: boolean; slot: string; onclick: () => void }): HTMLElement {
    return el('button', {
      class: `small part-btn${attrs.active ? ' selected' : ''}`,
      disabled: attrs.disabled,
      'data-part-slot': attrs.slot,
      'data-item': item ?? 'none',
      onclick: attrs.onclick,
    }, item ? this.icon(item) : null, label);
  }

  private renderDraft(r: HTMLElement, view: Extract<View, { kind: 'draft' }>, stock: ItemCounts): void {
    const bp = BLUEPRINTS[view.blueprint];
    const check = checkAssembleIn(this.state, view.blueprint, view.choices, this.spot!, this.cb.bayBlocker);
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
      r.appendChild(row);
    }

    const racing = this.state.selectedCar;
    r.append(
      el('h3', { style: 'margin-top:10px' }, 'Performances'),
      el('div', { class: 'muted small' }, `Comparée à ta voiture de course : ${racing?.name ?? BLUEPRINTS.loaner.name}`),
      carStatsBlock(this.draftSpec(view), specOf(racing)),
    );

    let reason = '';
    if (check.occupant) reason = `La place est prise par ${check.occupant.name} : sors-la du garage pour en assembler une autre ici.`;
    else if (Object.keys(check.missing).length) {
      const missing = Object.entries(check.missing).map(([i, n]) => countLabel(i as ItemId, n ?? 0));
      reason = `Il manque : ${missing.join(', ')}. Produis-les à l’usine (assembleuse).`;
    } else if (!check.ok) reason = 'Choisis toutes les pièces.';
    r.append(
      el('div', { class: reason ? 'bad small' : 'muted small', style: 'margin-top:8px' }, reason || 'Le sac paie d’abord, puis le hangar. La voiture sort dans la place de ce garage.'),
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { class: 'primary', disabled: !check.ok, title: reason, 'data-action': 'assemble', onclick: () => this.doAssemble() }, 'Assembler'),
      ),
    );
  }

  private renderCar(r: HTMLElement, car: CarInstance | null, stock: ItemCounts): void {
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
    r.appendChild(
      el('div', { class: 'row', style: 'margin-top:12px;flex-wrap:wrap' },
        el('button', { class: 'primary', 'data-action': 'race', title: 'Choisir un circuit avec cette voiture', onclick: () => this.doRace(id) }, 'Courir'),
        el('button', { class: isRacing ? 'selected' : '', disabled: isRacing, 'data-action': 'select', onclick: () => this.doSelect(id) }, isRacing ? '★ Voiture de course' : 'Choisir pour courir'),
        car && loc === 'here' && this.confirming !== car.id
          ? el('button', { class: 'danger', 'data-action': 'disassemble', onclick: () => { this.confirming = car.id; this.render(); } }, 'Démonter')
          : null,
      ),
    );
    if (car && loc === 'here' && this.confirming === car.id) {
      r.appendChild(
        el('div', { class: 'garage-confirm' },
          el('div', { class: 'small' }, `Démonter « ${car.name} » ? Les pièces vont dans ton sac (le surplus au hangar).`),
          el('div', { class: 'row', style: 'margin-top:6px' },
            el('button', { class: 'danger small', 'data-action': 'confirm-disassemble', onclick: () => this.doDisassemble(car.id) }, 'Oui, démonter'),
            el('button', { class: 'small', 'data-action': 'cancel-disassemble', onclick: () => { this.confirming = null; this.render(); } }, 'Annuler'),
          ),
        ),
      );
    }
  }

  // ------------------------------------------------------------------ actions

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
    this.commit();
  }

  private doDisassemble(carId: string): void {
    this.confirming = null;
    const res = disassembleCar(this.state, carId);
    if (!res) return this.render();
    const n = res.toHub;
    toast(n ? `${res.car.name} démontée : pièces dans ton sac, ${n} au hangar (sac plein)` : `${res.car.name} démontée : pièces dans ton sac`, 'success', 2400);
    this.view = this.defaultView();
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
