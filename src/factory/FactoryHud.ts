import { BUILDINGS, BUILD_MENU, type BuildingType } from '../data/buildings';
import { ITEMS, ITEM_IDS, countLabel, type Inventory as ItemCounts, type ItemId } from '../data/items';
import { recipesFor, RECIPES_BY_ID, type Recipe } from '../data/recipes';
import { DRILL, MACHINE } from '../data/balance';
import { RESOURCES } from '../data/factoryMap';
import { append, clear, createLayer, el } from '../ui/dom';
import type { FactorySim } from './sim/FactorySim';
import { isMachine, type DrillB, type MachineB } from './sim/types';
import type { Tool } from './build/BuildController';
import type { Inventory, Stack, Wallet } from '../state/Inventory';
import type { ItemIcons } from '../core/assets/IconRenderer';
import { INVENTORY } from '../data/inventory';
import { TIERS, tierOf } from '../data/tiers';
import { FACTORY_CELL } from '../config/constants';

/** Build menu sections, in BUILD_MENU order (the 1-6 shortcuts follow BUILD_MENU). */
const BUILD_CATEGORIES: { name: string; types: BuildingType[] }[] = [
  { name: 'Logistique', types: ['conveyor'] },
  { name: 'Extraction', types: ['drill'] },
  { name: 'Production', types: ['smelter', 'press', 'assembler'] },
  { name: 'Véhicules', types: ['garage'] },
];

/** What a building is for, in the build menu's detail pane (machines also list their recipes). */
const BUILD_ROLE: Partial<Record<BuildingType, string>> = {
  conveyor: 'Transporte les objets à 2 m/s. Clic gauche maintenu : tracer une ligne.',
  drill: 'À poser sur un gisement : minerai de fer ou latex selon la roche.',
  garage: 'Une place pour une voiture : assemblage, pièces, départ des courses. Porte à l’avant.',
};

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
  /** Hub tiers: number unlocked, and whether a building is available. */
  tier(): number;
  isUnlocked(type: BuildingType): boolean;
  /** Pays and unlocks tier `n` (1-based); ignored unless it is the next one (stale button, double click). */
  unlockTier(n: number): void;
  /** Crafts a bench recipe once by hand; false if an input is missing. */
  craft(recipeId: string): boolean;
  /** The player holds a craft button (bench animation). */
  setCrafting(active: boolean): void;
  resume(): void;
  menu(): void;
  settings(): void;
  closePanel(): void;
}

