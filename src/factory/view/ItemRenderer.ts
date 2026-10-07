import * as THREE from 'three';
import type { AssetLoader } from '../../core/assets/AssetLoader';
import { kitOf } from '../../core/assets/manifest.gen';
import { ITEMS, ITEM_IDS, type ItemId } from '../../data/items';

/** One growable InstancedMesh per item type. Call begin(), add() many times, then end(). */
export class ItemRenderer {
  private meshes = new Map<ItemId, THREE.InstancedMesh>();
  private counts = new Map<ItemId, number>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly qYaw = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly color = new THREE.Color();

  constructor(private readonly assets: AssetLoader, private readonly parent: THREE.Object3D) {}

  private ensure(item: ItemId, needed: number): THREE.InstancedMesh {
    let mesh = this.meshes.get(item);
    if (mesh && mesh.instanceMatrix.count >= needed) return mesh;
    const cap = Math.max(64, 2 ** Math.ceil(Math.log2(needed)));
    const def = ITEMS[item];
    const next = new THREE.InstancedMesh(this.assets.mergedGeometry(def.model), this.assets.material(kitOf(def.model)), cap);
    next.castShadow = true;
    next.receiveShadow = false;
    next.frustumCulled = false;
    next.count = 0;
    next.name = `items:${item}`;
    if (def.tint !== undefined) {
      this.color.setHex(def.tint);
      for (let i = 0; i < cap; i++) next.setColorAt(i, this.color);
    }
    if (mesh) {
      // copy existing matrices, then drop the old mesh (geometry/material are shared: don't dispose)
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, this.m);
        next.setMatrixAt(i, this.m);
      }
      mesh.removeFromParent();
      mesh.dispose();
    }
    this.parent.add(next);
    this.meshes.set(item, next);
    return next;
  }

  begin(): void {
    for (const id of ITEM_IDS) this.counts.set(id, 0);
  }

  /** @param pitch tilt along the heading (a belt going up or down a slope: up is negative). */
  add(item: ItemId, x: number, y: number, z: number, yaw: number, pitch = 0): void {
    const n = this.counts.get(item) ?? 0;
    const mesh = this.ensure(item, n + 1);
    const def = ITEMS[item];
    if (pitch === 0) {
      this.e.set(0, yaw + (def.beltYaw ?? 0), 0);
      this.q.setFromEuler(this.e);
    } else {
      // Heading, then the slope's pitch, then the model's own yaw on belts (items tilt, they do not shear).
      this.e.set(pitch, yaw, 0);
      this.q.setFromEuler(this.e).multiply(this.qYaw.setFromAxisAngle(this.up, def.beltYaw ?? 0));
    }
    this.s.setScalar(def.beltScale);
    this.p.set(x, y + (def.beltLift ?? 0), z);
    this.m.compose(this.p, this.q, this.s);
    mesh.setMatrixAt(n, this.m);
    this.counts.set(item, n + 1);
  }

  end(): void {
    for (const [item, mesh] of this.meshes) {
      mesh.count = this.counts.get(item) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  total(): number {
    let n = 0;
    for (const c of this.counts.values()) n += c;
    return n;
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    this.meshes.clear();
  }
}
