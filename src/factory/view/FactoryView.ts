import * as THREE from 'three';
import type { AssetLoader } from '../../core/assets/AssetLoader';
import { BELT } from '../../data/balance';
import { RESOURCES } from '../../data/factoryMap';
import { FACTORY_CELL, FACTORY_MODEL_SCALE } from '../../config/constants';
import type { FactorySim, ConveyorShape } from '../sim/FactorySim';
import type { Building, ConveyorB } from '../sim/types';
import { mulberry32 } from '../../core/rng';
import { BuildingVisual } from './BuildingVisuals';
import { ItemRenderer } from './ItemRenderer';
import { beltLocal, rotateLocal } from './beltPath';
import type { ModelKey } from '../../core/assets/manifest.gen';

const BELT_TOP = 0.4 * FACTORY_MODEL_SCALE;
const SHAPE_MODELS: Record<ConveyorShape, ModelKey> = {
  straight: 'factory-kit/conveyor-stripe',
  left: 'factory-kit/conveyor-corner',
  right: 'factory-kit/conveyor-corner',
  junction: 'factory-kit/conveyor-junction-t',
};

/** Renders the factory simulation: ground, resource nodes, buildings, conveyors and belt items. */
export class FactoryView {
  readonly root = new THREE.Group();
  private visuals = new Map<number, BuildingVisual>();
  private conveyorMeshes = new Map<ConveyorShape, THREE.InstancedMesh>();
  private conveyorsDirty = true;
  private items: ItemRenderer;
  private unsub: (() => void)[] = [];
  private t = 0;
  private readonly tmp = { x: 0, z: 0, yaw: 0 };
  private readonly tmp2 = { x: 0, z: 0 };
  /** Conveyor ids in instance order per shape (for picking). */
  private conveyorIds = new Map<ConveyorShape, number[]>();

  constructor(private readonly assets: AssetLoader, private readonly sim: FactorySim) {
    this.root.name = 'factory';
    this.items = new ItemRenderer(assets, this.root);
    this.buildGround();
    for (const b of sim.buildings.values()) this.addVisual(b);
    this.unsub.push(
      sim.events.on('placed', (b) => {
        this.addVisual(b);
        this.conveyorsDirty = true;
      }),
      sim.events.on('removed', (b) => {
        this.visuals.get(b.id)?.dispose();
        this.visuals.delete(b.id);
        this.conveyorsDirty = true;
      }),
      sim.events.on('topology', () => (this.conveyorsDirty = true)),
    );
  }

  private buildGround(): void {
    const { width, height } = this.sim;
    // Floor: the kit's floor tile is a flat quad of one solid color, so a single quad
    // stretched over the whole grid looks the same as one tile per cell (16k instances
    // on the 128×128 map cost ~40% of the frame).
    const floorGeo = this.assets.mergedGeometry('factory-kit/floor').clone();
    floorGeo.scale(width * FACTORY_CELL, 1, height * FACTORY_CELL);
    const floor = new THREE.Mesh(floorGeo, this.assets.material('factory-kit'));
    floor.position.set((width * FACTORY_CELL) / 2, 0, (height * FACTORY_CELL) / 2);
    floor.receiveShadow = true;
    floor.name = 'floor';
    this.root.add(floor);

    // Surroundings beyond the buildable area.
    const outside = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshStandardMaterial({ color: 0x4b4f72 }));
    outside.rotation.x = -Math.PI / 2;
    outside.position.set((width * FACTORY_CELL) / 2, -0.05, (height * FACTORY_CELL) / 2);
    outside.receiveShadow = true;
    this.root.add(outside);

