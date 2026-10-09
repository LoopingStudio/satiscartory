import * as THREE from 'three';
import type { AssetLoader } from '../core/assets/AssetLoader';
import { CAR_SCALE } from '../config/constants';
import { BLUEPRINTS } from '../data/blueprints';
import { ITEMS, type ItemId } from '../data/items';
import type { BuildLook } from '../garage/build';
import { carGeometryFromBoxes, engineAnchor, type CarGeometry, type NodeBox } from './geometry';
import type { CarSpec } from './stats';

type ModelKey = Parameters<AssetLoader['instantiate']>[0];

/** Measured layouts per loader and model: measuring clones the whole GLB. Read-only, never mutate. */
const geometryCache = new WeakMap<AssetLoader, Map<ModelKey, CarGeometry>>();

/** Per-node bounding boxes of a loaded car model (model space). Cached per model. */
export function carGeometryOf(assets: AssetLoader, model: ModelKey): CarGeometry {
  let byModel = geometryCache.get(assets);
  if (!byModel) geometryCache.set(assets, (byModel = new Map()));
  const cached = byModel.get(model);
  if (cached) return cached;
  const obj = assets.instantiate(model);
  obj.updateMatrixWorld(true);
  const boxes: NodeBox[] = [];
  // Top-level parts are the children of the GLTF scene root (or of its single child).
  let parts = obj.children;
  if (parts.length === 1 && parts[0]!.children.length > 1) {
    const only = parts[0]!;
    // Own mesh only (setFromObject would include the wheels and the driver).
    const own = new THREE.Box3();
    const mesh = only as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.computeBoundingBox();
      own.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
    }
    parts = only.children;
    if (!own.isEmpty()) boxes.push({ name: only.name, min: own.min.toArray() as [number, number, number], max: own.max.toArray() as [number, number, number] });
  }
  for (const p of parts) {
    const b = new THREE.Box3().setFromObject(p, true);
    if (b.isEmpty()) continue;
    boxes.push({ name: p.name, min: b.min.toArray() as [number, number, number], max: b.max.toArray() as [number, number, number] });
  }
  const geometry = carGeometryFromBoxes(boxes);
  byModel.set(model, geometry);
  return geometry;
}

/** Body of a car under construction once the chassis is in but not every panel: bare metal. */
const bareMaterial = new THREE.MeshStandardMaterial({ color: 0x9aa0b4, metalness: 0.55, roughness: 0.45 });
/** Jack stands under the wheels not installed yet (garage yellow). */
const standMaterial = new THREE.MeshStandardMaterial({ color: 0xf0b36a, roughness: 0.7 });
const standGeometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);

/** What a worn look darkens: the wheels (tire and rim are one mesh) or the body (paint, windows and lights alike). */
export type WornKind = 'tire' | 'body';

/**
 * Tints (sRGB) of the worn looks per kind and step (data/wear.ts wearLevel 1..3), multiplying the kit's colormap: the
 * tires darker (rubber is dark already), the body a little warm (dust, grease). The darkest step: « à réparer ».
 */
export const WORN_TINTS: Readonly<Record<WornKind, readonly [number, number, number]>> = {
  tire: [0xbfbfbf, 0x8c8c8c, 0x5e5e5e],
  body: [0xd8d2c8, 0xaea392, 0x83776a],
};

/** Worn copies of a kit material: [tire 1..3, body 1..3]. */
const wornMats = new WeakMap<THREE.Material, THREE.Material[]>();

/** Every material of this module shared by the cars and kept while no mesh shows it (refreshSharedCarMaterials). */
const sharedMats = new Set<THREE.Material>([bareMaterial, standMaterial]);

/**
 * Darkened copy of a kit material for a kind and step, shared by every car and never freed (like bareMaterial): 6 at
 * most per kit material, so 6 for the whole game. Only the color differs from the kit's (same map, same program: no
 * shader compiles when a car turns worn). The kit material itself is never touched.
 */
