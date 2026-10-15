import * as THREE from 'three';
import type { AssetLoader } from '../core/assets/AssetLoader';
import type { HatId } from '../data/character';

/**
 * Hats of the character (data/character.ts), built from simple shapes (the cone is the Factory Kit's).
 * The group's origin is the top of the head; +Z is where the face looks. `accent` tints the cap and the
 * beanie like the feet. The geometries and materials belong to the group: `disposeHat` frees them.
 */
export function buildHat(assets: AssetLoader, id: HatId, accent: number): THREE.Group | null {
  if (id === 'none') return null;
  const g = new THREE.Group();
  g.name = `hat:${id}`;
  const mat = (color: number, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: metal ? 0.35 : 0.75, metalness: metal, flatShading: true });
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, y: number, z = 0) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(0, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  // Half dome sitting on the head (the head is a ~0.55 m wide ball).
  const dome = (r: number) => new THREE.SphereGeometry(r, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2);
  switch (id) {
    case 'cap': {
      const m = mat(accent);
      add(dome(0.36), m, -0.12);
      const visor = add(new THREE.CylinderGeometry(0.26, 0.26, 0.03, 18, 1, false, -Math.PI / 2, Math.PI), m, -0.1, 0.18);
      visor.scale.set(1, 1, 1.15);
      break;
    }
    case 'helmet': {
      const m = mat(0xf2c230);
      add(dome(0.38), m, -0.12);
      add(new THREE.CylinderGeometry(0.47, 0.47, 0.04, 22), m, -0.11);
      add(new THREE.BoxGeometry(0.06, 0.05, 0.62), mat(0xe0ac18), 0.25);
      break;
    }
    case 'beanie': {
      const m = mat(accent);
      add(dome(0.37), m, -0.14).scale.set(1, 1.15, 1);
      add(new THREE.TorusGeometry(0.35, 0.06, 8, 22).rotateX(Math.PI / 2), mat(0xeeeef4), -0.1);
      add(new THREE.SphereGeometry(0.09, 10, 8), mat(0xeeeef4), 0.34);
      break;
    }
    case 'tophat': {
      const black = mat(0x24252e);
      add(new THREE.CylinderGeometry(0.42, 0.42, 0.03, 22), black, -0.06);
      add(new THREE.CylinderGeometry(0.25, 0.27, 0.5, 20), black, 0.2);
      add(new THREE.CylinderGeometry(0.275, 0.275, 0.08, 20), mat(0xc8413d), 0.0);
      break;
    }
    case 'crown': {
      const gold = mat(0xf2c94c, 0.6);
      gold.side = THREE.DoubleSide; // the band is an open ring
      add(new THREE.CylinderGeometry(0.3, 0.3, 0.16, 20, 1, true), gold, 0.0);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const spike = add(new THREE.ConeGeometry(0.06, 0.16, 8), gold, 0.15);
        spike.position.x = Math.sin(a) * 0.28;
        spike.position.z = Math.cos(a) * 0.28;
      }
      add(new THREE.SphereGeometry(0.05, 10, 8), mat(0xd8433f), 0.02, 0.31);
      break;
    }
    case 'cone': {
      // The Factory Kit traffic cone (shared geometry and material: only the group is ours).
      const cone = assets.instantiate('factory-kit/cone');
      const size = assets.info('factory-kit/cone').size;
      cone.scale.setScalar(0.55 / size.y);
      cone.position.y = -0.1;
      cone.userData.shared = true;
      cone.traverse((o) => ((o as THREE.Mesh).castShadow = true));
      g.add(cone);
      break;
    }
  }
  return g;
}

/** Frees what `buildHat` created (not the shared cone model). */
export function disposeHat(hat: THREE.Object3D): void {
  hat.traverse((o) => {
    if (o.userData.shared) return;
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    // The cone's meshes are the kit's: skip anything under a shared node.
    let p: THREE.Object3D | null = m;
    while (p && p !== hat) {
      if (p.userData.shared) return;
      p = p.parent;
    }
    m.geometry.dispose();
    (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
  });
  hat.removeFromParent();
}
