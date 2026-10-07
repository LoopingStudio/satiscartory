import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Game } from '../core/Game';
import type { Mode } from '../core/ModeManager';
import { addLightRig } from '../core/Renderer';
import { PhysicsWorld, RAPIER } from '../core/physics/PhysicsWorld';
import { KITS, MODELS, type ModelKey } from '../core/assets/manifest.gen';
import { CAR_SCALE, FACTORY_MODEL_SCALE, PLAYER_HEIGHT, TRACK_CELL } from '../config/constants';
import { createLayer, el } from '../ui/dom';
import { fr } from '../ui/i18n/fr';

const SPACING: Record<string, number> = { 'car-kit': 3.2, 'factory-kit': 3, 'city-kit-roads': 2.6 };
const COLS = 12;

/** Dev mode: every model of every kit + a scale-check corner + a Rapier drop test. */
export class AssetGalleryMode implements Mode {
  readonly name = 'gallery' as const;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private disposeCamera: () => void;
  private disposeResize: (() => void) | null = null;
  private controls: OrbitControls;
  private labels: CSS2DRenderer;
  private layer: HTMLElement | null = null;
  private physics = new PhysicsWorld(-9.81);
  private box: { body: RAPIER.RigidBody; mesh: THREE.Mesh } | null = null;
  private prevBox = new THREE.Vector3();
  private curBox = new THREE.Vector3();
  private prevRot = new THREE.Quaternion();
  private curRot = new THREE.Quaternion();

  constructor(private readonly game: Game) {
    const { camera, dispose } = game.makeCamera(55, 0.1, 1000);
    this.camera = camera;
    this.disposeCamera = dispose;
    this.camera.position.set(-30, 30, -20);
    this.controls = new OrbitControls(this.camera, game.renderer.canvas);
    this.controls.enableDamping = true;
    this.labels = new CSS2DRenderer();
    this.labels.domElement.style.position = 'absolute';
    this.labels.domElement.style.inset = '0';
    this.labels.domElement.style.pointerEvents = 'none';
  }

  enter(): void {
    const rig = addLightRig(this.scene, { shadowSize: 90 });
    rig.follow(new THREE.Vector3(10, 0, 20));
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x5a5f86 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(200, 0.01, 200).setTranslation(0, -0.02, 0));

    let zOffset = 0;
    for (const kit of KITS) {
      const keys = (Object.keys(MODELS) as ModelKey[]).filter((k) => k.startsWith(kit + '/'));
      const sp = SPACING[kit] ?? 3;
      this.addLabel(kit.toUpperCase(), new THREE.Vector3(-sp, 0.5, zOffset), 'kit');
      keys.forEach((key, i) => {
        const obj = this.game.assets.instantiate(key);
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        obj.position.set(col * sp, 0, zOffset + row * sp);
        this.scene.add(obj);
        this.addLabel(key.split('/')[1]!, new THREE.Vector3(col * sp, -0.05, zOffset + row * sp - sp * 0.42));
      });
      zOffset += Math.ceil(keys.length / COLS) * sp + sp * 2;
    }

    this.buildScaleCorner(new THREE.Vector3(-60, 0, 10));
    this.controls.target.set(-40, 0, 10);
    this.camera.position.set(-75, 28, -18);

