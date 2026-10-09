import * as THREE from 'three';
import { readGlb, worldTriangles, nodeBoxes } from '../../scripts/lib/glb.mjs';
import type { AssetLoader } from '../../src/core/assets/AssetLoader';

/*
 * Fake assets for CarModel in Node (GLB node boxes, no textures): enough for the car-kit models a car is built
 * from (bodies, racing wheels, the loose engine of a car under construction).
 */

export const KIT = 'public/assets/kenney/car-kit';
/** The one material of every fake mesh (stands for the kit's shared material). */
export const kitMaterial = new THREE.MeshStandardMaterial();

/**
 * The model's node hierarchy with one box mesh per node that has a mesh, like the GLB as far as CarModel cares: a
 * nested mesh (the Sportive's spoiler, under its body) is a mesh of its own, so the look groups find it (the boxes'
 * union per top-level part, hence the car's layout and colliders, does not change).
 */
function modelScene(name: string): THREE.Group {
  const glb = readGlb(`${KIT}/${name}.glb`);
  const boxes = new Map(nodeBoxes(worldTriangles(glb).tris.map((t) => ({ ...t, node: t.own }))).map((b) => [b.name, b]));
  const nodes = glb.json.nodes as { name: string; children?: number[] }[];
  const build = (i: number): THREE.Object3D => {
    const n = nodes[i]!;
    const b = boxes.get(n.name);
    let o: THREE.Object3D;
    if (b) {
      const size = b.max.map((v, k) => v - b.min[k]!) as [number, number, number];
      const center = b.max.map((v, k) => (v + b.min[k]!) / 2) as [number, number, number];
      o = new THREE.Mesh(new THREE.BoxGeometry(...size).translate(...center), kitMaterial);
    } else o = new THREE.Group();
    o.name = n.name;
    for (const c of n.children ?? []) o.add(build(c));
    return o;
  };
  const scene = new THREE.Group();
  for (const i of glb.json.scenes[glb.json.scene ?? 0].nodes as number[]) scene.add(build(i));
  scene.updateMatrixWorld(true);
  return scene;
}

/** An AssetLoader for car-kit models only (instantiate and info). */
export function fakeAssets(): AssetLoader {
  const scenes = new Map<string, THREE.Group>();
  const scene = (key: string) => {
    let s = scenes.get(key);
    if (!s) scenes.set(key, (s = modelScene(key.split('/')[1]!)));
    return s;
  };
  return {
    instantiate: (key: string) => {
      const o = scene(key).clone(true);
      o.name = key;
      return o;
    },
    info: (key: string) => {
      const bbox = new THREE.Box3().setFromObject(scene(key));
      return { bbox, size: bbox.getSize(new THREE.Vector3()), nodes: new Map() };
    },
  } as unknown as AssetLoader;
}