export function wornMaterial(base: THREE.Material, kind: WornKind, level: 1 | 2 | 3): THREE.Material {
  let list = wornMats.get(base);
  if (!list) wornMats.set(base, (list = []));
  const i = (kind === 'tire' ? 0 : 3) + level - 1;
  let mat = list[i];
  if (!mat) {
    mat = base.clone();
    mat.name = `${base.name || 'kit'} worn ${kind} ${level}`;
    (mat as THREE.MeshStandardMaterial).color?.multiply(new THREE.Color(WORN_TINTS[kind][level - 1]));
    list[i] = mat;
    sharedMats.add(mat);
  }
  return mat;
}

/**
 * After the shadows setting changed (ui/menus/SettingsPanel.ts applySettings): the shared materials (bare body, jack
 * stands, worn looks) take it the next time they are drawn. The renderer only flags the materials of the scene shown,
 * and three checks the setting only when a material's version or the lights change: a worn step no car shows at the
 * toggle would come back with the old setting's program (frozen shadows, or none). No compile when nothing changed
 * for them (a worn look shares the kit material's program).
 */
export function refreshSharedCarMaterials(): void {
  for (const m of sharedMats) m.needsUpdate = true;
}

/** A mesh of the model and the material it was loaded with (the kit's): the look starts from it again. */
interface Paint {
  mesh: THREE.Mesh;
  base: THREE.Material;
}

interface WheelRig {
  pivot: THREE.Group;
  spinner: THREE.Group;
  baseY: number;
  front: boolean;
  radius: number;
}

/**
 * Visual car built from a blueprint + installed parts, with animated wheels. Meshes share the
 * asset cache's geometries and kit material (never mutated); the only owned resource is the
 * ghost material, freed by dispose(). Wear darkens the tires and the body by steps (setWear) with
 * worn materials shared by every car (wornMaterial, never freed): no rebuild, the driver never
 * changes, the spoiler follows its own gauge.
 */
export class CarModel {
  readonly root = new THREE.Group();
  readonly geometry: CarGeometry;
  private wheels: WheelRig[] = [];
  private spin = 0;
  /** The kart's seated character (null for cars without one). */
  private readonly driver: THREE.Object3D | null;
  private ghostMat: THREE.MeshStandardMaterial | null = null;
  private readonly spoiler: THREE.Object3D | null;
  /** Jack stands and loose engine of a car under construction (setBuildLook). */
  private readonly buildExtras = new THREE.Group();
  /**
   * Meshes per look group, collected once: the body (without the spoiler, the driver and an original wheel hidden
   * under a racing one), the spoiler, the kart's seated driver, and each wheel (this.wheels' order).
   */
  private readonly paint: { body: Paint[]; spoiler: Paint[]; driver: Paint[]; wheels: Paint[][] } = { body: [], spoiler: [], driver: [], wheels: [] };
  /** data/wear.ts wearLookCode of the look shown (0: new). */
  private wearCode = 0;
  /** Car under construction (setBuildLook): its overrides win over the wear. */
  private build: BuildLook | null = null;
  /** Ghost preview (setGhost): every mesh see-through, the wear ignored. */
  private ghostAll = false;
  /** Where the engine smoke comes out (car frame, meters; geometry.ts engineAnchor). */
  readonly engineAnchor: THREE.Vector3;

