import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MODELS, kitOf, type KitName, type ModelKey } from './manifest.gen';

export interface ModelInfo {
  /** Bounding box of the whole model in model space. */
  bbox: THREE.Box3;
  size: THREE.Vector3;
  /** Model-space position of every named node. */
  nodes: Map<string, THREE.Vector3>;
}

/**
 * GLTF cache. All Kenney models of a kit share one colormap texture, so every
 * mesh of a kit is assigned the same material instance (never mutate it: use
 * override materials for ghosts/highlights).
 */
export class AssetLoader {
  private loader = new GLTFLoader();
  private gltfs = new Map<ModelKey, GLTF>();
  private pending = new Map<ModelKey, Promise<GLTF>>();
  private kitMaterials = new Map<KitName, THREE.Material>();
  private merged = new Map<ModelKey, THREE.BufferGeometry>();
  private infos = new Map<ModelKey, ModelInfo>();

  url(key: ModelKey): string {
    return import.meta.env.BASE_URL + MODELS[key];
  }

  allKeys(): ModelKey[] {
    return Object.keys(MODELS) as ModelKey[];
  }

  isLoaded(key: ModelKey): boolean {
    return this.gltfs.has(key);
  }

  load(key: ModelKey): Promise<GLTF> {
    const cached = this.gltfs.get(key);
    if (cached) return Promise.resolve(cached);
    let p = this.pending.get(key);
    if (!p) {
      p = this.loader.loadAsync(this.url(key)).then((gltf) => {
        this.prepare(key, gltf);
        this.gltfs.set(key, gltf);
        this.pending.delete(key);
        return gltf;
      });
      this.pending.set(key, p);
    }
    return p;
  }

  async loadMany(keys: readonly ModelKey[], onProgress?: (done: number, total: number) => void): Promise<void> {
    let done = 0;
    const total = keys.length;
    // Limit concurrency to keep the browser responsive.
    const queue = [...keys];
    const worker = async () => {
      while (queue.length) {
        const key = queue.shift()!;
        await this.load(key);
        done++;
        onProgress?.(done, total);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  private prepare(key: ModelKey, gltf: GLTF): void {
    const kit = kitOf(key);
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const shared = this.kitMaterials.get(kit);
      if (shared) {
        mesh.material = shared;
      } else {
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (mat.map) mat.map.anisotropy = 4;
        this.kitMaterials.set(kit, mat);
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
    gltf.scene.updateMatrixWorld(true);
  }

  private get(key: ModelKey): GLTF {
    const g = this.gltfs.get(key);
    if (!g) throw new Error(`Model not loaded: ${key}`);
    return g;
  }

  material(kit: KitName): THREE.Material {
    const m = this.kitMaterials.get(kit);
    if (!m) throw new Error(`No material yet for kit ${kit}`);
    return m;
  }

  /** Deep clone sharing geometry/material with the cache. */
  instantiate(key: ModelKey): THREE.Object3D {
    const obj = this.get(key).scene.clone(true);
    obj.name = key;
    return obj;
  }

  /** All meshes of the model baked into one geometry (model space). Cached; never dispose. */
  mergedGeometry(key: ModelKey, opts: { exclude?: (name: string) => boolean } = {}): THREE.BufferGeometry {
    const cacheable = !opts.exclude;
    if (cacheable) {
      const c = this.merged.get(key);
      if (c) return c;
    }
    const root = this.get(key).scene;
    root.updateMatrixWorld(true);
    const parts: THREE.BufferGeometry[] = [];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (opts.exclude && this.hasExcludedAncestor(mesh, root, opts.exclude)) return;
      const g = mesh.geometry.clone();
      for (const name of Object.keys(g.attributes)) {
        if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
      }
      if (!g.index) g.setIndex([...Array(g.attributes.position!.count).keys()]);
      g.applyMatrix4(mesh.matrixWorld);
      parts.push(g);
    });
    const merged = parts.length === 1 ? parts[0]! : mergeGeometries(parts, false);
    if (!merged) throw new Error(`Cannot merge ${key}`);
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    if (cacheable) this.merged.set(key, merged);
    return merged;
  }

  private hasExcludedAncestor(o: THREE.Object3D, root: THREE.Object3D, exclude: (name: string) => boolean): boolean {
    let cur: THREE.Object3D | null = o;
    while (cur && cur !== root) {
      if (exclude(cur.name)) return true;
      cur = cur.parent;
    }
    return false;
  }

  info(key: ModelKey): ModelInfo {
    const c = this.infos.get(key);
    if (c) return c;
    const root = this.get(key).scene;
    root.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(root);
    const nodes = new Map<string, THREE.Vector3>();
    root.traverse((o) => {
      if (o !== root && o.name) nodes.set(o.name, new THREE.Vector3().setFromMatrixPosition(o.matrixWorld));
    });
    const info = { bbox, size: bbox.getSize(new THREE.Vector3()), nodes };
    this.infos.set(key, info);
    return info;
  }
}
