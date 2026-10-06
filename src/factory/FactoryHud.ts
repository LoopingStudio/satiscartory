import { BUILDINGS, BUILD_MENU, type BuildingType } from '../data/buildings';
import { ITEMS, ITEM_IDS, countLabel, type Inventory, type ItemId } from '../data/items';
import { recipesFor, RECIPES_BY_ID, type Recipe } from '../data/recipes';
import { MACHINE } from '../data/balance';
import { clear, createLayer, el } from '../ui/dom';
import type { FactorySim } from './sim/FactorySim';
import type { MachineB } from './sim/types';
import type { Tool } from './build/BuildController';

const STATUS_LABEL = { working: 'En production', idle: 'En attente d’entrées', blocked: 'Sortie pleine', noRecipe: 'Aucune recette' } as const;

function itemLabel(stacks: { item: ItemId; count: number }[]): string {
  return stacks.map((s) => countLabel(s.item, s.count)).join(' + ');
}

export function costText(cost: Inventory): string {
  return Object.entries(cost)
    .map(([i, n]) => countLabel(i as ItemId, n ?? 0))
    .join(', ');
}

export interface HudCallbacks {
  selectTool(tool: Tool): void;
  setRecipe(machineId: number, recipe: string): void;
  /** Manual feeding from the hub storage. */
  loadMachine(machineId: number): void;
  /** Manual pickup of the machine output into the hub. */
  collect(machineId: number): void;
  resume(): void;
  menu(): void;
  garage(): void;
  closePanel(): void;
}

/** DOM overlay of the factory mode. */
export class FactoryHud {
  readonly layer = createLayer('factory-hud');
  private storage = el('div', { class: 'panel top-right storage-panel' });
  private hotbar = el('div', { class: 'hotbar bottom-center' });
  private hint = el('div', { class: 'hint' });
  private crosshair = el('div', { class: 'crosshair' });
  private overlay = el('div', { class: 'overlay center' });
  private panel: HTMLElement | null = null;
  private panelMachine: number | null = null;
  private storageKey = '';
  objectives = el('div', { class: 'panel top-left objectives' });

  constructor(private readonly sim: FactorySim, private readonly cb: HudCallbacks) {
    this.layer.append(this.storage, this.hotbar, this.hint, this.crosshair, this.overlay, this.objectives);
    this.objectives.style.display = 'none';
    this.buildHotbar({ kind: 'none' });
  }

  get panelOpen(): boolean {
    return this.panel !== null;
  }

  buildHotbar(tool: Tool): void {
    clear(this.hotbar);
    BUILD_MENU.forEach((type, i) => {
      const def = BUILDINGS[type];
      const active = tool.kind === 'build' && tool.type === type;
      const affordable = this.sim.canAfford(def.cost);
      this.hotbar.appendChild(
        el(
          'button',
          {
            class: `slot${active ? ' active' : ''}${affordable ? '' : ' poor'}`,
            onclick: () => this.cb.selectTool(active ? { kind: 'none' } : { kind: 'build', type }),
            title: def.description,
          },
          el('kbd', {}, String(i + 1)),
          el('span', { class: 'slot-name' }, def.name),
          el('span', { class: 'slot-cost' }, costText(def.cost)),
        ),
      );
    });
    const dis = tool.kind === 'dismantle';
    this.hotbar.appendChild(
      el('button', { class: `slot${dis ? ' active danger-slot' : ''}`, onclick: () => this.cb.selectTool(dis ? { kind: 'none' } : { kind: 'dismantle' }) },
        el('kbd', {}, 'F'), el('span', { class: 'slot-name' }, 'Démonter'), el('span', { class: 'slot-cost' }, 'remboursé')),
    );
  }

  setHint(html: string): void {
    if (this.hint.innerHTML !== html) this.hint.innerHTML = html;
  }

  setCrosshair(visible: boolean): void {
    this.crosshair.style.display = visible ? 'block' : 'none';
  }

