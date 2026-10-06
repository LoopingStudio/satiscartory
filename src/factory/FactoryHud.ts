import { BUILDINGS, BUILD_MENU, type BuildingType } from '../data/buildings';
import { ITEMS, ITEM_IDS, countLabel, type Inventory as ItemCounts, type ItemId } from '../data/items';
import { recipesFor, RECIPES_BY_ID, type Recipe } from '../data/recipes';
import { DRILL, MACHINE } from '../data/balance';
import { RESOURCES } from '../data/factoryMap';
import { clear, createLayer, el } from '../ui/dom';
import type { FactorySim } from './sim/FactorySim';
import type { DrillB, MachineB } from './sim/types';
import type { Tool } from './build/BuildController';
import type { Inventory, Stack, Wallet } from '../state/Inventory';
import type { ItemIcons } from '../core/assets/IconRenderer';
import { INVENTORY } from '../data/inventory';

const STATUS_LABEL = { working: 'En production', idle: 'En attente d’entrées', blocked: 'Sortie pleine', noRecipe: 'Aucune recette' } as const;

function itemLabel(stacks: { item: ItemId; count: number }[]): string {
  return stacks.map((s) => countLabel(s.item, s.count)).join(' + ');
}

export function costText(cost: ItemCounts): string {
  return Object.entries(cost)
    .map(([i, n]) => countLabel(i as ItemId, n ?? 0))
    .join(', ');
}

export interface HudCallbacks {
  selectTool(tool: Tool): void;
  setRecipe(machineId: number, recipe: string): void;
  /** Manual feeding (backpack first, then hub). */
  loadMachine(machineId: number): void;
  /** Takes a producer's output into the backpack. */
  collect(buildingId: number): void;
  /** Hub → backpack (one stack of `item`). */
  takeFromHub(item: ItemId): void;
  /** Backpack slot → hub. */
  depositSlot(slot: number): void;
  /** Drag and drop inside the backpack (move, merge or swap). */
  moveSlot(from: number, to: number): void;
  depositAll(): void;
  /** Is the player close enough to the hub to use it? */
  nearHub(): boolean;
  resume(): void;
  menu(): void;
  garage(): void;
  settings(): void;
  closePanel(): void;
}

type PanelKind = 'build' | 'machine' | 'drill' | 'hub' | 'inventory';

interface Drag {
  from: number;
  x: number;
  y: number;
  /** Created once the pointer has moved enough (a plain click stays a click). */
  ghost: HTMLElement | null;
  over: HTMLElement | null;
}

/** DOM overlay of the factory mode. */
export class FactoryHud {
  readonly layer = createLayer('factory-hud');
  private storage = el('div', { class: 'panel top-right storage-panel' });
  private hotbar = el('div', { class: 'hotbar' });
  private bagBar = el('div', { class: 'bag-bar' });
  private hint = el('div', { class: 'hint' });
  /** Bottom of the screen: hint, build bar, then the backpack's first row. */
  private bottom = el('div', { class: 'bottom-stack' }, this.hint, this.hotbar, this.bagBar);
  private crosshair = el('div', { class: 'crosshair' });
  private overlay = el('div', { class: 'overlay center' });
  private panel: HTMLElement | null = null;
  private panelKind: PanelKind | null = null;
  private panelTarget: number | null = null;
  private panelKey = '';
  private progressEl: HTMLElement | null = null;
  private storageKey = '';
  private bagKey = '';
  private bagPrev: (Stack | null)[] = [];
  private drag: Drag | null = null;
  private dragJustEnded = false;
  objectives = el('div', { class: 'panel top-left objectives' });

  constructor(
    private readonly sim: FactorySim,
    private readonly inventory: Inventory,
    private readonly wallet: Wallet,
    private readonly icons: ItemIcons | null,
    private readonly cb: HudCallbacks,
  ) {
    this.layer.append(this.storage, this.bottom, this.crosshair, this.overlay, this.objectives);
    this.objectives.style.display = 'none';
    this.buildHotbar({ kind: 'none' });
  }

  get panelOpen(): boolean {
    return this.panel !== null;
  }

  get openPanelKind(): PanelKind | null {
    return this.panelKind;
  }

  // ------------------------------------------------------------------ small widgets

  private icon(item: ItemId, cls = 'item-icon'): HTMLElement {
    const url = this.icons?.url(item);
    return url ? el('img', { class: cls, src: url, alt: ITEMS[item].name, draggable: 'false' }) : el('span', { class: `${cls} item-icon-text` }, ITEMS[item].name.slice(0, 2));
  }