    // Grid border.
    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(width * FACTORY_CELL, 0.01, height * FACTORY_CELL)),
      new THREE.LineBasicMaterial({ color: 0xffb347 }),
    );
    border.position.set((width * FACTORY_CELL) / 2, 0.03, (height * FACTORY_CELL) / 2);
    this.root.add(border);

    // Resource nodes: colored patches + rocks.
    const rng = mulberry32(42);
    const m = new THREE.Matrix4();
    const rockGeo = new THREE.IcosahedronGeometry(0.5, 0);
    for (const n of this.sim.nodes) {
      const def = RESOURCES[n.resource];
      const patch = new THREE.Mesh(
        new THREE.PlaneGeometry(n.w * FACTORY_CELL - 0.2, n.h * FACTORY_CELL - 0.2),
        new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.9 }),
      );
      patch.rotation.x = -Math.PI / 2;
      patch.position.set((n.x + n.w / 2) * FACTORY_CELL, 0.02, (n.z + n.h / 2) * FACTORY_CELL);
      patch.receiveShadow = true;
      this.root.add(patch);
      const rockMat = new THREE.MeshStandardMaterial({ color: def.color, flatShading: true, roughness: 0.8 });
      const count = n.w * n.h * 3;
      const rocks = new THREE.InstancedMesh(rockGeo, rockMat, count);
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const s = new THREE.Vector3();
      const p = new THREE.Vector3();
      for (let k = 0; k < count; k++) {
        e.set(rng() * 3, rng() * 3, rng() * 3);
        q.setFromEuler(e);
        const sc = 0.35 + rng() * 0.55;
        s.set(sc, sc * (0.6 + rng() * 0.5), sc);
        p.set((n.x + rng() * n.w) * FACTORY_CELL, sc * 0.2, (n.z + rng() * n.h) * FACTORY_CELL);
        rocks.setMatrixAt(k, m.compose(p, q, s));
      }
      rocks.castShadow = true;
      rocks.receiveShadow = true;
      rocks.name = `node:${n.resource}`;
      this.root.add(rocks);
    }
  }

  private addVisual(b: Building): void {
    if (b.type === 'conveyor') return; // instanced
    const v = new BuildingVisual(this.assets, b);
    this.visuals.set(b.id, v);
    this.root.add(v.root);
  }

  private rebuildConveyors(): void {
    this.conveyorsDirty = false;
    const byShape = new Map<ConveyorShape, ConveyorB[]>();
    for (const b of this.sim.buildings.values()) {
      if (b.type !== 'conveyor') continue;
      const shape = this.sim.conveyorShape(b.id);
      let list = byShape.get(shape);
      if (!list) byShape.set(shape, (list = []));
      list.push(b);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const shape of Object.keys(SHAPE_MODELS) as ConveyorShape[]) {
      const list = byShape.get(shape) ?? [];
      let mesh = this.conveyorMeshes.get(shape);
      if (!mesh || mesh.instanceMatrix.count < list.length) {
        if (mesh) {
          mesh.removeFromParent();
          mesh.dispose();
        }
        const cap = Math.max(32, 2 ** Math.ceil(Math.log2(Math.max(1, list.length))));
        const key = SHAPE_MODELS[shape];
        mesh = new THREE.InstancedMesh(this.assets.mergedGeometry(key), this.assets.material('factory-kit'), cap);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = `conveyors:${shape}`;
        mesh.userData.conveyorShape = shape;
        this.root.add(mesh);
        this.conveyorMeshes.set(shape, mesh);
      }
      const ids: number[] = [];
      list.forEach((c, i) => {
        q.setFromAxisAngle(up, c.rot * (Math.PI / 2) + (shape === 'junction' ? JUNCTION_YAW : 0));
        s.set(shape === 'right' ? -FACTORY_MODEL_SCALE : FACTORY_MODEL_SCALE, FACTORY_MODEL_SCALE, FACTORY_MODEL_SCALE);
        p.set((c.x + 0.5) * FACTORY_CELL, 0, (c.z + 0.5) * FACTORY_CELL);
        mesh!.setMatrixAt(i, m.compose(p, q, s));
        ids.push(c.id);
      });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.conveyorIds.set(shape, ids);
    }
  }

  /** Building id of a raycast hit (conveyor instance or building mesh), if any. */
  buildingIdFromHit(hit: THREE.Intersection): number | null {
    const obj = hit.object as THREE.InstancedMesh;
    const shape = obj.userData?.conveyorShape as ConveyorShape | undefined;
    if (shape && hit.instanceId !== undefined) return this.conveyorIds.get(shape)?.[hit.instanceId] ?? null;
    let o: THREE.Object3D | null = hit.object;
    while (o) {
      if (o.userData?.buildingId) return o.userData.buildingId as number;
      o = o.parent;
    }
    return null;
  }

  visualOf(id: number): BuildingVisual | undefined {
    return this.visuals.get(id);
  }

  update(dt: number, factoryAlpha: number): void {
    this.t += dt;
    if (this.conveyorsDirty) this.rebuildConveyors();
    for (const v of this.visuals.values()) v.update(this.sim, this.t);

    // Belt items, interpolated between the last two sim ticks.
    const items = this.items;
    const tmp = this.tmp;
    const r2 = this.tmp2;
    items.begin();
    for (const b of this.sim.buildings.values()) {
      if (b.type !== 'conveyor') continue;
      const cx = (b.x + 0.5) * FACTORY_CELL;
      const cz = (b.z + 0.5) * FACTORY_CELL;
      for (const it of b.items) {
        const u = (it.prev + (it.pos - it.prev) * factoryAlpha) / BELT.SEG;
        beltLocal(it.from, u, tmp);
        rotateLocal(tmp.x, tmp.z, b.rot, r2);
        items.add(it.item, cx + r2.x * FACTORY_CELL, BELT_TOP, cz + r2.z * FACTORY_CELL, tmp.yaw + b.rot * (Math.PI / 2));
      }
    }
    items.end();
  }

  itemCount(): number {
    return this.items.total();
  }

  dispose(): void {
    for (const u of this.unsub) u();
    for (const v of this.visuals.values()) v.dispose();
    this.items.dispose();
    for (const m of this.conveyorMeshes.values()) m.dispose();
    (this.root.getObjectByName('floor') as THREE.Mesh | undefined)?.geometry.dispose(); // own clone, not the cached tile
    this.root.removeFromParent();
  }
}

/** Extra yaw for the T-junction model so its stem points backward (set after visual check). */
const JUNCTION_YAW = 0;
