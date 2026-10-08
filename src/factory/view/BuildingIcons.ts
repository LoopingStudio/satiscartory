import * as THREE from 'three';
import type { AssetLoader } from '../../core/assets/AssetLoader';
import type { BuildingType } from '../../data/buildings';
import { buildModel } from './BuildingVisuals';

/** Thumbnails already rendered (kept for the whole session: building models never change). */
const cache = new Map<BuildingType, string>();

/**
 * PNG thumbnails of buildings for the build menu, rendered once from their 3D models with a
 * dedicated tiny renderer (like ItemIcons). Missing entries (no WebGL) fall back to text in the UI.
 */
export function buildingIcons(assets: AssetLoader, types: readonly BuildingType[], size = 192): ReadonlyMap<BuildingType, string> {
  const missing = types.filter((t) => !cache.has(t));
  if (!missing.length) return cache;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return cache;
  }
  renderer.setSize(size, size, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x50557a, 2.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 200);
  for (const type of missing) {
    // Showcase: the dealer with a car on show.
    const model = buildModel(assets, type, { showcase: true });
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2 || 1;
    model.position.sub(center);
    // 3/4 view from above, like a catalogue picture.
    const pivot = new THREE.Group();
    pivot.add(model);
    pivot.rotation.set(0.45, -0.75, 0);
    scene.add(pivot);
    const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 0.95;
    camera.position.set(0, radius * 0.15, dist);
    camera.lookAt(0, 0, 0);
    renderer.setClearColor(0x000000, 0);
    renderer.render(scene, camera);
    cache.set(type, canvas.toDataURL('image/png'));
    // Models share the kit materials: only detach (never dispose them).
    scene.remove(pivot);
  }
  renderer.dispose();
  renderer.forceContextLoss();
  return cache;
}
