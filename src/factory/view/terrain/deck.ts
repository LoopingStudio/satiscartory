import * as THREE from 'three';
import { FACTORY_CELL } from '../../../config/constants';
import type { DeckPlane } from '../../sim/terrain';

/**
 * World-space shear that lifts y = 0 onto a belt deck: y' = y + c + sx·(x − X0) + sz·(z − Z0) around the
 * center (X0, Z0) of cell (cx, cz). Premultiplied to a tile's transform, it lays the tile on the slope
 * while its legs and ends stay vertical.
 */
export function deckShear(p: DeckPlane, cx: number, cz: number, out: THREE.Matrix4): THREE.Matrix4 {
  const x0 = (cx + 0.5) * FACTORY_CELL;
  const z0 = (cz + 0.5) * FACTORY_CELL;
  return out.set(1, 0, 0, 0, p.sx, 1, p.sz, p.c - p.sx * x0 - p.sz * z0, 0, 0, 1, 0, 0, 0, 0, 1);
}

/** three's normal chunk with a true normal matrix for instances (it assumes no shear in instanceMatrix). */
const SHEAR_NORMALS = THREE.ShaderChunk.defaultnormal_vertex.replace(
  /mat3 im = mat3\( instanceMatrix \);[\s\S]*?transformedNormal = im \* transformedNormal;/,
  'mat3 im = mat3( instanceMatrix );\n\ttransformedNormal = transpose( inverse( im ) ) * transformedNormal;',
);

/** Makes a material light sheared instances correctly (belt tiles laid on a slope). */
export function shearNormals(m: THREE.Material, key: string): void {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <defaultnormal_vertex>', SHEAR_NORMALS);
  };
  m.customProgramCacheKey = () => key;
}

const sheared = new WeakMap<THREE.Material, THREE.Material>();

/** A clone of a shared material (never mutated itself) that lights sheared instances right; cached, never disposed. */
export function shearSafe(m: THREE.Material): THREE.Material {
  let c = sheared.get(m);
  if (!c) {
    c = m.clone();
    shearNormals(c, `shear-${m.uuid}`);
    sheared.set(m, c);
  }
  return c;
}

/** Pitch (rad, for ItemRenderer) of something heading `yaw` on a deck: up the slope is negative. */
export function deckPitch(p: DeckPlane, yaw: number): number {
  return -Math.atan(p.sx * Math.sin(yaw) + p.sz * Math.cos(yaw));
}
