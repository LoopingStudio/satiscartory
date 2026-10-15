import * as THREE from 'three';
import type { Game } from '../../core/Game';
import type { Mode, ModeName } from '../../core/ModeManager';
import { addLightRig, type LightRig } from '../../core/Renderer';
import { CAR_SCALE, FACTORY_MODEL_SCALE, TRACK_CELL } from '../../config/constants';
import { createLayer, el } from '../dom';
import { fr } from '../i18n/fr';
import type { ModelKey } from '../../core/assets/manifest.gen';
import { PlayerAvatar } from '../../player/PlayerAvatar';
import type { CharacterLook } from '../../data/character';

/** Where the player's character stands in the diorama, and which way it faces (toward the road). */
const AVATAR_SPOT = new THREE.Vector3(6, 0, 3);
const AVATAR_YAW = -0.5;

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
  private rig: LightRig | null = null;
  private t = 0;
  private car: THREE.Object3D | null = null;
  private avatar: PlayerAvatar | null = null;
  /** The « Personnage » panel is open: the camera frames the character instead of orbiting. */
  private portrait = false;
  private card: HTMLElement | null = null;

  constructor(private readonly game: Game, private readonly entries: () => MenuEntry[], private readonly look?: () => CharacterLook) {
    const { camera, dispose } = game.makeCamera(45, 0.5, 500);
    this.camera = camera;
    this.disposeCamera = dispose;
  }

  enter(): void {
    this.rig = addLightRig(this.scene, { shadowSize: 40, fog: [60, 160] });
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

    // The player's character watches the cars go by.
    if (this.look) {
      this.avatar = new PlayerAvatar(a, this.look());
      this.scene.add(this.avatar.root);
    }

    this.layer = createLayer('menu-screen');
    this.layer.style.display = 'flex';
    // A pad menu that starts on the primary entry. No guard against a second A: a mode switch exits this
    // mode (and removes its layer) synchronously in the click, so nothing is left to click twice.
    const card = el('div', { class: 'panel menu-card', 'data-pad-scope': '' }, el('h1', {}, fr.title), el('div', { class: 'subtitle' }, fr.subtitle));
    for (const e of this.entries()) {
      const enabled = !e.mode || this.game.modes.has(e.mode);
      card.appendChild(
        el(
          'button',
          {
            class: e.primary ? 'primary' : '',
            disabled: !enabled,
            'data-pad-default': !!e.primary,
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
    this.card = card;
  }

  /** « Personnage »: frames the character (true) and hides the menu card, or goes back to the orbit. */
  setPortrait(on: boolean): void {
    this.portrait = on;
    if (this.card) this.card.style.display = on ? 'none' : '';
    this.refreshLook();
  }

  /** Re-reads the look (after a change in the « Personnage » panel). */
  refreshLook(): void {
    if (this.avatar && this.look) this.avatar.setLook(this.look());
  }

  fixedUpdate(): void {}

  update(dt: number): void {
    this.t += dt;
    if (this.avatar) this.avatar.update(dt, AVATAR_SPOT, 0, true, this.portrait ? AVATAR_YAW + 0.35 : AVATAR_YAW, 0);
    if (this.portrait) {
      // In front of the character, which stands on the left of the screen (the panel is on the right).
      const fx = Math.sin(AVATAR_YAW + 0.35);
      const fz = Math.cos(AVATAR_YAW + 0.35);
      // The menu camera is narrower (45°) than the factory's: from farther away.
      const side = 1.5;
      const target = new THREE.Vector3(AVATAR_SPOT.x + fx * 6.2 + fz * side, 1.8, AVATAR_SPOT.z + fz * 6.2 - fx * side);
      this.camera.position.lerp(target, 1 - Math.exp(-5 * dt));
      this.camera.lookAt(AVATAR_SPOT.x + fz * side, 1.0, AVATAR_SPOT.z - fx * side);
    } else {
      const r = 34;
      this.camera.position.set(Math.cos(this.t * 0.08) * r, 14, Math.sin(this.t * 0.08) * r);
      this.camera.lookAt(0, 2, 0);
    }
    if (this.car) {
      // Car drives back and forth along the road strip.
      const x = Math.sin(this.t * 0.35) * TRACK_CELL * 1.2;
      const dir = Math.cos(this.t * 0.35) >= 0 ? 1 : -1;
      this.car.position.set(x, 0.02 * TRACK_CELL, TRACK_CELL + (dir > 0 ? -2.5 : 2.5));
      this.car.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    }
  }

  exit(): void {
    this.avatar?.dispose();
    this.rig?.dispose();
    this.disposeCamera();
    this.layer?.remove();
  }
}