  updateStorage(): void {
    const entries = ITEM_IDS.filter((id) => this.sim.count(id) > 0).map((id) => [id, this.sim.count(id)] as const);
    const key = entries.map((e) => e.join(':')).join('|');
    if (key === this.storageKey) return;
    this.storageKey = key;
    clear(this.storage);
    this.storage.appendChild(el('h3', {}, 'Hangar central'));
    if (!entries.length) this.storage.appendChild(el('div', { class: 'muted' }, 'Vide'));
    for (const [id, n] of entries) {
      this.storage.appendChild(el('div', { class: 'row storage-row' }, el('span', {}, ITEMS[id].name), el('span', { class: 'spacer' }), el('b', { class: 'mono' }, n)));
    }
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
          el('div', {}, el('kbd', {}, 'E'), ' configurer une machine / hangar · ', el('kbd', {}, 'G'), ' garage · ', el('kbd', {}, 'Échap'), ' pause'),
        ),
        el('div', { class: 'row', style: 'margin-top:12px' },
          el('button', { class: 'primary', onclick: () => this.cb.resume() }, paused ? 'Reprendre' : 'Jouer'),
          el('button', { onclick: () => this.cb.garage() }, 'Garage'),
          el('button', { onclick: () => this.cb.menu() }, 'Menu principal'),
        ),
      ),
    );
  }

  closePanel(): void {
    this.panel?.remove();
    this.panel = null;
    this.panelMachine = null;
  }

  openBuildMenu(): void {
    this.closePanel();
    const grid = el('div', { class: 'build-grid' });
    BUILD_MENU.forEach((type: BuildingType, i) => {
      const def = BUILDINGS[type];
      const missing = this.sim.missingFor(def.cost);
      grid.appendChild(
        el('button', { class: 'build-card', onclick: () => { this.cb.selectTool({ kind: 'build', type }); this.cb.closePanel(); } },
          el('div', { class: 'row' }, el('kbd', {}, String(i + 1)), el('b', {}, def.name)),
          el('div', { class: 'muted small' }, def.description),
          el('div', { class: missing ? 'bad small' : 'good small' }, `Coût : ${costText(def.cost)}`),
        ),
      );
    });
    this.panel = el('div', { class: 'panel center modal' },
      el('div', { class: 'row' }, el('h2', {}, 'Construire'), el('span', { class: 'spacer' }), el('button', { class: 'small', onclick: () => this.cb.closePanel() }, 'Fermer')),
      grid,
    );
    this.layer.appendChild(this.panel);
  }

  openMachine(id: number): void {
    this.closePanel();
    const m = this.sim.buildings.get(id) as MachineB | undefined;
    if (!m || (m.type !== 'press' && m.type !== 'assembler')) return;
    this.panelMachine = id;
    this.panel = el('div', { class: 'panel center modal machine-panel' });
    this.layer.appendChild(this.panel);
    this.renderMachine();
  }

  openHub(): void {
    this.closePanel();
    const list = el('div', { class: 'hub-grid' });
    for (const id of ITEM_IDS) {
      list.appendChild(el('div', { class: 'row storage-row' }, el('span', {}, ITEMS[id].name), el('span', { class: 'spacer' }), el('b', { class: 'mono' }, this.sim.count(id))));
    }
    this.panel = el('div', { class: 'panel center modal' },
      el('div', { class: 'row' }, el('h2', {}, 'Hangar central'), el('span', { class: 'spacer' }), el('button', { class: 'small', onclick: () => this.cb.closePanel() }, 'Fermer')),
      el('p', { class: 'muted' }, 'Tout ce qui entre dans le hangar sert à construire et à assembler tes voitures.'),
      list,
      el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'primary', onclick: () => this.cb.garage() }, 'Aller au garage')),
    );
    this.layer.appendChild(this.panel);
  }

  private renderMachine(): void {
    if (!this.panel || this.panelMachine === null) return;
    const m = this.sim.buildings.get(this.panelMachine) as MachineB | undefined;
    if (!m) {
      this.cb.closePanel();
      return;
    }
    clear(this.panel);
    const def = BUILDINGS[m.type];
    const recipe: Recipe | undefined = m.recipe ? RECIPES_BY_ID[m.recipe] : undefined;
    const progress = recipe && m.status === 'working' ? m.progress / recipe.ticks : 0;
    this.panel.append(
      el('div', { class: 'row' }, el('h2', {}, def.name), el('span', { class: 'spacer' }), el('button', { class: 'small', onclick: () => this.cb.closePanel() }, 'Fermer')),
      el('div', { class: `status status-${m.status}` }, STATUS_LABEL[m.status]),
      el('div', { class: 'progress' }, el('div', { style: `width:${Math.round(progress * 100)}%` })),
    );
    if (recipe) {
      const bufs = recipe.inputs.map((s) => `${ITEMS[s.item].name} ${m.inBuf[s.item] ?? 0} (recette : ${s.count})`).join(' · ');
      this.panel.append(el('div', { class: 'muted small' }, `Entrées : ${bufs} — Sortie : ${m.outBuf.length}/${MACHINE.OUT_CAP}`));
      const canLoad = recipe.inputs.some((s) => this.sim.count(s.item) > 0 && (m.inBuf[s.item] ?? 0) < s.count * MACHINE.MANUAL_CAP_FACTOR);
      this.panel.append(
        el('div', { class: 'row', style: 'margin-top:6px;flex-wrap:wrap' },
          el('button', { class: 'small', disabled: !canLoad, title: 'Prend les entrées de la recette dans le hangar central', onclick: () => { this.cb.loadMachine(m.id); this.renderMachine(); } }, 'Charger depuis le hangar'),
          el('button', { class: 'small', disabled: m.outBuf.length === 0, title: 'Envoie la production au hangar central', onclick: () => { this.cb.collect(m.id); this.renderMachine(); } }, `Récupérer la production (${m.outBuf.length})`),
        ),
      );
    }
    this.panel.append(el('h3', { style: 'margin-top:12px' }, 'Recettes'));
    const list = el('div', { class: 'recipe-list' });
    for (const r of recipesFor(def.machine!)) {
      const active = r.id === m.recipe;
      list.appendChild(
        el('button', { class: `recipe${active ? ' selected' : ''}`, onclick: () => { this.cb.setRecipe(m.id, r.id); this.renderMachine(); } },
          el('b', {}, r.name),
          el('span', { class: 'small muted' }, `${itemLabel(r.inputs)} → ${itemLabel(r.outputs)} · ${(r.ticks / 20).toFixed(1)} s`),
        ),
      );
    }
    this.panel.append(list);
  }

  /** Onboarding checklist (top-left). */
  renderObjectives(items: { text: string; hint: string; done: boolean }[]): void {
    const allDone = items.every((i) => i.done);
    const key = items.map((i) => (i.done ? 1 : 0)).join('');
    if (this.objectives.dataset.key === key) return;
    this.objectives.dataset.key = key;
    clear(this.objectives);
    this.objectives.style.display = 'block';
    this.objectives.appendChild(el('h3', {}, allDone ? 'Bravo, la boucle est bouclée !' : 'Objectifs'));
    const next = items.find((i) => !i.done);
    for (const i of items) {
      this.objectives.appendChild(el('div', { class: `objective${i.done ? ' done' : ''}` }, `${i.done ? '✔' : '○'} ${i.text}`));
      if (i === next) this.objectives.appendChild(el('div', { class: 'muted small objective-hint' }, i.hint));
    }
  }

  /** Live refresh of the open machine panel. */
  tick(): void {
    if (this.panelMachine !== null) this.renderMachine();
  }

  dispose(): void {
    this.layer.remove();
  }
}