  constructor(private readonly assets: AssetLoader, private readonly spec: CarSpec) {
    const bp = BLUEPRINTS[spec.blueprint];
    this.geometry = carGeometryOf(assets, bp.model);
    this.engineAnchor = new THREE.Vector3(...engineAnchor(this.geometry, bp.engineMount, CAR_SCALE));
    // The model as loaded (body, optional parts; the wheels are moved to their pivots).
    const body = assets.instantiate(bp.model);
    this.root.add(body);
    this.root.scale.setScalar(CAR_SCALE);
    body.updateMatrixWorld(true);
    this.driver = body.getObjectByName('character') ?? null;

    const wheelItem: ItemId | undefined = spec.parts.wheels;
    const racing = wheelItem === 'wheel_racing';
    // Hide/show optional body parts.
    const spoiler = body.getObjectByName('spoiler');
    this.spoiler = spoiler ?? null;
    if (spoiler) spoiler.visible = !!spec.parts.spoiler;

    for (const w of this.geometry.wheels) {
      const node = body.getObjectByName(w.name);
      if (!node) continue;
      const pivot = new THREE.Group();
      pivot.position.set(...w.center);
      const spinner = new THREE.Group();
      pivot.add(spinner);
      this.root.add(pivot);
      if (racing) {
        // Swap the wheel mesh for the racing wheel, mirrored on the right side.
        node.visible = false;
        const rw = assets.instantiate('car-kit/wheel-racing');
        const info = assets.info('car-kit/wheel-racing');
        const s = w.radius / (info.size.y / 2);
        rw.scale.set(w.left ? s : -s, s, s);
        spinner.add(rw);
      } else {
        // Re-parent the original wheel under the spinner, keeping its world placement.
        const world = new THREE.Matrix4().copy(node.matrixWorld);
        node.removeFromParent();
        spinner.add(node);
        const inv = new THREE.Matrix4().makeTranslation(-w.center[0], -w.center[1], -w.center[2]);
        node.matrix.copy(inv.multiply(world));
        node.matrix.decompose(node.position, node.quaternion, node.scale);
      }
      this.wheels.push({ pivot, spinner, baseY: w.center[1], front: w.front, radius: w.radius * CAR_SCALE });
    }
    this.collectPaint(body, this.paint.body);
    for (const w of this.wheels) {
      const list: Paint[] = [];
      this.collectPaint(w.spinner, list);
      this.paint.wheels.push(list);
    }
  }

  /** Sorts the meshes under `o` into the look groups (`into`: the group of `o` itself). */
  private collectPaint(o: THREE.Object3D, into: Paint[]): void {
    // An original wheel left under the body: hidden by its racing wheel, never painted.
    if (o.name.startsWith('wheel-') && into === this.paint.body) return;
    const group = o.name === 'character' ? this.paint.driver : o.name === 'spoiler' ? this.paint.spoiler : into;
    const m = o as THREE.Mesh;
    if (m.isMesh) group.push({ mesh: m, base: m.material as THREE.Material });
    for (const c of o.children) this.collectPaint(c, group);
  }

  /** The model has a built-in seated driver (the karts). */
  get hasDriver(): boolean {
    return !!this.driver;
  }

  /** Shows/hides the built-in seated driver (hidden on a parked car, shown while driven). */
  setDriver(visible: boolean): void {
    if (this.driver) this.driver.visible = visible;
  }

