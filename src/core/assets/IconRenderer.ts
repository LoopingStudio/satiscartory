import * as THREE from 'three';
import type { AssetLoader } from './AssetLoader';
import { ITEMS, ITEM_IDS, type ItemId } from '../../data/items';

/**
 * Renders a small PNG icon of every item from its 3D model (once, at boot) with
 * a dedicated tiny renderer. Icons are used by inventory/machine UIs.
 */
export class ItemIcons {
  private urls = new Map<ItemId, string>();

  constructor(assets: AssetLoader, size = 96) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    } catch {
      return; // no icons: UIs fall back to text
    }
    renderer.setSize(size, size, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x50557a, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(2, 4, 3);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
    for (const id of ITEM_IDS) {
      const def = ITEMS[id];
      const obj = assets.instantiate(def.model);
      if (def.tint !== undefined) {
        const mat = new THREE.MeshStandardMaterial({ color: def.tint, roughness: 0.8 });
        obj.traverse((o) => ((o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).material = mat) : undefined));
      }
      const box = new THREE.Box3().setFromObject(obj);
      const center = box.getCenter(new THREE.Vector3());
      const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
      obj.position.sub(center);
      const pivot = new THREE.Group();
      pivot.add(obj);
      pivot.rotation.set(0.35, -0.7, 0);
      scene.add(pivot);
      const dist = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.05;
      camera.position.set(0, radius * 0.25, dist);
      camera.lookAt(0, 0, 0);
      renderer.setClearColor(0x000000, 0);
      renderer.render(scene, camera);
      this.urls.set(id, canvas.toDataURL('image/png'));
      scene.remove(pivot);
    }
    renderer.dispose();
    renderer.forceContextLoss();
  }

  url(item: ItemId): string | null {
    return this.urls.get(item) ?? null;
  }
}
