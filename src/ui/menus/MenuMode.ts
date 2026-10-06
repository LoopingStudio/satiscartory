import * as THREE from 'three';
import type { Game } from '../../core/Game';
import type { Mode, ModeName } from '../../core/ModeManager';
import { addLightRig } from '../../core/Renderer';
import { CAR_SCALE, FACTORY_MODEL_SCALE, TRACK_CELL } from '../../config/constants';
import { createLayer, el } from '../dom';
import { fr } from '../i18n/fr';
import type { ModelKey } from '../../core/assets/manifest.gen';

export interface MenuEntry {
  label: string;
  mode?: ModeName;
  params?: unknown;
  primary?: boolean;
  action?: () => void;
}

/** Title screen with a slowly orbiting diorama. Entries are provided by main.ts. */
export class MenuMode implements Mode {
  readonly name = 'menu' as const;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private disposeCamera: () => void;
  private layer: HTMLElement | null = null;
  private t = 0;
  private car: THREE.Object3D | null = null;

  constructor(private readonly game: Game, private readonly entries: () => MenuEntry[]) {
    const { camera, dispose } = game.makeCamera(45, 0.5, 500);
    this.camera = camera;
    this.disposeCamera = dispose;
  }

  enter(): void {
    addLightRig(this.scene, { shadowSize: 40, fog: [60, 160] });
    const a = this.game.assets;
    const ground = new THREE.Mesh(new THREE.CircleGeometry(200, 48), new THREE.MeshStandardMaterial({ color: 0x575b80 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // A small loop of road around the scene.
    const road = (key: ModelKey, x: number, z: number, rot: number) => {
      const o = a.instantiate(key);
      o.scale.setScalar(TRACK_CELL);
      o.position.set(x * TRACK_CELL, 0, z * TRACK_CELL);
      o.rotation.y = rot * (Math.PI / 2);
      this.scene.add(o);
    };
    for (let x = -1; x <= 1; x++) road('city-kit-roads/road-straight', x, 1, 0);
    // Factory props in the middle.
    const prop = (key: ModelKey, x: number, z: number, rot = 0) => {
      const o = a.instantiate(key);
      o.scale.setScalar(FACTORY_MODEL_SCALE);
      o.position.set(x, 0, z);
      o.rotation.y = rot;
      this.scene.add(o);
      return o;
    };
    prop('factory-kit/machine', -4, -3, Math.PI / 2);
    prop('factory-kit/robot-arm-a', 0, -3.5);
    for (let i = 0; i < 5; i++) prop('factory-kit/conveyor', 4 + i * 2, -3, Math.PI / 2);
    prop('factory-kit/hopper-high-square', -9, -4);
    prop('factory-kit/box-large', 3, 1.5, 0.4);
    prop('factory-kit/structure-tall', -12, -8);
    prop('factory-kit/structure-tall', 12, -8);

    this.car = a.instantiate('car-kit/race');
    this.car.scale.setScalar(CAR_SCALE);
    this.scene.add(this.car);

    this.layer = createLayer('menu-screen');
    this.layer.style.display = 'flex';
    const card = el('div', { class: 'panel menu-card' }, el('h1', {}, fr.title), el('div', { class: 'subtitle' }, fr.subtitle));
    for (const e of this.entries()) {
      const enabled = !e.mode || this.game.modes.has(e.mode);
      card.appendChild(
        el(
          'button',
          {
            class: e.primary ? 'primary' : '',
            disabled: !enabled,
            onclick: () => {
              if (e.action) e.action();
              else if (e.mode) void this.game.switchMode(e.mode, e.params);
            },
          },
          e.label,
        ),
      );
    }
    this.layer.appendChild(card);
  }

  fixedUpdate(): void {}

  update(dt: number): void {
    this.t += dt;
    const r = 34;
    this.camera.position.set(Math.cos(this.t * 0.08) * r, 14, Math.sin(this.t * 0.08) * r);
    this.camera.lookAt(0, 2, 0);
    if (this.car) {
      // Car drives back and forth along the road strip.
      const x = Math.sin(this.t * 0.35) * TRACK_CELL * 1.2;
      const dir = Math.cos(this.t * 0.35) >= 0 ? 1 : -1;
      this.car.position.set(x, 0.02 * TRACK_CELL, TRACK_CELL + (dir > 0 ? -2.5 : 2.5));
      this.car.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    }
  }

  exit(): void {
    this.disposeCamera();
    this.layer?.remove();
  }
}
