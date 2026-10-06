import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Game } from '../core/Game';
import type { Mode } from '../core/ModeManager';
import { addLightRig, type LightRig } from '../core/Renderer';
import type { GameState } from '../state/GameState';
import { FactoryView } from './view/FactoryView';
import { FACTORY_CELL } from '../config/constants';
import { FACTORY_MAP } from '../data/factoryMap';
import { ITEMS, ITEM_IDS } from '../data/items';
import { createLayer, el, clear } from '../ui/dom';
import { FactorySim } from './sim/FactorySim';
import { spawnDemoFactory, spawnStressLoops } from './sim/testLayouts';

export interface FactoryModeParams {
  layout?: 'demo' | 'stress';
}

/** Factory mode. P1: overview camera over the live simulation. */
export class FactoryMode implements Mode {
  readonly name = 'factory' as const;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private disposeCamera: () => void;
  private controls: OrbitControls;
  private view!: FactoryView;
  private rig!: LightRig;
  private layer: HTMLElement | null = null;
  private storagePanel: HTMLElement | null = null;
  private hudTimer = 0;
  private sim!: FactorySim;

  constructor(private readonly game: Game, private readonly state: GameState) {
    const { camera, dispose } = game.makeCamera(55, 0.1, 1500);
    this.camera = camera;
    this.disposeCamera = dispose;
    this.controls = new OrbitControls(this.camera, game.renderer.canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.45;
  }

  enter(params?: FactoryModeParams): void {
    if (params?.layout === 'stress') {
      // Separate throwaway sim (does not touch the player's factory).
      this.sim = new FactorySim({ hub: null });
      spawnStressLoops(this.sim);
      this.state.sim = this.sim;
    } else {
      this.sim = this.state.sim;
      if (params?.layout === 'demo') spawnDemoFactory(this.sim);
    }
    this.rig = addLightRig(this.scene, { shadowSize: 60, fog: [120, 400] });
    this.view = new FactoryView(this.game.assets, this.sim);
    this.scene.add(this.view.root);

    const hub = FACTORY_MAP.hub;
    const target = new THREE.Vector3((hub.x + 1.5) * FACTORY_CELL, 0, (hub.z + 1.5) * FACTORY_CELL);
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(new THREE.Vector3(-22, 34, -30));

    this.layer = createLayer();
    this.storagePanel = el('div', { class: 'panel top-right', style: 'min-width:200px' });
    this.layer.appendChild(this.storagePanel);
    this.layer.appendChild(
      el('div', { class: 'panel top-left' },
        el('h2', {}, 'Usine'),
        el('div', { class: 'muted' }, 'Vue d’ensemble'),
        el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'small', onclick: () => this.game.switchMode('menu') }, 'Menu')),
      ),
    );
    this.updateHud();
  }

  private updateHud(): void {
    if (!this.storagePanel) return;
    clear(this.storagePanel);
    this.storagePanel.appendChild(el('h3', {}, 'Hangar central'));
    for (const id of ITEM_IDS) {
      const n = this.sim.count(id);
      if (!n) continue;
      this.storagePanel.appendChild(el('div', { class: 'row' }, el('span', {}, ITEMS[id].name), el('span', { class: 'spacer' }), el('b', { class: 'mono' }, n)));
    }
  }

  fixedUpdate(): void {}

  update(dt: number): void {
    this.controls.update();
    this.rig.follow(this.controls.target);
    this.view.update(dt, this.game.loop.factoryAlpha);
    this.hudTimer += dt;
    if (this.hudTimer > 0.25) {
      this.hudTimer = 0;
      this.updateHud();
    }
  }

  debugInfo(): string {
    return `sim tick ${this.sim.tickCount}  buildings ${this.sim.buildings.size}  belt items ${this.sim.beltItemCount()} (drawn ${this.view.itemCount()})`;
  }

  /** For automated checks (window.__game). */
  debugState() {
    return { tick: this.sim.tickCount, storage: { ...this.sim.storage }, delivered: { ...this.sim.delivered }, beltItems: this.sim.beltItemCount(), buildings: this.sim.buildings.size };
  }

  exit(): void {
    this.controls.dispose();
    this.disposeCamera();
    this.view.dispose();
    this.layer?.remove();
  }
}
