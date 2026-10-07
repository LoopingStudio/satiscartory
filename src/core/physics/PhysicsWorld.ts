import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

let initPromise: Promise<void> | null = null;
/** Rapier must be initialized exactly once before any object is created. */
export function initRapier(): Promise<void> {
  initPromise ??= RAPIER.init();
  return initPromise;
}

/** Thin wrapper over a Rapier world with an optional debug-line renderer. */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  private debugLines: THREE.LineSegments | null = null;
  private freed = false;

  constructor(gravityY: number) {
    this.world = new RAPIER.World({ x: 0, y: gravityY, z: 0 });
  }

  step(dt: number): void {
    this.world.timestep = dt;
    this.world.step();
  }

  /** Static trimesh collider from a geometry (optionally transformed). */
  addTrimesh(geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4, flags = RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES): RAPIER.Collider {
    const { vertices, indices } = trimeshData(geometry, matrix);
    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices, flags);
    return this.world.createCollider(desc);
  }

  /**
   * Static heightfield of nrows × ncols cells over `size` (x, z), centered on `center`. Heights are
   * column-major: heights[iz + ix·(nrows + 1)], rows along z. No FIX_INTERNAL_EDGES by default: with it, the
   * character controller leaves the ground walking downhill along a grid line (measured).
   */
  addHeightfield(nrows: number, ncols: number, heights: Float32Array, size: { x: number; z: number }, center: { x: number; y: number; z: number }, flags = 0): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.heightfield(nrows, ncols, heights, { x: size.x, y: 1, z: size.z }, flags).setTranslation(center.x, center.y, center.z);
    return this.world.createCollider(desc);
  }

  setDebug(scene: THREE.Scene, enabled: boolean): void {
    if (enabled && !this.debugLines) {
      this.debugLines = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.6 }),
      );
      this.debugLines.renderOrder = 999;
      this.debugLines.frustumCulled = false;
      scene.add(this.debugLines);
    } else if (!enabled && this.debugLines) {
      scene.remove(this.debugLines);
      this.debugLines.geometry.dispose();
      (this.debugLines.material as THREE.Material).dispose();
      this.debugLines = null;
    }
  }

  get debugEnabled(): boolean {
    return !!this.debugLines;
  }

  /** True once dispose() freed the WASM world: no Rapier object of it may be touched any more. */
  get disposed(): boolean {
    return this.freed;
  }

  updateDebug(): void {
    if (!this.debugLines) return;
    const { vertices, colors } = this.world.debugRender();
    const g = this.debugLines.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  }

  dispose(): void {
    if (this.freed) return;
    this.freed = true;
    if (this.debugLines) {
      this.debugLines.removeFromParent();
      this.debugLines.geometry.dispose();
      (this.debugLines.material as THREE.Material).dispose();
      this.debugLines = null;
    }
    this.world.free();
  }
}

export function trimeshData(geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4): { vertices: Float32Array; indices: Uint32Array } {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const vertices = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (matrix) v.applyMatrix4(matrix);
    vertices[i * 3] = v.x;
    vertices[i * 3 + 1] = v.y;
    vertices[i * 3 + 2] = v.z;
  }
  const indices = geometry.index ? Uint32Array.from(geometry.index.array as ArrayLike<number>) : Uint32Array.from({ length: pos.count }, (_, i) => i);
  return { vertices, indices };
}

export { RAPIER };
