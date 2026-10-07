import * as THREE from 'three';
import { mulberry32 } from '../../../core/rng';

/**
 * Tileable value noise (256², period 256): R has features every 32 texels, G every 8. Sampled at
 * world / 64 m, that gives 8 m and 2 m blotches of brightness on the ground.
 */
function noiseTexture(): THREE.DataTexture {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const lattice = (spacing: number, seed: number) => {
    const n = N / spacing;
    const rng = mulberry32(seed);
    const v = Float32Array.from({ length: n * n }, () => rng());
    return (x: number, y: number) => {
      const gx = x / spacing;
      const gy = y / spacing;
      const ix = Math.floor(gx);
      const iy = Math.floor(gy);
      const fx = gx - ix;
      const fy = gy - iy;
      const u = fx * fx * (3 - 2 * fx);
      const w = fy * fy * (3 - 2 * fy);
      const at = (a: number, b: number) => v[((a % n) + n) % n + (((b % n) + n) % n) * n]!;
      const a = at(ix, iy);
      const b = at(ix + 1, iy);
      const c = at(ix, iy + 1);
      const d = at(ix + 1, iy + 1);
      return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
    };
  };
  const big = lattice(32, 11);
  const small = lattice(8, 23);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const k = (x + y * N) * 4;
      data[k] = Math.round(big(x, y) * 255);
      data[k + 1] = Math.round(small(x, y) * 255);
      data[k + 2] = 0;
      data[k + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

let material: THREE.MeshLambertMaterial | null = null;

/** Uniforms of the ground shader (shared by every factory visit). */
export const groundUniforms = {
  uNoise: { value: null as THREE.Texture | null },
};

/**
 * The ground: flat-shaded Lambert (fog, lights and shadows stay three's own) with the terrain's vertex
 * colors, modulated by world-space noise so large slopes do not look painted. Module-level and never
 * disposed: its program survives the trips to the race and back.
 */
export function groundMaterial(): THREE.MeshLambertMaterial {
  if (material) return material;
  groundUniforms.uNoise.value = noiseTexture();
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNoise = groundUniforms.uNoise;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uNoise;\nvarying vec3 vGroundWorld;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec4 groundNoise = texture2D(uNoise, vGroundWorld.xz / 64.0);
        diffuseColor.rgb *= 0.88 + 0.16 * groundNoise.r + 0.08 * groundNoise.g;`,
      );
  };
  m.customProgramCacheKey = () => 'ground-v1';
  material = m;
  return m;
}
