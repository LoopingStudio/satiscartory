import * as THREE from 'three';
import type { AssetLoader } from '../core/assets/AssetLoader';
import { CAR_SCALE } from '../config/constants';
import { BLUEPRINTS } from '../data/blueprints';
import type { ItemId } from '../data/items';
import { carGeometryFromBoxes, type CarGeometry, type NodeBox } from './geometry';
import type { CarSpec } from './stats';

/** Per-node bounding boxes of a loaded car model (model space). */
export function carGeometryOf(assets: AssetLoader, model: Parameters<AssetLoader['instantiate']>[0]): CarGeometry {
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
  return carGeometryFromBoxes(boxes);
}

interface WheelRig {
  pivot: THREE.Group;
  spinner: THREE.Group;
  baseY: number;
  front: boolean;
  radius: number;
}

/** Visual car built from a blueprint + installed parts, with animated wheels. */
export class CarModel {
  readonly root = new THREE.Group();
  readonly geometry: CarGeometry;
  private wheels: WheelRig[] = [];
  private spin = 0;

  constructor(assets: AssetLoader, spec: CarSpec) {
    const bp = BLUEPRINTS[spec.blueprint];
    this.geometry = carGeometryOf(assets, bp.model);
    const body = assets.instantiate(bp.model);
    this.root.add(body);
    this.root.scale.setScalar(CAR_SCALE);
    body.updateMatrixWorld(true);

    const wheelItem: ItemId | undefined = spec.parts.wheels;
    const racing = wheelItem === 'wheel_racing';
    // Hide/show optional body parts.
    const spoiler = body.getObjectByName('spoiler');
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
  }

  /**
   * @param steer wheel steering angle (rad, + = left)
   * @param speed forward speed (m/s)
   * @param suspension per-wheel world suspension compression offset (m, + = wheel pushed up)
   */
  update(dt: number, steer: number, speed: number, suspension?: number[]): void {
    const r = this.wheels[0]?.radius ?? 0.4;
    this.spin += (speed / r) * dt;
    this.wheels.forEach((w, i) => {
      w.pivot.rotation.y = w.front ? steer : 0;
      w.spinner.rotation.x = this.spin;
      w.pivot.position.y = w.baseY + (suspension?.[i] ?? 0) / CAR_SCALE;
    });
  }

  setGhost(opacity: number): void {
    const mat = new THREE.MeshStandardMaterial({ color: 0xbfd4ff, transparent: true, opacity, depthWrite: false });
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = mat;
        m.castShadow = false;
      }
    });
  }
}
