import * as THREE from 'three';
import { FACTORY_CELL } from '../../../config/constants';
import { isCleared, type DecorKind, type DecorLayout } from '../../sim/decor';
import type { FactorySim } from '../../sim/FactorySim';
import { decorGeometry, decorMaterial } from './lowpoly';
import { drawnHeight } from './TerrainMesh';

const KINDS: DecorKind[] = ['pine', 'oak', 'birch', 'rock', 'pebble', 'farPine'];
/** Kinds that cast shadows (the far pines and pebbles do not). */
const SHADOWS = new Set<DecorKind>(['pine', 'oak', 'birch', 'rock']);
/** How far each kind sits into the ground (m per unit of scale): no gap under a trunk or a rock on a slope. */
const SINK: Record<DecorKind, number> = { pine: 0.15, oak: 0.15, birch: 0.15, rock: 0.3, pebble: 0.08, farPine: 0.4 };
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Trees and rocks of the relief map: one instanced mesh per kind. An item whose clear disc a building
 * stands on is hidden (its instance shrunk to nothing), and comes back when the building is dismantled;
 * items follow the ground when pads change it.
 */
export class Decor {
  readonly root = new THREE.Group();
  private readonly meshes = new Map<DecorKind, THREE.InstancedMesh>();
  /** Per item: its instance index in its kind's mesh, and whether it is hidden now. */
  private readonly slot: Int32Array;
  private readonly hidden: Uint8Array;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly sim: FactorySim, private readonly layout: DecorLayout) {
    this.root.name = 'decor';
    const items = layout.items;
    this.slot = new Int32Array(items.length);
    this.hidden = new Uint8Array(items.length);
    const counts = new Map<DecorKind, number>();
    items.forEach((it, i) => {
      const n = counts.get(it.kind) ?? 0;
      this.slot[i] = n;
      counts.set(it.kind, n + 1);
    });
    const color = new THREE.Color();
    for (const kind of KINDS) {
      const n = counts.get(kind) ?? 0;
      if (!n) continue;
      const mesh = new THREE.InstancedMesh(decorGeometry(kind), decorMaterial(), n);
      mesh.name = `decor:${kind}`;
      mesh.castShadow = SHADOWS.has(kind);
      mesh.receiveShadow = kind !== 'farPine';
      this.meshes.set(kind, mesh);
      this.root.add(mesh);
    }
    items.forEach((it, i) => {
      const mesh = this.meshes.get(it.kind)!;
      // A little shade jitter per item.
      const j = 0.88 + ((i * 2654435761) % 1000) / 1000 * 0.24;
      mesh.setColorAt(this.slot[i]!, color.setRGB(j, j, j));
      this.place(i);
    });
    for (const mesh of this.meshes.values()) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** Sets item `i`'s instance: on the ground at its spot, or hidden under a building. */
  private place(i: number): void {
    const it = this.layout.items[i]!;
    const mesh = this.meshes.get(it.kind)!;
    const hide = isCleared(this.layout, i, this.sim.grid);
    this.hidden[i] = hide ? 1 : 0;
    if (hide) {
      mesh.setMatrixAt(this.slot[i]!, ZERO);
      return;
    }
    const t = this.sim.terrain;
    const inLattice = it.x >= -t.margin * FACTORY_CELL && it.z >= -t.margin * FACTORY_CELL && it.x <= (t.width + t.margin) * FACTORY_CELL && it.z <= (t.height + t.margin) * FACTORY_CELL;
    // Past the lattice, on the ground as drawn (the far bands' flat triangles, not the height function).
    const ground = inLattice ? t.heightAt(it.x, it.z) : drawnHeight(t, it.x, it.z);
    this.p.set(it.x, ground - SINK[it.kind] * it.scale, it.z);
    this.q.setFromAxisAngle(this.up, it.yaw);
    this.s.setScalar(it.scale);
    mesh.setMatrixAt(this.slot[i]!, this.m.compose(this.p, this.q, this.s));
  }

  /** Buildings appeared or left on these grid cells: the items there hide or come back. */
  refreshCells(cells: readonly [number, number][]): void {
    const touched = new Set<number>();
    for (const [cx, cz] of cells) for (const i of this.layout.byCell.get(cx + cz * this.sim.width) ?? []) touched.add(i);
    this.update(touched);
  }

  /** The ground changed over [x0, z0, x1, z1] (m): the items there stand on it again. */
  reheight(area: [number, number, number, number]): void {
    const [x0, z0, x1, z1] = area;
    const touched = new Set<number>();
    this.layout.items.forEach((it, i) => {
      if (it.x >= x0 - 1 && it.x <= x1 + 1 && it.z >= z0 - 1 && it.z <= z1 + 1) touched.add(i);
    });
    this.update(touched);
  }

  private update(items: Set<number>): void {
    if (!items.size) return;
    const kinds = new Set<DecorKind>();
    for (const i of items) {
      this.place(i);
      kinds.add(this.layout.items[i]!.kind);
    }
    for (const k of kinds) this.meshes.get(k)!.instanceMatrix.needsUpdate = true;
  }

  /** Items hidden now (tests). */
  hiddenCount(): number {
    let n = 0;
    for (const h of this.hidden) n += h;
    return n;
  }

  dispose(): void {
    // Prototypes and the material are shared and never disposed; only the instance buffers are ours.
    for (const mesh of this.meshes.values()) mesh.dispose();
    this.root.removeFromParent();
  }
}