  private slotEl(stack: Stack | null, onclick?: () => void, title?: string): HTMLElement {
    if (!stack) return el('div', { class: 'inv-slot empty' });
    return el(
      onclick ? 'button' : 'div',
      { class: 'inv-slot', title: title ?? `${ITEMS[stack.item].name} ×${stack.count}`, onclick },
      this.icon(stack.item),
      el('span', { class: 'inv-count mono' }, stack.count),
    );
  }

  // ------------------------------------------------------------------ hotbar / hints / storage

  buildHotbar(tool: Tool): void {
    clear(this.hotbar);
    BUILD_MENU.forEach((type, i) => {
      const def = BUILDINGS[type];
      const active = tool.kind === 'build' && tool.type === type;
      const affordable = this.wallet.missingFor(def.cost) === null;
      this.hotbar.appendChild(
        el(
          'button',
          {
            class: `slot${active ? ' active' : ''}${affordable ? '' : ' poor'}`,
            onclick: () => this.cb.selectTool(active ? { kind: 'none' } : { kind: 'build', type }),
            title: def.description,
          },
          el('span', { class: 'slot-top' }, el('kbd', {}, String(i + 1)), el('span', { class: 'slot-name' }, def.name)),
          el('span', { class: 'slot-cost' }, costText(def.cost)),
        ),
      );
    });
    const dis = tool.kind === 'dismantle';
    this.hotbar.appendChild(
      el('button', { class: `slot${dis ? ' active danger-slot' : ''}`, onclick: () => this.cb.selectTool(dis ? { kind: 'none' } : { kind: 'dismantle' }) },
        el('span', { class: 'slot-top' }, el('kbd', {}, 'F'), el('span', { class: 'slot-name' }, 'Démonter')), el('span', { class: 'slot-cost' }, 'remboursé')),
    );
  }

  setHint(html: string): void {
    if (this.hint.innerHTML !== html) this.hint.innerHTML = html;
  }

  setCrosshair(visible: boolean): void {
    this.crosshair.style.display = visible ? 'block' : 'none';
  }

  /** Hub panel (top right) and backpack bar (bottom); only re-rendered when their content changed. */
  updateStorage(): void {
    this.updateBagBar();
    const entries = ITEM_IDS.filter((id) => this.sim.count(id) > 0).map((id) => [id, this.sim.count(id)] as const);
    const key = entries.map((e) => e.join(':')).join('|');
    if (key === this.storageKey) return;
    this.storageKey = key;
    clear(this.storage);
    this.storage.appendChild(el('h3', {}, 'Hangar central'));
    if (!entries.length) this.storage.appendChild(el('div', { class: 'muted' }, 'Vide'));
    for (const [id, n] of entries) {
      this.storage.appendChild(el('div', { class: 'row storage-row' }, this.icon(id, 'item-icon tiny'), el('span', {}, ITEMS[id].name), el('span', { class: 'spacer' }), el('b', { class: 'mono' }, n)));
    }
  }

  /** First row of the backpack, always visible; a slot that gained items pulses. */
  private updateBagBar(): void {
    const row = this.inventory.slots.slice(0, INVENTORY.ROW);
    const key = `${row.map((s) => (s ? `${s.item}:${s.count}` : '-')).join('|')}#${this.inventory.usedSlots}`;
    if (key === this.bagKey) return;
    const first = this.bagKey === '';
    this.bagKey = key;
    clear(this.bagBar);
    row.forEach((s, i) => {
      const prev = this.bagPrev[i];
      const slot = this.slotEl(s);
      if (!first && s && (prev?.item !== s.item || prev.count < s.count)) {
        slot.classList.add('bump');
        // Played once: hiding then showing the bar (display: none) would replay it.
        slot.addEventListener('animationend', () => slot.classList.remove('bump'), { once: true });
      }
      this.bagBar.appendChild(slot);
    });
    this.bagPrev = row.map((s) => (s ? { ...s } : null));
    this.bagBar.appendChild(
      el('div', { class: 'bag-bar-label' }, el('b', {}, `Sac ${this.inventory.usedSlots}/${this.inventory.slots.length}`), el('span', {}, el('kbd', {}, 'Tab'))),
    );
  }