    this.layer = createLayer();
    this.layer.appendChild(this.labels.domElement);
    // A pad menu, if only so that B leaves (the camera stays mouse-only).
    this.layer.appendChild(
      el(
        'div',
        { class: 'panel top-left', style: 'max-width:420px', 'data-pad-scope': '' },
        el('h2', {}, fr.gallery.title),
        el('div', { class: 'muted' }, fr.gallery.hint),
        el('div', { class: 'row', style: 'margin-top:10px' },
          el('button', { class: 'small', onclick: () => this.focus(new THREE.Vector3(-55, 0, 10), 40) }, fr.gallery.scaleCorner),
          el('button', { class: 'small', onclick: () => this.focus(new THREE.Vector3(15, 0, 6), 45) }, 'Car kit'),
          el('button', { class: 'small', onclick: () => this.focus(new THREE.Vector3(15, 0, 30), 45) }, 'Roads'),
          el('button', { class: 'small', onclick: () => this.focus(new THREE.Vector3(15, 0, 60), 55) }, 'Factory'),
          el('button', { class: 'small', 'data-pad-btn': 'b', onclick: () => this.game.switchMode('menu') }, fr.menu.back),
        ),
      ),
    );
    this.disposeResize = this.game.renderer.onResize((w, h) => this.labels.setSize(w, h));
  }

  private focus(target: THREE.Vector3, dist: number): void {
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(new THREE.Vector3(-dist * 0.6, dist * 0.6, -dist * 0.5));
  }

  private labelObjs: { obj: CSS2DObject; always: boolean }[] = [];

  private addLabel(text: string, pos: THREE.Vector3, kind = ''): void {
    const div = el('div', { class: 'label-3d' }, text);
    if (kind === 'kit') div.style.fontSize = '14px';
    const obj = new CSS2DObject(div);
    obj.position.copy(pos);
    this.scene.add(obj);
    this.labelObjs.push({ obj, always: kind === 'kit' });
  }

  /** Only show model labels close to the camera to avoid clutter. */
  private cullLabels(): void {
    for (const l of this.labelObjs) {
      if (l.always) continue;
      l.obj.visible = l.obj.position.distanceTo(this.camera.position) < 22;
    }
  }

  /** Game-scale check: road tile, car, player capsule, avatar, conveyor and machine side by side. */
  private buildScaleCorner(origin: THREE.Vector3): void {
    const a = this.game.assets;
    const corner = new THREE.Group();
    corner.position.copy(origin);
    this.scene.add(corner);

    // 2×2 road tiles at TRACK_CELL scale + trimesh colliders.
    const roadKey: ModelKey = 'city-kit-roads/road-straight';
    for (let i = 0; i < 2; i++) {
      const road = a.instantiate(roadKey);
      road.scale.setScalar(TRACK_CELL);
      road.position.set(i * TRACK_CELL, 0, 0);
      corner.add(road);
      corner.updateMatrixWorld(true);
      this.physics.addTrimesh(a.mergedGeometry(roadKey), road.matrixWorld);
    }
    const slant = a.instantiate('city-kit-roads/road-slant');
    slant.scale.setScalar(TRACK_CELL);
    slant.position.set(2 * TRACK_CELL, 0, 0);
    corner.add(slant);
    corner.updateMatrixWorld(true);
    this.physics.addTrimesh(a.mergedGeometry('city-kit-roads/road-slant'), slant.matrixWorld);

    const car = a.instantiate('car-kit/race');
    car.scale.setScalar(CAR_SCALE);
    car.position.set(0, 0.02 * TRACK_CELL, 0);
    car.rotation.y = Math.PI / 2; // drive along the road (+X)
    corner.add(car);

    const kart = a.instantiate('car-kit/kart-oopi');
    kart.scale.setScalar(CAR_SCALE);
    kart.position.set(6, 0.02 * TRACK_CELL, 2.5);
    kart.rotation.y = Math.PI / 2;
    corner.add(kart);

    const capsule = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, PLAYER_HEIGHT - 0.7, 4, 12),
      new THREE.MeshStandardMaterial({ color: 0xff9f1c, transparent: true, opacity: 0.6 }),
    );
    capsule.position.set(-4, PLAYER_HEIGHT / 2 + 0.24, 2);
    corner.add(capsule);

    const oopi = a.instantiate('factory-kit/oopi');
    const oopiInfo = a.info('factory-kit/oopi');
    oopi.scale.setScalar(PLAYER_HEIGHT / oopiInfo.size.y);
    oopi.position.set(-4, 0.24, -2);
    corner.add(oopi);

    const conveyor = a.instantiate('factory-kit/conveyor');
    conveyor.scale.setScalar(FACTORY_MODEL_SCALE);
    conveyor.position.set(-10, 0, 0);
    corner.add(conveyor);
    const machine = a.instantiate('factory-kit/machine');
    machine.scale.setScalar(FACTORY_MODEL_SCALE);
    machine.position.set(-10, 0, -5);
    corner.add(machine);

    this.addLabel(`route ×${TRACK_CELL} · voiture ×${CAR_SCALE} · joueur ${PLAYER_HEIGHT} m · usine ×${FACTORY_MODEL_SCALE}`, origin.clone().add(new THREE.Vector3(0, 8, 0)), 'kit');

    // Rapier drop test: a box falls onto the road trimesh and must come to rest.
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(origin.x + 6, origin.y + 8, origin.z - 2).setRotation({ x: 0.2, y: 0.1, z: 0.05, w: 0.97 }),
    );
    this.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setRestitution(0.2), body);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xff5d5d }));
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.box = { body, mesh };
    this.readBox(this.curBox, this.curRot);
    this.prevBox.copy(this.curBox);
    this.prevRot.copy(this.curRot);
  }

  private readBox(p: THREE.Vector3, q: THREE.Quaternion): void {
    if (!this.box) return;
    const t = this.box.body.translation();
    const r = this.box.body.rotation();
    p.set(t.x, t.y, t.z);
    q.set(r.x, r.y, r.z, r.w);
  }

  fixedUpdate(dt: number): void {
    this.prevBox.copy(this.curBox);
    this.prevRot.copy(this.curRot);
    this.physics.step(dt);
    this.readBox(this.curBox, this.curRot);
  }

  update(_dt: number, alpha: number): void {
    if (this.box) {
      this.box.mesh.position.lerpVectors(this.prevBox, this.curBox, alpha);
      this.box.mesh.quaternion.slerpQuaternions(this.prevRot, this.curRot, alpha);
    }
    this.controls.update();
    this.physics.updateDebug();
    this.cullLabels();
    this.labels.render(this.scene, this.camera);
  }

  setDebug(enabled: boolean): void {
    this.physics.setDebug(this.scene, enabled);
  }

  debugInfo(): string {
    if (!this.box) return '';
    const t = this.box.body.translation();
    return `box y=${t.y.toFixed(3)} sleeping=${this.box.body.isSleeping()}`;
  }

  /** For automated checks (window.__game). */
  debugState() {
    const t = this.box?.body.translation();
    return { boxY: t?.y ?? null, boxSleeping: this.box?.body.isSleeping() ?? null, linvel: this.box?.body.linvel() ?? null };
  }

  exit(): void {
    this.controls.dispose();
    this.disposeCamera();
    this.disposeResize?.();
    this.physics.dispose();
    this.layer?.remove();
    this.box?.mesh.geometry.dispose();
  }
}
