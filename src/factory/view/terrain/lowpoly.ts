import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../../../core/rng';
import type { DecorKind } from '../../sim/decor';

/** A part of a prototype in one flat color. */
function part(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  geo.deleteAttribute('uv');
  const c = new THREE.Color(color);
  const n = geo.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** An icosahedron with its corners pushed in and out a little (rocks, canopies). */
function lumpy(radius: number, detail: number, seed: number, squash = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(radius, detail);
  const rng = mulberry32(seed);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  // Same corner, same push (the geometry repeats corners per face).
  const pushes = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let k = pushes.get(key);
    if (k === undefined) pushes.set(key, (k = 0.78 + rng() * 0.38));
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * squash, pos.getZ(i) * k);
  }
  return g;
}

const BARK = 0x6b4a2f;

/** Low-poly prototypes (origin at the foot, 1 = a typical size), merged with their vertex colors. */
function build(kind: DecorKind): THREE.BufferGeometry {
  switch (kind) {
    case 'pine':
      return mergeGeometries([
        part(new THREE.CylinderGeometry(0.14, 0.2, 1.3, 6).translate(0, 0.65, 0), BARK),
        part(new THREE.ConeGeometry(1.45, 2.3, 7).translate(0, 2.0, 0), 0x2f5d34),
        part(new THREE.ConeGeometry(1.15, 2.0, 7).translate(0, 3.1, 0), 0x356a3a),
        part(new THREE.ConeGeometry(0.8, 1.7, 7).translate(0, 4.15, 0), 0x3d7642),
      ])!;
    case 'oak':
      return mergeGeometries([
        part(new THREE.CylinderGeometry(0.18, 0.28, 2.0, 6).translate(0, 1.0, 0), BARK),
        part(lumpy(1.7, 0, 3, 0.85).translate(0, 3.1, 0), 0x4f8a3a),
        part(lumpy(1.1, 0, 4, 0.85).translate(0.9, 2.6, 0.5), 0x5a9440),
        part(lumpy(1.0, 0, 5, 0.85).translate(-0.8, 2.8, -0.6), 0x467e35),
      ])!;
    case 'birch':
      return mergeGeometries([
        part(new THREE.CylinderGeometry(0.09, 0.13, 2.6, 6).translate(0, 1.3, 0), 0xe6e2d6),
        part(lumpy(1.0, 0, 6, 1.25).translate(0, 3.2, 0), 0x86b14d),
        part(lumpy(0.7, 0, 7, 1.2).translate(0.35, 4.1, 0.1), 0x93bd55),
      ])!;
    case 'rock':
      return part(lumpy(1, 0, 8, 0.7).translate(0, 0.25, 0), 0x8a8794);
    case 'pebble':
      return part(lumpy(0.5, 0, 9, 0.6).translate(0, 0.1, 0), 0x9a97a2);
    case 'farPine':
      return mergeGeometries([
        part(new THREE.CylinderGeometry(0.2, 0.25, 1, 5).translate(0, 0.5, 0), BARK),
        part(new THREE.ConeGeometry(1.6, 5.2, 6).translate(0, 3.4, 0), 0x2b5531),
      ])!;
  }
}

const cache = new Map<DecorKind, THREE.BufferGeometry>();

/** Prototype geometry of a kind (cached, never disposed). */
export function decorGeometry(kind: DecorKind): THREE.BufferGeometry {
  let g = cache.get(kind);
  if (!g) cache.set(kind, (g = build(kind)));
  return g;
}

let material: THREE.MeshLambertMaterial | null = null;

/**
 * Flat-shaded, vertex-colored, a little color jitter per instance (shared, never disposed). Close to the
 * camera (which looks through trees) the decor dissolves in a screen-door pattern instead of hiding the
 * player.
 */
export function decorMaterial(): THREE.MeshLambertMaterial {
  if (material) return material;
  material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
      float decorNear = length(vViewPosition);
      if (decorNear < 4.0) {
        float decorDither = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
        if (decorDither > (decorNear - 1.5) / 2.5) discard;
      }`,
    );
  };
  material.customProgramCacheKey = () => 'decor-v1';
  return material;
}
