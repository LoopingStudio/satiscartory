import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Mode } from '../core/ModeManager';
import { addLightRig } from '../core/Renderer';
import type { GameState } from '../state/GameState';
import { SaveManager } from '../state/SaveManager';
import { BLUEPRINTS, BLUEPRINT_IDS, type BlueprintId } from '../data/blueprints';
import { ITEMS, countLabel, type ItemId } from '../data/items';
import { PART_MODIFIERS } from '../data/parts';
import { CarModel } from '../car/CarModel';
import { computeCarStats, statBars, type CarSpec, type StatBars } from '../car/stats';
import { clear, createLayer, el, toast } from '../ui/dom';
import { assemble, checkAssembly, defaultChoices, disassemble, specOf, swapPart, type CarInstance, type PartChoices } from './assembly';

export interface GarageParams {
  /** Open the draft of a new car of this blueprint. */
  blueprint?: BlueprintId;
}

type View = { kind: 'car'; id: string | null } | { kind: 'draft'; blueprint: BlueprintId; choices: PartChoices };

const STAT_LABELS: Record<keyof StatBars, string> = { speed: 'Vitesse', accel: 'Accélération', grip: 'Adhérence', weight: 'Poids' };

/** Garage: assemble cars from factory parts, swap parts, pick the car to race. */
export class GarageMode implements Mode {
  readonly name = 'garage' as const;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private disposeCamera: () => void;
  private view: View = { kind: 'car', id: null };
  private turntable = new THREE.Group();
  private display: CarModel | null = null;
  private displayKey = '';
  private layer: HTMLElement | null = null;
  private left!: HTMLElement;
  private right!: HTMLElement;
  private t = 0;
  private storageKey = '';

  constructor(private readonly game: Game, private readonly state: GameState) {
    const { camera, dispose } = game.makeCamera(40, 0.1, 200);
    this.camera = camera;
    this.disposeCamera = dispose;
  }

  enter(params?: GarageParams): void {
    this.buildScene();
    this.layer = createLayer('garage-ui');
    this.left = el('div', { class: 'panel garage-left' });
    this.right = el('div', { class: 'panel garage-right' });
    this.layer.append(
      this.left,
      this.right,
      el('div', { class: 'bottom-center row garage-nav' },
        el('button', { onclick: () => void this.game.switchMode('factory') }, 'Usine'),
        el('button', { class: 'primary', onclick: () => void this.game.switchMode('tracks') }, 'Courir'),
        el('button', { onclick: () => void this.game.switchMode('menu') }, 'Menu'),
      ),
    );
    if (params?.blueprint && BLUEPRINTS[params.blueprint]?.buildable) this.newDraft(params.blueprint);
    else this.view = { kind: 'car', id: this.state.selectedCarId };
    this.render();
  }