type PanelKind = 'build' | 'machine' | 'drill' | 'hub' | 'inventory';
type HubTab = 'stock' | 'bench' | 'tiers';

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
  private bagBar = el('div', { class: 'bag-bar' });
  private hint = el('div', { class: 'hint' });
  /** Bottom of the screen: hint, then the backpack's first row (buildings are picked in the build menu). */
  private bottom = el('div', { class: 'bottom-stack' }, this.hint, this.bagBar);
  /** Active build tool (highlighted in the build menu). */
  private tool: Tool = { kind: 'none' };
  /** Building shown in the build menu's detail pane (hovered card). */
  private buildFocus: BuildingType | null = null;
  private crosshair = el('div', { class: 'crosshair' });
  private overlay = el('div', { class: 'overlay center' });
  private panel: HTMLElement | null = null;
  private panelKind: PanelKind | null = null;
  private panelTarget: number | null = null;
  private panelKey = '';
  private progressEl: HTMLElement | null = null;
  /** null until the first render (an empty hub has the key ''). */
  private storageKey: string | null = null;
  private bagKey = '';
  private bagPrev: (Stack | null)[] = [];
  private drag: Drag | null = null;
  private dragJustEnded = false;
  /** Last tab used in the hub panel (the bench first in a new game). */
  private hubTab: HubTab | null = null;
  /** Hold-to-craft at the bench: recipe being crafted and time held (s). */
  private crafting: { recipe: Recipe; t: number } | null = null;
  objectives = el('div', { class: 'panel top-left objectives' });

  constructor(
    private readonly sim: FactorySim,
    private readonly inventory: Inventory,
    private readonly wallet: Wallet,
    private readonly icons: ItemIcons | null,
    /** Building thumbnails for the build menu (null entries: text fallback). */
    private readonly buildingIcon: (type: BuildingType) => string | null,
    private readonly cb: HudCallbacks,
  ) {
    this.layer.append(this.storage, this.bottom, this.crosshair, this.overlay, this.objectives);
    this.objectives.style.display = 'none';
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

  // ------------------------------------------------------------------ tool / hints / storage

  /** The active tool changed (the build menu marks it). */
  onToolChanged(tool: Tool): void {
    this.tool = tool;
    if (this.panelKind === 'build') this.refreshPanel(true);
  }

  /** Compact cost: icon + quantity per item (red when short), full text in the tooltip. */
  private costIcons(cost: ItemCounts): HTMLElement {
    const row = el('span', { class: 'cost-icons', title: costText(cost) });
    for (const [item, n] of Object.entries(cost) as [ItemId, number][]) {
      const short = this.wallet.count(item) < n;
      row.append(el('span', { class: `cost-item${short ? ' bad' : ''}` }, this.icon(item, 'item-icon micro'), `${n}`));
    }
    return row;
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
          el('div', {}, el('kbd', {}, 'Z Q S D'), ' se déplacer · ', el('kbd', {}, 'Maj'), ' courir · ', el('kbd', {}, 'Espace'), ' sauter'),
          el('div', {}, el('kbd', {}, 'A'), ' menu de construction (raccourcis ', el('kbd', {}, '1-6'), ') · ', el('kbd', {}, 'R'), ' tourner · ', el('kbd', {}, 'F'), ' démonter'),
          el('div', {}, el('kbd', {}, 'E'), ' maintenu sur un gisement : miner · ', el('kbd', {}, 'E'), ' utiliser une machine / le hangar (établi, paliers)'),
          el('div', {}, el('kbd', {}, 'E'), ' près d’une voiture : monter / descendre · ', el('kbd', {}, 'Tab'), ' sac · ', el('kbd', {}, 'Échap'), ' pause'),
        ),
        el('div', { class: 'row', style: 'margin-top:12px' },
          el('button', { class: 'primary', onclick: () => this.cb.resume() }, paused ? 'Reprendre' : 'Jouer'),
          el('button', { onclick: () => this.cb.settings() }, 'Réglages'),
          el('button', { onclick: () => this.cb.menu() }, 'Menu principal'),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ panels

  closePanel(): void {
    this.cancelDrag();
    this.stopCraft();
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
    this.buildFocus = null;
    this.openPanel('build', null, 'build-panel');
  }

  openMachine(id: number): void {
    const b = this.sim.buildings.get(id);
    if (b?.type === 'drill') this.openPanel('drill', id, 'machine-panel');
    else if (isMachine(b)) this.openPanel('machine', id, 'machine-panel');
  }

  openHub(): void {
    this.hubTab ??= this.cb.tier() === 0 ? 'bench' : 'stock';
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
    if (this.panelKind === 'build') {
      // Only the counts of items used by building costs (the hub changes all the time with production).
      const used = [...new Set(BUILD_MENU.flatMap((t) => Object.keys(BUILDINGS[t].cost) as ItemId[]))];
      return `build|${used.map((i) => this.wallet.count(i)).join(',')}|${this.cb.tier()}|${JSON.stringify(this.tool)}`;
    }
    const bag = this.inventory.slots.map((s) => (s ? `${s.item}${s.count}` : '-')).join(',');
    const hub = ITEM_IDS.map((i) => this.sim.count(i)).join(',');
    const b = this.panelTarget !== null ? this.sim.buildings.get(this.panelTarget) : undefined;
    // Progress is animated in place (see tick) so it does not trigger re-renders.
    const bkey = b ? JSON.stringify({ ...b, items: undefined, progress: undefined }) : '';
    return `${this.panelKind}|${bag}|${hub}|${bkey}|${this.cb.nearHub()}|${this.hubTab}|${this.cb.tier()}`;
  }

  /** Build menu (A): buildings by category with thumbnails and costs, details of the hovered one. */
  private renderBuild(): void {
    const firstFree = BUILD_MENU.find((t) => this.cb.isUnlocked(t)) ?? BUILD_MENU[0]!;
    this.buildFocus ??= this.tool.kind === 'build' ? this.tool.type : firstFree;
    const detail = el('div', { class: 'build-detail' });
    const list = el('div', { class: 'build-list' });
    for (const cat of BUILD_CATEGORIES) {
      const cards = el('div', { class: 'build-cards' });
      for (const type of cat.types) cards.appendChild(this.buildCard(type, detail));
      list.appendChild(el('div', { class: 'build-cat' }, el('h3', {}, cat.name), cards));
    }
    this.renderBuildDetail(detail, this.buildFocus);
    const dis = this.tool.kind === 'dismantle';
    this.panel!.append(
      ...this.header('Construire', 'Clique un bâtiment pour le placer. Les coûts sont payés avec ton sac, puis avec le hangar.'),
      el('div', { class: 'build-menu' }, list, detail),
      el('div', { class: 'row build-footer' },
        el('button', { class: `small${dis ? ' danger' : ''}`, onclick: () => { this.cb.selectTool(dis ? { kind: 'none' } : { kind: 'dismantle' }); this.cb.closePanel(); } }, el('kbd', {}, 'F'), dis ? ' Arrêter de démonter' : ' Démonter (remboursé)'),
        el('span', { class: 'spacer' }),
        el('span', { class: 'muted small' }, 'Raccourcis : ', el('kbd', {}, '1'), ' à ', el('kbd', {}, String(BUILD_MENU.length)), ' · ', el('kbd', {}, 'R'), ' tourner'),
      ),
    );
  }

  private buildingThumb(type: BuildingType, cls: string): HTMLElement {
    const url = this.buildingIcon(type);
    return url ? el('img', { class: cls, src: url, alt: BUILDINGS[type].name, draggable: 'false' }) : el('div', { class: `${cls} thumb-text` }, BUILDINGS[type].name.slice(0, 3));
  }

  private buildCard(type: BuildingType, detail: HTMLElement): HTMLElement {
    const def = BUILDINGS[type];
    const locked = !this.cb.isUnlocked(type);
    const active = this.tool.kind === 'build' && this.tool.type === type;
    const poor = !locked && this.wallet.missingFor(def.cost) !== null;
    const card = el('button',
      {
        class: `build-card${locked ? ' locked' : ''}${active ? ' active' : ''}${poor ? ' poor' : ''}${this.buildFocus === type ? ' focus' : ''}`,
        onclick: () => {
          if (locked) return;
          this.cb.selectTool({ kind: 'build', type });
          this.cb.closePanel();
        },
      },
      el('kbd', { class: 'build-key' }, String(BUILD_MENU.indexOf(type) + 1)),
      this.buildingThumb(type, 'build-thumb'),
      el('b', { class: 'build-name' }, def.name),
      locked ? el('span', { class: 'build-lock small' }, `🔒 Palier ${tierOf(type)}`) : this.costIcons(def.cost),
    );
    card.addEventListener('pointerenter', () => {
      if (this.buildFocus === type) return;
      this.buildFocus = type;
      this.panel?.querySelectorAll('.build-card.focus').forEach((c) => c.classList.remove('focus'));
      card.classList.add('focus');
      this.renderBuildDetail(detail, type);
    });
    return card;
  }

  private renderBuildDetail(detail: HTMLElement, type: BuildingType): void {
    clear(detail);
    const def = BUILDINGS[type];
    const locked = !this.cb.isUnlocked(type);
    const missing = this.wallet.missingFor(def.cost);
    const [w, h] = def.footprint;
    const makes = def.machine ? recipesFor(def.machine).map((r) => r.name).join(', ') : null;
    const cost = el('div', { class: 'build-cost' });
    for (const [item, n] of Object.entries(def.cost) as [ItemId, number][]) {
      const have = this.wallet.count(item);
      cost.appendChild(
        el('div', { class: `row build-cost-row${have >= n ? '' : ' bad'}` },
          this.icon(item, 'item-icon tiny'), el('span', {}, ITEMS[item].name), el('span', { class: 'spacer' }),
          el('b', { class: 'mono' }, `${Math.min(have, n)}/${n}`)),
      );
    }
    append(detail,
      this.buildingThumb(type, 'build-detail-thumb'),
      el('h2', {}, def.name),
      el('div', { class: 'muted small' }, `${w} × ${h} cases (${w * FACTORY_CELL} × ${h * FACTORY_CELL} m) · touche ${BUILD_MENU.indexOf(type) + 1}`),
      el('p', { class: 'small' }, BUILD_ROLE[type] ?? def.description),
      makes ? el('div', { class: 'small' }, el('span', { class: 'muted' }, 'Fabrique : '), makes) : null,
      el('h3', { style: 'margin-top:10px' }, 'Coût'),
      cost,
      locked
        ? el('div', { class: 'muted small', style: 'margin-top:8px' }, `🔒 Se débloque au palier ${tierOf(type)} (${TIERS[tierOf(type) - 1]?.name ?? ''}) : E sur le hangar → Paliers.`)
        : el('button', { class: 'primary', style: 'margin-top:10px', onclick: () => { this.cb.selectTool({ kind: 'build', type }); this.cb.closePanel(); } }, missing ? 'Placer (il manque des pièces)' : 'Placer'),
    );
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
      this.portStatus(m.id),
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

  /** Whether something feeds the building and whether its output goes anywhere, with what to do if not. */
  private portStatus(id: number): HTMLElement {
    const ports = this.sim.portsOf(id);
    const line = (dir: 'in' | 'out') => {
      const own = ports.filter((p) => p.dir === dir);
      if (!own.length) return null;
      let cls = 'muted';
      let text: string;
      if (own.some((p) => p.state === 'linked')) {
        cls = 'good';
        text = dir === 'in' ? 'Entrée reliée' : 'Sortie reliée';
      } else if (own.some((p) => p.state === 'free')) {
        text = dir === 'in' ? 'Entrée non reliée : amène un convoyeur sur une flèche bleue' : 'Sortie non reliée : pose un convoyeur sur une flèche orange, devant la machine';
      } else {
        // Every port of that side faces something that does not connect (or the map edge).
        const n = own.map((p) => (p.neighbor !== null ? this.sim.buildings.get(p.neighbor) : undefined)).find((b) => b);
        if (dir === 'out') {
          cls = 'bad';
          text = n?.type === 'conveyor'
            ? 'Sortie bloquée : le convoyeur devant pointe vers la machine, repose-le dans l’autre sens'
            : n
              ? `Sortie bloquée (${BUILDINGS[n.type].name}) : libère une case devant la machine`
              : 'Sortie bloquée : elle donne sur le bord de la carte, tourne ou déplace la machine';
        } else {
          text = n?.type === 'conveyor'
            ? 'Entrée non reliée : le convoyeur derrière ne pointe pas vers la machine'
            : n
              ? `Entrée bloquée (${BUILDINGS[n.type].name}) : libère une case derrière la machine`
              : 'Entrée bloquée : elle donne sur le bord de la carte, tourne ou déplace la machine';
        }
      }
      return el('div', { class: 'row small' }, el('span', { class: `port-dot port-${dir}` }), el('span', { class: cls }, text));
    };
    return el('div', { class: 'port-status' }, line('in'), line('out'));
  }

  private renderDrill(): void {
    const d = this.sim.buildings.get(this.panelTarget!) as DrillB | undefined;
    if (!d) return this.cb.closePanel();
    const res = d.resource ? RESOURCES[d.resource] : null;
    const full = d.outBuf.length >= DRILL.OUT_CAP;
    const linked = !!this.sim.linkOf(d.id);
    const stuck = this.sim.portsOf(d.id).every((p) => p.state === 'blocked');
    const fullText = linked
      ? 'Sortie pleine : la chaîne en aval est saturée'
      : stuck
        ? 'Sortie pleine : sortie bloquée, prends la production'
        : 'Sortie pleine : relie un convoyeur ou prends la production';
    this.panel!.append(
      ...this.header(BUILDINGS.drill.name, res ? res.name : 'Aucun gisement'),
      el('div', { class: `status ${full ? 'status-blocked' : 'status-working'}` }, full ? fullText : 'En extraction'),
      el('div', { class: 'progress' }, (this.progressEl = el('div', { style: `width:${Math.round(this.sim.progressOf(d) * 100)}%` }))),
      this.portStatus(d.id),
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
    const tab = this.hubTab ?? 'stock';
    const next = TIERS[this.cb.tier()];
    const tierReady = !!next && this.wallet.missingFor(next.cost) === null;
    const tabBtn = (id: HubTab, label: string, badge = false) =>
      el('button', { class: `tab${tab === id ? ' selected' : ''}`, onclick: () => { this.stopCraft(); this.hubTab = id; this.refreshPanel(true); } }, label, badge ? el('span', { class: 'tab-badge' }, '!') : null);
    const subs: Record<HubTab, string> = {
      stock: 'Clique un objet du hangar pour en prendre une pile. Clique une case du sac (ou glisse-la sur le hangar) pour la déposer.',
      bench: 'Fabrication à la main : maintiens le bouton. Le sac paie d’abord, puis le hangar ; le résultat va dans le sac.',
      tiers: 'Livre des pièces pour débloquer de nouveaux bâtiments. Le sac paie d’abord, puis le hangar.',
    };
    this.panel!.append(
      ...this.header('Hangar central', subs[tab]),
      el('div', { class: 'row tabs' }, tabBtn('stock', 'Hangar'), tabBtn('bench', 'Établi'), tabBtn('tiers', 'Paliers', tierReady)),
      el('div', { class: 'hub-columns' },
        el('div', {}, el('h3', {}, `Ton sac ${this.inventory.usedSlots}/${this.inventory.slots.length}`), this.bagGrid((i) => this.cb.depositSlot(i))),
        tab === 'stock' ? this.hubStock() : tab === 'bench' ? this.hubBench() : this.hubTiers(),
      ),
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { disabled: this.inventory.usedSlots === 0, onclick: () => this.cb.depositAll() }, 'Tout déposer'),
      ),
    );
  }

  private hubStock(): HTMLElement {
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
    return el('div', { class: 'hub-drop', 'data-drop': 'hub' }, el('h3', {}, 'Hangar'), list);
  }

  /** Inputs → outputs with what the wallet holds (« 2/3 »), red when short. */
  private recipeLine(r: Recipe): HTMLElement {
    const line = el('span', { class: 'recipe-io small' });
    r.inputs.forEach((s, i) => {
      const have = this.wallet.count(s.item);
      line.append(i ? ' + ' : '', this.icon(s.item, 'item-icon tiny'), el('span', { class: have >= s.count ? 'mono' : 'mono bad' }, `${s.count}`), el('span', { class: 'muted' }, ` (${have})`));
    });
    line.append(' → ');
    r.outputs.forEach((s, i) => line.append(i ? ' + ' : '', this.icon(s.item, 'item-icon tiny'), el('span', { class: 'mono' }, `${s.count}`)));
    return line;
  }

  private hubBench(): HTMLElement {
    const list = el('div', { class: 'bench-list' });
    for (const r of recipesFor('bench')) {
      const can = this.canCraft(r);
      const active = this.crafting?.recipe.id === r.id;
      const btn = el('button', { class: `craft-btn${active ? ' active' : ''}`, disabled: !can, 'data-craft': r.id, title: `${(r.ticks / 20).toFixed(2).replace(/\.?0+$/, '')} s par fabrication` },
        el('span', { class: 'craft-fill', style: `width:${active ? Math.round((this.crafting!.t / (r.ticks / 20)) * 100) : 0}%` }),
        el('span', { class: 'craft-label' }, can ? 'Maintenir' : 'Manque'),
      );
      btn.addEventListener('pointerdown', (e) => this.startCraft(e, r));
      list.appendChild(
        el('div', { class: 'bench-row' },
          el('div', { class: 'col', style: 'gap:2px' }, el('b', {}, r.name), this.recipeLine(r)),
          el('span', { class: 'spacer' }),
          btn,
        ),
      );
    }
    return el('div', {}, el('h3', {}, 'Établi'), list);
  }

  private hubTiers(): HTMLElement {
    const tier = this.cb.tier();
    const list = el('div', { class: 'tier-list' });
    TIERS.forEach((t, i) => {
      const n = i + 1;
      const done = n <= tier;
      const isNext = n === tier + 1;
      const names = t.unlocks.map((b) => BUILDINGS[b].name).join(', ');
      const cost = el('div', { class: 'tier-cost small' });
      for (const [item, need] of Object.entries(t.cost) as [ItemId, number][]) {
        const have = this.wallet.count(item);
        cost.append(el('span', { class: `tier-item${done ? '' : have >= need ? ' good' : ' bad'}` }, this.icon(item, 'item-icon tiny'), el('span', { class: 'mono' }, done ? `${need}` : `${Math.min(have, need)}/${need}`)));
      }
      const affordable = isNext && this.wallet.missingFor(t.cost) === null;
      list.appendChild(
        el('div', { class: `tier${done ? ' done' : isNext ? ' next' : ' later'}` },
          el('div', { class: 'row' }, el('b', {}, `${done ? '✓' : n}. ${t.name}`), el('span', { class: 'spacer' }), el('span', { class: 'muted small' }, names)),
          el('div', { class: 'muted small' }, t.description),
          cost,
          isNext ? el('button', { class: 'small primary', disabled: !affordable, onclick: () => { this.cb.unlockTier(n); this.refreshPanel(true); } }, affordable ? 'Débloquer' : 'Il manque des pièces') : null,
        ),
      );
    });
    if (tier >= TIERS.length) list.appendChild(el('div', { class: 'good small' }, 'Tous les paliers sont débloqués.'));
    return el('div', {}, el('h3', {}, `Paliers ${Math.min(tier, TIERS.length)}/${TIERS.length}`), list);
  }

  // ------------------------------------------------------------------ hold-to-craft (bench)

  private canCraft(r: Recipe): boolean {
    return this.wallet.missingFor(Object.fromEntries(r.inputs.map((s) => [s.item, s.count]))) === null;
  }

  private startCraft(e: PointerEvent, r: Recipe): void {
    if (e.button !== 0 || !this.canCraft(r)) return;
    this.stopCraft();
    this.crafting = { recipe: r, t: 0 };
    this.cb.setCrafting(true);
    window.addEventListener('pointerup', this.onCraftUp);
    window.addEventListener('pointercancel', this.onCraftUp);
    window.addEventListener('blur', this.onCraftUp);
  }

  private onCraftUp = (): void => this.stopCraft();

  private stopCraft(): void {
    if (!this.crafting) return;
    this.crafting = null;
    this.cb.setCrafting(false);
    window.removeEventListener('pointerup', this.onCraftUp);
    window.removeEventListener('pointercancel', this.onCraftUp);
    window.removeEventListener('blur', this.onCraftUp);
    this.panel?.querySelectorAll<HTMLElement>('.craft-btn.active').forEach((b) => {
      b.classList.remove('active');
      b.querySelector<HTMLElement>('.craft-fill')?.style.setProperty('width', '0%');
    });
  }

  /** Per-frame update (smooth hold-to-craft progress). */
  frame(dt: number): void {
    const c = this.crafting;
    if (!c) return;
    if (this.panelKind !== 'hub' || this.hubTab !== 'bench') return this.stopCraft();
    const time = c.recipe.ticks / 20;
    c.t += dt;
    if (c.t >= time) {
      c.t -= time;
      if (!this.cb.craft(c.recipe.id)) return this.stopCraft();
      this.updateBagBar();
      this.refreshPanel();
      // Out of inputs: stop instead of filling the bar of a « Manque » button.
      if (!this.canCraft(c.recipe)) return this.stopCraft();
    }
    const fill = this.panel?.querySelector<HTMLElement>(`[data-craft="${c.recipe.id}"] .craft-fill`);
    if (fill) {
      fill.style.width = `${Math.round((c.t / time) * 100)}%`;
      fill.parentElement?.classList.add('active');
    }
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
    this.stopCraft();
    this.layer.remove();
  }
}
