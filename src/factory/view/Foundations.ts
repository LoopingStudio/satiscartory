import * as THREE from 'three';
import { BUILDINGS, isBelt } from '../../data/buildings';
import { FACTORY_CELL } from '../../config/constants';
import { rotatedSize } from '../sim/dirs';
import { deckY, type DeckPlane } from '../sim/terrain';
import type { FactorySim } from '../sim/FactorySim';
import { deckShear, shearNormals } from './terrain/deck';

/** Lavender of the kit's old floor (the pads' foundations) and the dark under the belts. */
const PLINTH = new THREE.Color(0x61618a);
const SKIRT = new THREE.Color(0x3b3b52);
const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, -0.5, 0); // top at y = 0
const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
shearNormals(material, 'foundations-v1');

/**
 * On the relief: a lavender foundation slab under each machine, drill and garage (its top 2 cm over the
 * pad, its sides down into the ground: they show where a pad stands above a lower neighbor), and a dark
 * skirt under each belt piece whose deck leaves a gap over the ground (level across a cross slope).
 * One instanced mesh, rebuilt when buildings or the ground change.
 */
export class Foundations {
  mesh: THREE.InstancedMesh;
  private readonly sh = new THREE.Matrix4();
  private readonly deck: DeckPlane = { c: 0, sx: 0, sz: 0 };

  constructor(private readonly sim: FactorySim) {
    this.mesh = new THREE.InstancedMesh(unitBox, material, 64);
    this.mesh.name = 'foundations';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  rebuild(): void {
    const t = this.sim.terrain;
    const list: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    for (const b of this.sim.buildings.values()) {
      if (b.type === 'hub') continue;
      const [w, h] = BUILDINGS[b.type].footprint;
      const [rw, rh] = rotatedSize(w, h, b.rot);
      let low = Infinity;
      for (let i = b.x; i <= b.x + rw; i++) for (const j of [b.z, b.z + rh]) low = Math.min(low, t.effAt(i, j));
      for (let j = b.z; j <= b.z + rh; j++) for (const i of [b.x, b.x + rw]) low = Math.min(low, t.effAt(i, j));
      low = low / 100;
      if (isBelt(b.type)) {
        // Skirt down to the lowest corner, only when the deck leaves a gap somewhere.
        const deck = this.sim.deckOf(b, this.deck);
        let gap = 0;
        for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          gap = Math.max(gap, deckY(deck, b.x, b.z, (b.x + i) * FACTORY_CELL, (b.z + j) * FACTORY_CELL) - t.effAt(b.x + i, b.z + j) / 100);
        }
        if (gap < 0.03) continue;
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3((b.x + 0.5) * FACTORY_CELL, 0, (b.z + 0.5) * FACTORY_CELL),
          new THREE.Quaternion(),
          new THREE.Vector3(FACTORY_CELL - 0.16, gap + 0.1, FACTORY_CELL - 0.16),
        );
        list.push({ m: deckShear(deck, b.x, b.z, this.sh).clone().multiply(m), c: SKIRT });
      } else {
        const top = (b.py ?? 0) / 100 + (b.type === 'garage' ? -0.01 : 0.02);
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3((b.x + rw / 2) * FACTORY_CELL, top, (b.z + rh / 2) * FACTORY_CELL),
          new THREE.Quaternion(),
          new THREE.Vector3(rw * FACTORY_CELL, Math.max(0.05, top - low + 0.3), rh * FACTORY_CELL),
        );
        list.push({ m, c: PLINTH });
      }
    }
    if (this.mesh.instanceMatrix.count < list.length) {
      const parent = this.mesh.parent;
      const bigger = new THREE.InstancedMesh(unitBox, material, 2 ** Math.ceil(Math.log2(list.length)));
      bigger.name = this.mesh.name;
      bigger.castShadow = bigger.receiveShadow = true;
      bigger.frustumCulled = false;
      this.mesh.removeFromParent();
      this.mesh.dispose();
      parent?.add(bigger);
      this.mesh = bigger;
    }
    list.forEach((o, i) => {
      this.mesh.setMatrixAt(i, o.m);
      this.mesh.setColorAt(i, o.c);
    });
    this.mesh.count = list.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