  private buildScene(): void {
    addLightRig(this.scene, { shadowSize: 12, sky: 0x2b2d42 });
    const a = this.game.assets;
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
      const f = a.instantiate('factory-kit/floor-large');
      f.scale.setScalar(2);
      f.position.set(x * 4, 0, z * 4);
      this.scene.add(f);
    }
    for (let x = -3; x <= 3; x++) {
      const w = a.instantiate('factory-kit/structure-wall');
      w.scale.setScalar(4);
      w.position.set(x * 4, 0, -10);
      this.scene.add(w);
    }
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.6, 0.3, 48), new THREE.MeshStandardMaterial({ color: 0x3a3e63, metalness: 0.3, roughness: 0.4 }));
    plate.position.y = 0.15;
    plate.receiveShadow = true;
    this.turntable.add(plate);
    this.turntable.position.set(0, 0, 0);
    this.scene.add(this.turntable);
    const spot = new THREE.SpotLight(0xffffff, 60, 30, 0.6, 0.5);
    spot.position.set(3, 9, 6);
    spot.target = this.turntable;
    spot.castShadow = true;
    this.scene.add(spot);
    this.camera.position.set(0, 4.2, 13);
    this.camera.lookAt(0, 1.0, 0);
  }

  // ------------------------------------------------------------------ helpers

  private get storage() {
    return this.state.sim.storage;
  }

  private car(id: string | null): CarInstance | null {
    return id ? (this.state.cars.find((c) => c.id === id) ?? null) : null;
  }

  private currentSpec(): CarSpec {
    if (this.view.kind === 'draft') {
      const parts: CarSpec['parts'] = {};
      for (const [slot, item] of Object.entries(this.view.choices)) if (item) parts[slot] = item;
      return { blueprint: this.view.blueprint, parts };
    }
    return specOf(this.car(this.view.id));
  }

  private newDraft(bp: BlueprintId): void {
    this.view = { kind: 'draft', blueprint: bp, choices: defaultChoices(BLUEPRINTS[bp]) };
    // Prefer the best wheels in stock.
    const slot = BLUEPRINTS[bp].slots.find((s) => s.id === 'wheels');
    if (slot && (this.storage.wheel_racing ?? 0) >= slot.count) this.view.choices.wheels = 'wheel_racing';
    if (BLUEPRINTS[bp].slots.some((s) => s.id === 'spoiler') && (this.storage.spoiler ?? 0) > 0) this.view.choices.spoiler = 'spoiler';
  }

  private updateDisplay(): void {
    const spec = this.currentSpec();
    const key = JSON.stringify(spec);
    if (key === this.displayKey) return;
    this.displayKey = key;
    if (this.display) this.display.root.removeFromParent();
    this.display = new CarModel(this.game.assets, spec);
    this.display.root.position.y = 0.3;
    this.turntable.add(this.display.root);
  }

  // ------------------------------------------------------------------ UI

  private render(): void {
    this.renderLeft();
    this.renderRight();
    this.updateDisplay();
  }

  private renderLeft(): void {
    const l = this.left;
    clear(l);
    l.appendChild(el('h2', {}, 'Garage'));
    l.appendChild(el('h3', {}, 'Mes voitures'));
    const rows: { id: string | null; name: string; sub: string }[] = [
      { id: null, name: BLUEPRINTS.loaner.name, sub: 'Prêt du circuit' },
      ...this.state.cars.map((c) => ({ id: c.id, name: c.name, sub: BLUEPRINTS[c.blueprint as BlueprintId]?.name ?? c.blueprint })),
    ];
    for (const r of rows) {
      const viewing = this.view.kind === 'car' && this.view.id === r.id;
      const racing = (this.state.selectedCarId ?? null) === r.id;
      l.appendChild(
        el('button', { class: `car-row${viewing ? ' selected' : ''}`, 'data-car': r.id ?? 'loaner', onclick: () => { this.view = { kind: 'car', id: r.id }; this.render(); } },
          el('span', { class: 'car-star' }, racing ? '★' : '☆'),
          el('span', { class: 'col', style: 'gap:0' }, el('b', {}, r.name), el('span', { class: 'muted small' }, r.sub)),
        ),
      );
    }
    l.appendChild(el('h3', { style: 'margin-top:12px' }, 'Nouvelle voiture'));
    for (const id of BLUEPRINT_IDS) {
      const bp = BLUEPRINTS[id];
      if (!bp.buildable) continue;
      const drafting = this.view.kind === 'draft' && this.view.blueprint === id;
      const ok = checkAssembly(this.storage, id, defaultChoices(bp)).ok;
      l.appendChild(
        el('button', { class: `car-row${drafting ? ' selected' : ''}`, 'data-blueprint': id, onclick: () => { this.newDraft(id); this.render(); } },
          el('span', { class: 'car-star' }, '+'),
          el('span', { class: 'col', style: 'gap:0' }, el('b', {}, bp.name), el('span', { class: ok ? 'good small' : 'muted small' }, ok ? 'Pièces disponibles !' : 'Pièces à produire')),
        ),
      );
    }
    l.appendChild(el('h3', { style: 'margin-top:12px' }, 'Pièces en stock'));
    const parts: ItemId[] = ['chassis', 'engine', 'wheel', 'wheel_racing', 'panel', 'spoiler'];
    const grid = el('div', { class: 'stock-grid small' });
    for (const p of parts) grid.appendChild(el('div', { class: 'row' }, el('span', {}, ITEMS[p].name), el('span', { class: 'spacer' }), el('b', { class: 'mono' }, this.storage[p] ?? 0)));
    l.appendChild(grid);
  }

  private statsBlock(spec: CarSpec, compare: CarSpec | null): HTMLElement {
    const bars = statBars(computeCarStats(spec));
    const ref = compare ? statBars(computeCarStats(compare)) : null;
    const block = el('div', { class: 'stat-bars' });
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
    const s = computeCarStats(spec);
    block.appendChild(el('div', { class: 'muted small' }, `${Math.round(s.topSpeedMs * 3.6)} km/h max · ${Math.round(s.massKg)} kg · adhérence ×${s.grip.toFixed(2)}`));
    return block;
  }

  private renderRight(): void {
    const r = this.right;
    clear(r);
    const selected = this.car(this.state.selectedCarId);
    if (this.view.kind === 'draft') {
      const view = this.view;
      const bp = BLUEPRINTS[view.blueprint];
      const check = checkAssembly(this.storage, view.blueprint, view.choices);
      r.append(el('h2', {}, `Nouvelle voiture : ${bp.name}`), el('div', { class: 'muted small' }, bp.description));
      for (const slot of bp.slots) {
        const row = el('div', { class: 'slot-row' }, el('b', {}, `${slot.name}${slot.count > 1 ? ` ×${slot.count}` : ''}`));
        const opts = el('div', { class: 'row', style: 'flex-wrap:wrap' });
        const options: (ItemId | null)[] = [...(slot.optional ? [null] : []), ...slot.accepts];
        for (const item of options) {
          const have = item ? (this.storage[item] ?? 0) : Infinity;
          const enough = have >= slot.count;
          const active = view.choices[slot.id] === item;
          opts.appendChild(
            el('button', { class: `small${active ? ' selected' : ''}`, 'data-slot': slot.id, 'data-item': item ?? 'none', onclick: () => { view.choices[slot.id] = item; this.render(); } },
              item ? `${ITEMS[item].name} (${have}/${slot.count})` : 'Aucun'),
          );
          if (active && item && !enough) row.classList.add('lacking');
        }
        row.appendChild(opts);
        const mod = view.choices[slot.id] ? PART_MODIFIERS[view.choices[slot.id]!] : undefined;
        if (mod && mod.label && view.choices[slot.id] !== slot.accepts[0]) row.appendChild(el('div', { class: 'muted small' }, mod.label));
        r.appendChild(row);
      }
      r.appendChild(el('h3', { style: 'margin-top:8px' }, 'Performances'));
      r.appendChild(this.statsBlock(this.currentSpec(), specOf(selected)));
      if (!check.ok) {
        const missing = Object.entries(check.missing).map(([i, n]) => countLabel(i as ItemId, n ?? 0));
        r.appendChild(el('div', { class: 'bad small', style: 'margin-top:6px' }, missing.length ? `Il manque : ${missing.join(', ')}. Produis-les à l’usine (Assembleuse).` : 'Choisis toutes les pièces.'));
      }
      r.appendChild(
        el('div', { class: 'row', style: 'margin-top:10px' },
          el('button', { class: 'primary', disabled: !check.ok, onclick: () => this.doAssemble() }, 'Assembler'),
        ),
      );
      return;
    }

    const car = this.car(this.view.id);
    const bpId = (car?.blueprint ?? 'loaner') as BlueprintId;
    const bp = BLUEPRINTS[bpId];
    r.append(el('h2', {}, car?.name ?? bp.name), el('div', { class: 'muted small' }, bp.description));
    r.appendChild(this.statsBlock(specOf(car), null));
    if (car) {
      r.appendChild(el('h3', { style: 'margin-top:8px' }, 'Pièces'));
      for (const slot of bp.slots) {
        const row = el('div', { class: 'slot-row' }, el('b', {}, `${slot.name}${slot.count > 1 ? ` ×${slot.count}` : ''}`));
        const opts = el('div', { class: 'row', style: 'flex-wrap:wrap' });
        const options: (ItemId | null)[] = [...(slot.optional ? [null] : []), ...slot.accepts];
        for (const item of options) {
          const active = (car.parts[slot.id] ?? null) === item;
          const have = item ? (this.storage[item] ?? 0) : 0;
          const can = active || item === null || have >= slot.count;
          opts.appendChild(
            el('button', {
              class: `small${active ? ' selected' : ''}`,
              disabled: !can,
              onclick: () => {
                if (swapPart(this.storage, car, slot.id, item)) {
                  toast('Pièce changée', 'success');
                  SaveManager.save(this.state);
                }
                this.render();
              },
            }, item ? `${ITEMS[item].name}${active ? '' : ` (${have} en stock)`}` : 'Aucun'),
          );
        }
        row.appendChild(opts);
        r.appendChild(row);
      }
    }
    const isRacing = (this.state.selectedCarId ?? null) === (car?.id ?? null);
    r.appendChild(
      el('div', { class: 'row', style: 'margin-top:10px;flex-wrap:wrap' },
        el('button', { class: isRacing ? 'selected' : 'primary', disabled: isRacing, onclick: () => { this.state.selectedCarId = car?.id ?? null; SaveManager.save(this.state); this.render(); } }, isRacing ? '★ Voiture de course' : 'Choisir pour courir'),
        car ? el('button', { class: 'danger', onclick: () => this.doDisassemble(car) }, 'Démonter') : null,
      ),
    );
  }

  private doAssemble(): void {
    if (this.view.kind !== 'draft') return;
    const serial = ++this.state.carCounter;
    const car = assemble(this.storage, this.view.blueprint, this.view.choices, serial);
    if (!car) {
      this.state.carCounter--;
      toast('Pièces insuffisantes', 'error');
      return;
    }
    this.state.cars.push(car);
    this.state.selectedCarId = car.id;
    this.state.objectives.assembled = true;
    SaveManager.save(this.state);
    toast(`${car.name} assemblée !`, 'success');
    this.view = { kind: 'car', id: car.id };
    this.render();
  }

  private doDisassemble(car: CarInstance): void {
    if (!window.confirm(`Démonter « ${car.name} » ? Les pièces retournent au hangar.`)) return;
    disassemble(this.storage, car);
    this.state.cars = this.state.cars.filter((c) => c.id !== car.id);
    if (this.state.selectedCarId === car.id) this.state.selectedCarId = this.state.cars[0]?.id ?? null;
    SaveManager.save(this.state);
    this.view = { kind: 'car', id: this.state.selectedCarId };
    this.render();
  }

  // ------------------------------------------------------------------ frame

  fixedUpdate(): void {}

  update(dt: number): void {
    this.t += dt;
    this.turntable.rotation.y = this.t * 0.35;
    this.display?.update(dt, 0, 0);
    if (this.game.input.wasPressed('cancel')) void this.game.switchMode('menu');
    // Parts keep arriving from the factory: refresh counts when storage changes.
    const key = ['chassis', 'engine', 'wheel', 'wheel_racing', 'panel', 'spoiler'].map((i) => this.storage[i as ItemId] ?? 0).join(',');
    if (key !== this.storageKey) {
      this.storageKey = key;
      this.renderLeft();
      this.renderRight();
    }
  }

  debugState() {
    return {
      view: this.view,
      cars: this.state.cars.map((c) => ({ id: c.id, name: c.name, blueprint: c.blueprint, parts: c.parts })),
      selected: this.state.selectedCarId,
      storage: { ...this.storage },
    };
  }

  exit(): void {
    this.layer?.remove();
    this.disposeCamera();
  }
}
