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

/**
 * Uniforms of the ground shader (shared by every factory visit; the per-map ones are set by the
 * factory view on the relief map).
 */
export const groundUniforms = {
  uNoise: { value: null as THREE.Texture | null },
  /** Per-cell data (TerrainTextures.cells) and its size; lattice margin and grid size, in cells. */
  uCells: { value: null as THREE.Texture | null },
  uCellsSize: { value: new THREE.Vector2(1, 1) },
  uMargin: { value: 0 },
  uGridCells: { value: new THREE.Vector2(0, 0) },
  /** Build grid: center (x, z), radius (m), opacity (0 hides it). */
  uGrid: { value: new THREE.Vector4(0, 0, 12, 0) },
  uConcrete: { value: new THREE.Color(0x8f8f9a) },
  uDirt: { value: new THREE.Color(0x7a6a55) },
  uIron: { value: new THREE.Color(0xb5653e) },
  uRubber: { value: new THREE.Color(0x34364a) },
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
    Object.assign(shader.uniforms, groundUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorld;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uNoise;
        uniform sampler2D uCells;
        uniform vec2 uCellsSize;
        uniform float uMargin;
        uniform vec2 uGridCells;
        uniform vec4 uGrid;
        uniform vec3 uConcrete;
        uniform vec3 uDirt;
        uniform vec3 uIron;
        uniform vec3 uRubber;
        varying vec3 vGroundWorld;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec4 groundNoise = texture2D(uNoise, vGroundWorld.xz / 64.0);
        diffuseColor.rgb *= 0.88 + 0.16 * groundNoise.r + 0.08 * groundNoise.g;
        // Derivatives out of any branch (undefined in non-uniform control flow).
        vec2 gridP = vGroundWorld.xz / 2.0;
        vec2 gridFw = fwidth(gridP);
        vec2 gridCell = floor(vGroundWorld.xz / 2.0);
        vec2 latticeCell = gridCell + uMargin;
        if (latticeCell.x >= 0.0 && latticeCell.y >= 0.0 && latticeCell.x < uCellsSize.x && latticeCell.y < uCellsSize.y) {
          vec4 cell = texelFetch(uCells, ivec2(latticeCell), 0);
          float node = cell.a * 255.0;
          if (node > 0.5) {
            // Resource node: its color, speckled with rocks.
            vec3 nc = node < 1.5 ? uIron : uRubber;
            diffuseColor.rgb = mix(nc, nc * 0.62, step(0.62, groundNoise.g));
          }
          float surface = cell.g * 255.0;
          if (surface > 254.5) {
            // Pad: concrete with darker joints along the cell edges.
            vec2 f = fract(vGroundWorld.xz / 2.0);
            float joint = step(0.035, min(min(f.x, f.y), min(1.0 - f.x, 1.0 - f.y)));
            diffuseColor.rgb = uConcrete * mix(0.72, 1.0, joint) * (0.94 + 0.12 * groundNoise.g);
          } else if (surface > 0.5) {
            // Banks: dug or filled earth.
            diffuseColor.rgb = mix(diffuseColor.rgb, uDirt * (0.9 + 0.2 * groundNoise.g), min(1.0, surface / 40.0));
          }
          if (uGrid.w > 0.001 && gridCell.x >= 0.0 && gridCell.y >= 0.0 && gridCell.x < uGridCells.x && gridCell.y < uGridCells.y) {
            // Build grid around the aim: cell edges, and cells no belt fits on tinted red.
            float fade = (1.0 - smoothstep(uGrid.z * 0.6, uGrid.z, distance(vGroundWorld.xz, uGrid.xy))) * uGrid.w;
            vec2 w = abs(fract(gridP - 0.5) - 0.5) / gridFw;
            float line = 1.0 - min(min(w.x, w.y), 1.0);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), line * 0.5 * fade);
            if (cell.b > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.18, 0.12), 0.32 * fade);
          }
        }`,
      );
  };
  m.customProgramCacheKey = () => 'ground-v3';
  material = m;
  return m;
}
