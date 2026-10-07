import * as THREE from 'three';
import { FACTORY_CELL } from '../../../config/constants';
import type { Lake } from '../../sim/terrain';

let material: THREE.MeshStandardMaterial | null = null;

/** Shared water material (never disposed: its program survives the trips to the race). */
function waterMaterial(): THREE.MeshStandardMaterial {
  material ??= new THREE.MeshStandardMaterial({ color: 0x3d87a8, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.78, depthWrite: false });
  return material;
}

/**
 * The lake's surface: a flat ellipse at the water level, a little larger than the bowl, so the shore
 * (which rises above the level) cuts it cleanly.
 */
export class Water {
  readonly mesh: THREE.Mesh;

  constructor(lake: Lake) {
    const g = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(g, waterMaterial());
    this.mesh.name = 'lake';
    this.mesh.position.set(lake.x * FACTORY_CELL, lake.level / 100, lake.z * FACTORY_CELL);
    this.mesh.scale.set(lake.rx * FACTORY_CELL * 1.15, 1, lake.rz * FACTORY_CELL * 1.15);
    // First of the transparent things: ghosts and markers in front of the lake blend over it, not under.
    this.mesh.renderOrder = -1;
    this.mesh.receiveShadow = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}