  /**
   * @param steer wheel steering angle (rad, + = left)
   * @param speed forward speed (m/s)
   * @param suspension per-wheel world suspension compression offset (m, + = wheel pushed up)
   */
  update(dt: number, steer: number, speed: number, suspension?: number[]): void {
    const r = this.wheels[0]?.radius ?? 0.4;
    this.spin += (speed / r) * dt;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      w.pivot.rotation.y = w.front ? steer : 0;
      w.spinner.rotation.x = this.spin;
      w.pivot.position.y = w.baseY + (suspension?.[i] ?? 0) / CAR_SCALE;
    }
  }

  /** Translucent look (one material per model, reused by later calls; freed by dispose()). The wear no longer shows. */
  setGhost(opacity: number): void {
    this.ghostAll = true;
    const mat = this.ghostMaterial(opacity);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = mat;
        m.castShadow = false;
      }
    });
  }

  private ghostMaterial(opacity: number): THREE.MeshStandardMaterial {
    if (this.ghostMat) this.ghostMat.opacity = opacity;
    else this.ghostMat = new THREE.MeshStandardMaterial({ color: 0xbfd4ff, transparent: true, opacity, depthWrite: false });
    return this.ghostMat;
  }

  /**
   * Car under construction (garage bay): installed parts as they are, the rest see-through. The body is
   * see-through without its chassis, bare metal until every panel is in; the wheels go on front first, left
   * first, missing ones stand on jack stands; an installed engine sits over its axle until the body hides it.
   */
  setBuildLook(look: BuildLook): void {
    this.ghostMaterial(0.3);
    this.build = look;
    this.applyMaterials();
    if (this.spoiler) this.spoiler.visible = look.spoiler;
    this.setDriver(false);

    this.buildExtras.clear();
    this.root.add(this.buildExtras);
    this.geometry.wheels.forEach((w, i) => {
      if (i < look.wheels) return;
      // Under the hub, a little inside the wheel.
      const stand = new THREE.Mesh(standGeometry, standMaterial);
      const h = Math.max(0.05, w.center[1] - w.radius * 0.35);
      stand.scale.set(0.12, h, 0.12);
      stand.position.set(w.center[0] * 0.7, 0, w.center[2]);
      stand.castShadow = true;
      this.buildExtras.add(stand);
    });
    const bp = BLUEPRINTS[this.spec.blueprint];
    const axle = this.geometry.wheels.filter((w) => w.front === (bp.engineMount === 'front'));
    if (look.engine && axle.length) {
      const key = ITEMS.engine.model;
      const engine = this.assets.instantiate(key);
      const { bbox, size } = this.assets.info(key);
      const s = 0.6 / CAR_SCALE / Math.max(size.x, size.y, size.z, 0.01);
      const z = axle.reduce((a, w) => a + w.center[2], 0) / axle.length;
      const y = axle[0]!.center[1] + axle[0]!.radius * 0.2;
      engine.scale.setScalar(s);
      engine.position.set(-(bbox.min.x + bbox.max.x) / 2 * s, y - bbox.min.y * s, z * 0.8 - ((bbox.min.z + bbox.max.z) / 2) * s);
      engine.traverse((o) => ((o as THREE.Mesh).castShadow = true));
      this.buildExtras.add(engine);
    }
  }

  /**
   * Shows a wear look (data/wear.ts wearLookCode: the wheels', the body's and the spoiler's steps), with the shared
   * worn materials: nothing is rebuilt, and nothing at all happens when the code did not change (call it every frame).
   * Kept under a construction look (whose see-through or bare parts win), ignored by a ghost preview.
   */
  setWear(code: number): void {
    if (code === this.wearCode) return;
    this.wearCode = code;
    this.applyMaterials();
  }

  /** Every look group's material: a construction look's override, else its worn step, else its kit material. */
  private applyMaterials(): void {
    if (this.ghostAll) return;
    const look = this.build;
    const ghost = this.ghostMat;
    const code = this.wearCode;
    const body = look ? (look.body === 'ghost' ? ghost : look.body === 'bare' ? bareMaterial : null) : null;
    this.paintGroup(this.paint.body, body, 'body', (code >> 2) & 3);
    this.paintGroup(this.paint.spoiler, null, 'body', (code >> 4) & 3);
    // The driver never wears (hidden under construction, like the rest of the body).
    this.paintGroup(this.paint.driver, body, 'body', 0);
    for (let i = 0; i < this.paint.wheels.length; i++) this.paintGroup(this.paint.wheels[i]!, look && i >= look.wheels ? ghost : null, 'tire', code & 3);
  }

  private paintGroup(list: readonly Paint[], over: THREE.Material | null, kind: WornKind, level: number): void {
    for (const p of list) {
      const mat = over ?? (level > 0 ? wornMaterial(p.base, kind, level as 1 | 2 | 3) : p.base);
      p.mesh.material = mat;
      // Under construction the see-through parts cast no shadow (a parked car keeps the loader's shadows).
      if (this.build) p.mesh.castShadow = mat !== this.ghostMat;
    }
  }

  /** Detaches the model and frees what it owns (shared geometries/materials stay in the asset cache). */
  dispose(): void {
    this.root.removeFromParent();
    this.ghostMat?.dispose();
    this.ghostMat = null;
  }
}

/** Ghost car for a garage draft: add `root` to the scene where the car would stand, dispose() when done. */
export interface CarPreview {
  readonly root: THREE.Group;
  readonly model: CarModel;
  dispose(): void;
}

/**
 * Translucent preview of `spec` (no driver, no shadows), placed like a car pose: root origin = ground under
 * the middle of the axles, facing +Z at rotation 0 (`root.position.set(p.x, p.y, p.z)`, `root.rotation.y = p.yaw`).
 */
export function makeCarPreview(assets: AssetLoader, spec: CarSpec, opacity = 0.42): CarPreview {
  const model = new CarModel(assets, spec);
  model.setDriver(false);
  model.setGhost(opacity);
  return { root: model.root, model, dispose: () => model.dispose() };
}