  /** Pause / click-to-play overlay. */
  showOverlay(visible: boolean, paused: boolean): void {
    if (!visible) {
      this.overlay.style.display = 'none';
      return;
    }
    this.overlay.style.display = 'block';
    clear(this.overlay);
    this.overlay.appendChild(
      el('div', { class: 'panel overlay-card' },
        el('h2', {}, paused ? 'Pause' : 'Usine'),
        el('p', { class: 'muted' }, 'Clique pour prendre le contrôle de la caméra.'),
        el('div', { class: 'controls-help' },
          el('div', {}, el('kbd', {}, 'Z Q S D'), ' / ', el('kbd', {}, 'W A S D'), ' se déplacer · ', el('kbd', {}, 'Maj'), ' courir · ', el('kbd', {}, 'Espace'), ' sauter'),
          el('div', {}, el('kbd', {}, '1-4'), ' construire · ', el('kbd', {}, 'R'), ' tourner · ', el('kbd', {}, 'F'), ' démonter · ', el('kbd', {}, 'Q'), ' menu de construction'),
          el('div', {}, el('kbd', {}, 'E'), ' utiliser une machine / le hangar · ', el('kbd', {}, 'Tab'), ' sac · ', el('kbd', {}, 'G'), ' garage · ', el('kbd', {}, 'Échap'), ' pause'),
        ),
        el('div', { class: 'row', style: 'margin-top:12px' },
          el('button', { class: 'primary', onclick: () => this.cb.resume() }, paused ? 'Reprendre' : 'Jouer'),
          el('button', { onclick: () => this.cb.garage() }, 'Garage'),
          el('button', { onclick: () => this.cb.settings() }, 'Réglages'),
          el('button', { onclick: () => this.cb.menu() }, 'Menu principal'),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ panels

  closePanel(): void {
    this.cancelDrag();
    this.layer.classList.remove('panel-open', 'bag-panel-open');
    this.panel?.remove();
    this.panel = null;
    this.progressEl = null;
    this.panelKind = null;
    this.panelTarget = null;
    this.panelKey = '';
  }

  private openPanel(kind: PanelKind, target: number | null, cls = ''): void {
    this.closePanel();
    this.panelKind = kind;
    this.panelTarget = target;
    this.layer.classList.add('panel-open');
    if (kind === 'hub' || kind === 'inventory') this.layer.classList.add('bag-panel-open');
    this.panel = el('div', { class: `panel center modal ${cls}` });
    this.layer.appendChild(this.panel);
    this.refreshPanel(true);
  }

  private header(title: string, sub?: string): HTMLElement[] {
    return [
      el('div', { class: 'row' }, el('h2', {}, title), el('span', { class: 'spacer' }), el('button', { class: 'small', onclick: () => this.cb.closePanel() }, 'Fermer')),
      sub ? el('div', { class: 'muted small' }, sub) : el('span', {}),
    ];
  }

  openBuildMenu(): void {
    this.openPanel('build', null);
  }

  openMachine(id: number): void {
    const b = this.sim.buildings.get(id);
    if (b?.type === 'drill') this.openPanel('drill', id, 'machine-panel');
    else if (b && (b.type === 'press' || b.type === 'assembler')) this.openPanel('machine', id, 'machine-panel');
  }

  openHub(): void {
    this.openPanel('hub', null, 'hub-panel');
  }

  openInventory(): void {
    this.openPanel('inventory', null, 'inventory-panel');
  }

  /** Re-renders the open panel when its content changed (keeps buttons clickable between updates). */
  private refreshPanel(force = false): void {
    if (!this.panel || !this.panelKind || (!force && this.drag?.ghost)) return;
    const key = this.contentKey();
    if (!force && key === this.panelKey) return;
    this.panelKey = key;
    clear(this.panel);
    switch (this.panelKind) {
      case 'build':
        return this.renderBuild();
      case 'machine':
        return this.renderMachine();
      case 'drill':
        return this.renderDrill();
      case 'hub':
        return this.renderHub();
      case 'inventory':
        return this.renderInventory();
    }
  }

  private contentKey(): string {
    const bag = this.inventory.slots.map((s) => (s ? `${s.item}${s.count}` : '-')).join(',');
    const hub = ITEM_IDS.map((i) => this.sim.count(i)).join(',');
    const b = this.panelTarget !== null ? this.sim.buildings.get(this.panelTarget) : undefined;
    // Progress is animated in place (see tick) so it does not trigger re-renders.
    const bkey = b ? JSON.stringify({ ...b, items: undefined, progress: undefined }) : '';
    return `${this.panelKind}|${bag}|${hub}|${bkey}|${this.cb.nearHub()}`;
  }

  private renderBuild(): void {
    const grid = el('div', { class: 'build-grid' });
    BUILD_MENU.forEach((type: BuildingType, i) => {
      const def = BUILDINGS[type];
      const missing = this.wallet.missingFor(def.cost);
      grid.appendChild(
        el('button', { class: 'build-card', onclick: () => { this.cb.selectTool({ kind: 'build', type }); this.cb.closePanel(); } },
          el('div', { class: 'row' }, el('kbd', {}, String(i + 1)), el('b', {}, def.name)),
          el('div', { class: 'muted small' }, def.description),
          el('div', { class: missing ? 'bad small' : 'good small' }, `Coût : ${costText(def.cost)}`),
        ),
      );
    });
    this.panel!.append(...this.header('Construire', 'Les coûts sont payés avec ton sac, puis avec le hangar.'), grid);
  }

  private renderMachine(): void {
    const m = this.sim.buildings.get(this.panelTarget!) as MachineB | undefined;
    if (!m) return this.cb.closePanel();
    const def = BUILDINGS[m.type];
    const recipe: Recipe | undefined = m.recipe ? RECIPES_BY_ID[m.recipe] : undefined;
    this.progressEl = el('div', { style: `width:${Math.round(this.sim.progressOf(m) * 100)}%` });
    this.panel!.append(
      ...this.header(def.name),
      el('div', { class: `status status-${m.status}` }, STATUS_LABEL[m.status]),
      el('div', { class: 'progress' }, this.progressEl),
    );
    if (recipe) {
      const ins = el('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' }, el('span', { class: 'muted small' }, 'Entrées'));
      for (const s of recipe.inputs) ins.appendChild(this.slotEl({ item: s.item, count: m.inBuf[s.item] ?? 0 }, undefined, `${ITEMS[s.item].name} : ${m.inBuf[s.item] ?? 0} (recette : ${s.count})`));
      const outs = el('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' }, el('span', { class: 'muted small' }, `Sortie ${m.outBuf.length}/${MACHINE.OUT_CAP}`));
      if (m.outBuf.length) outs.appendChild(this.slotEl({ item: m.outBuf[0]!, count: m.outBuf.length }));
      const canLoad = recipe.inputs.some((s) => this.wallet.count(s.item) > 0 && (m.inBuf[s.item] ?? 0) < s.count * MACHINE.MANUAL_CAP_FACTOR);
      this.panel!.append(
        el('div', { class: 'row machine-io' }, ins, outs),
        el('div', { class: 'row', style: 'margin-top:6px;flex-wrap:wrap' },
          el('button', { class: 'small primary', disabled: m.outBuf.length === 0, title: 'Met la production dans ton sac', onclick: () => this.cb.collect(m.id) }, `Prendre la production (${m.outBuf.length})`),
          el('button', { class: 'small', disabled: !canLoad, title: 'Charge les entrées de la recette depuis ton sac, puis le hangar', onclick: () => this.cb.loadMachine(m.id) }, 'Charger (sac puis hangar)'),
        ),
      );
    }
    this.panel!.append(el('h3', { style: 'margin-top:12px' }, 'Recettes'));
    const list = el('div', { class: 'recipe-list' });
    for (const r of recipesFor(def.machine!)) {
      const active = r.id === m.recipe;
      list.appendChild(
        el('button', { class: `recipe${active ? ' selected' : ''}`, onclick: () => { this.cb.setRecipe(m.id, r.id); this.refreshPanel(true); } },
          el('span', { class: 'row', style: 'gap:6px' }, this.icon(r.outputs[0]!.item, 'item-icon tiny'), el('b', {}, r.name)),
          el('span', { class: 'small muted' }, `${itemLabel(r.inputs)} → ${itemLabel(r.outputs)} · ${(r.ticks / 20).toFixed(1)} s`),
        ),
      );
    }
    this.panel!.append(list);
  }

  private renderDrill(): void {
    const d = this.sim.buildings.get(this.panelTarget!) as DrillB | undefined;
    if (!d) return this.cb.closePanel();
    const res = d.resource ? RESOURCES[d.resource] : null;
    const full = d.outBuf.length >= DRILL.OUT_CAP;
    this.panel!.append(
      ...this.header(BUILDINGS.drill.name, res ? res.name : 'Aucun gisement'),
      el('div', { class: `status ${full ? 'status-blocked' : 'status-working'}` }, full ? 'Sortie pleine : relie un convoyeur ou prends la production' : 'En extraction'),
      el('div', { class: 'progress' }, (this.progressEl = el('div', { style: `width:${Math.round(this.sim.progressOf(d) * 100)}%` }))),
      el('div', { class: 'row', style: 'gap:6px' }, el('span', { class: 'muted small' }, `Sortie ${d.outBuf.length}/${DRILL.OUT_CAP}`), d.outBuf.length ? this.slotEl({ item: d.outBuf[0]!, count: d.outBuf.length }) : null),
      el('div', { class: 'row', style: 'margin-top:8px' },
        el('button', { class: 'small primary', disabled: d.outBuf.length === 0, onclick: () => this.cb.collect(d.id) }, `Prendre (${d.outBuf.length})`),
      ),
    );
  }

  /** Backpack grid, Minecraft-style: storage rows, then the bar row (the one shown at the bottom of the screen). */
  private bagGrid(onSlot?: (i: number) => void): HTMLElement {
    const n = this.inventory.slots.length;
    const row = Math.min(INVENTORY.ROW, n);
    const main = el('div', { class: 'inv-grid' });
    for (let i = row; i < n; i++) main.appendChild(this.bagSlot(i, onSlot));
    const bar = el('div', { class: 'inv-grid' });
    for (let i = 0; i < row; i++) bar.appendChild(this.bagSlot(i, onSlot));
    return el('div', { class: 'bag' }, main, el('div', { class: 'bag-sep muted small' }, 'Barre du bas'), bar);
  }

  private bagSlot(i: number, onSlot?: (i: number) => void): HTMLElement {
    const s = this.inventory.slots[i] ?? null;
    const node = this.slotEl(s, s && onSlot ? () => !this.dragJustEnded && onSlot(i) : undefined);
    node.dataset.slot = String(i);
    if (s) {
      node.classList.add('draggable');
      node.addEventListener('pointerdown', (e) => this.dragStart(e, i));
    }
    return node;
  }

  // ------------------------------------------------------------------ drag and drop (backpack)

  private dragStart(e: PointerEvent, from: number): void {
    if (e.button !== 0 || this.drag) return;
    this.drag = { from, x: e.clientX, y: e.clientY, ghost: null, over: null };
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.onDragEnd);
    window.addEventListener('pointercancel', this.onDragCancel);
    window.addEventListener('blur', this.onDragCancel);
    window.addEventListener('contextmenu', this.onDragCancel);
  }

  private onDragMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    // The release was missed (native menu, focus loss…): never let a stale drag turn the next click into a drop.
    if ((e.buttons & 1) === 0) return this.cancelDrag();
    if (!d.ghost) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      const s = this.inventory.slots[d.from];
      if (!s) return this.cancelDrag();
      d.ghost = el('div', { class: 'drag-ghost' }, this.icon(s.item), el('span', { class: 'inv-count mono' }, s.count));
      this.layer.appendChild(d.ghost);
      this.panel?.querySelector(`[data-slot="${d.from}"]`)?.classList.add('drag-source');
    }
    d.ghost.style.left = `${e.clientX}px`;
    d.ghost.style.top = `${e.clientY}px`;
    const over = this.dropTarget(e.clientX, e.clientY);
    if (over !== d.over) {
      d.over?.classList.remove('drop-target');
      over?.classList.add('drop-target');
      d.over = over;
    }
  };

  private onDragEnd = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    const target = d.ghost ? this.dropTarget(e.clientX, e.clientY) : null;
    const dragged = d.ghost !== null;
    this.cancelDrag();
    if (!dragged) return;
    // The click that follows this pointerup (same task) must not act on a slot.
    this.dragJustEnded = true;
    setTimeout(() => (this.dragJustEnded = false), 0);
    if (target?.dataset.slot !== undefined) this.cb.moveSlot(d.from, Number(target.dataset.slot));
    else if (target?.dataset.drop === 'hub') this.cb.depositSlot(d.from);
    this.updateBagBar();
    this.refreshPanel(true);
  };

  private onDragCancel = (): void => this.cancelDrag();

  /** A backpack slot, or the hub column of the hub panel. */
  private dropTarget(x: number, y: number): HTMLElement | null {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !this.panel?.contains(hit)) return null;
    return hit.closest<HTMLElement>('[data-slot], [data-drop]');
  }

  private cancelDrag(): void {
    const d = this.drag;
    if (!d) return;
    d.ghost?.remove();
    d.over?.classList.remove('drop-target');
    this.panel?.querySelector('.drag-source')?.classList.remove('drag-source');
    this.drag = null;
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.onDragEnd);
    window.removeEventListener('pointercancel', this.onDragCancel);
    window.removeEventListener('blur', this.onDragCancel);
    window.removeEventListener('contextmenu', this.onDragCancel);
  }

  private renderHub(): void {
    const list = el('div', { class: 'hub-list' });
    const items = ITEM_IDS.filter((i) => this.sim.count(i) > 0);
    if (!items.length) list.appendChild(el('div', { class: 'muted small' }, 'Le hangar est vide.'));
    for (const id of items) {
      const room = this.inventory.room(id);
      list.appendChild(
        el('button', { class: 'hub-row', disabled: room === 0, title: room ? `Prendre jusqu’à ${Math.min(room, ITEMS[id].stack, this.sim.count(id))}` : 'Sac plein', onclick: () => this.cb.takeFromHub(id) },
          this.icon(id, 'item-icon tiny'), el('span', {}, ITEMS[id].name), el('span', { class: 'spacer' }), el('b', { class: 'mono' }, this.sim.count(id))),
      );
    }
    this.panel!.append(
      ...this.header('Hangar central', 'Clique un objet du hangar pour en prendre une pile. Clique une case du sac (ou glisse-la sur le hangar) pour la déposer.'),
      el('div', { class: 'hub-columns' },
        el('div', {}, el('h3', {}, `Ton sac ${this.inventory.usedSlots}/${this.inventory.slots.length}`), this.bagGrid((i) => this.cb.depositSlot(i))),
        el('div', { class: 'hub-drop', 'data-drop': 'hub' }, el('h3', {}, 'Hangar'), list),
      ),
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { disabled: this.inventory.usedSlots === 0, onclick: () => this.cb.depositAll() }, 'Tout déposer'),
        el('span', { class: 'spacer' }),
        el('button', { class: 'primary', onclick: () => this.cb.garage() }, 'Aller au garage'),
      ),
    );
  }

  private renderInventory(): void {
    const near = this.cb.nearHub();
    this.panel!.append(
      ...this.header(`Sac ${this.inventory.usedSlots}/${this.inventory.slots.length}`, 'Glisse une case pour la ranger : la dernière rangée est la barre du bas de l’écran. Constructions et chargements piochent d’abord dans le sac, puis dans le hangar.'),
      this.bagGrid(near ? (i) => this.cb.depositSlot(i) : undefined),
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { disabled: !near || this.inventory.usedSlots === 0, onclick: () => this.cb.depositAll() }, 'Tout déposer au hangar'),
        el('span', { class: 'muted small' }, near ? 'Clique une case pour la déposer.' : 'Approche-toi du hangar pour déposer.'),
      ),
    );
  }

  /** Onboarding checklist (top-left): remaining objectives, the next one with its hint. */
  renderObjectives(items: { text: string; hint: string; done: boolean }[]): void {
    const key = items.map((i) => (i.done ? 1 : 0)).join('');
    if (this.objectives.dataset.key === key) return;
    this.objectives.dataset.key = key;
    clear(this.objectives);
    const doneCount = items.filter((i) => i.done).length;
    if (doneCount === items.length) {
      this.objectives.style.display = 'none';
      return;
    }
    this.objectives.style.display = 'block';
    this.objectives.appendChild(el('h3', {}, `Objectifs ${doneCount}/${items.length}`));
    const next = items.find((i) => !i.done)!;
    this.objectives.appendChild(el('div', { class: 'objective next' }, `○ ${next.text}`));
    this.objectives.appendChild(el('div', { class: 'muted small objective-hint' }, next.hint));
    const later = items.filter((i) => !i.done && i !== next).length;
    if (later) this.objectives.appendChild(el('div', { class: 'muted small' }, `+ ${later} étape${later > 1 ? 's' : ''} ensuite`));
  }

  /** Live refresh of the open panel (only re-rendered when its content changed). */
  tick(): void {
    this.refreshPanel();
    const b = this.panelTarget !== null ? this.sim.buildings.get(this.panelTarget) : undefined;
    if (b && this.progressEl) this.progressEl.style.width = `${Math.round(this.sim.progressOf(b) * 100)}%`;
  }

  dispose(): void {
    this.cancelDrag();
    this.layer.remove();
  }
}
