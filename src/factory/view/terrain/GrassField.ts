import * as THREE from 'three';
import { mulberry32 } from '../../../core/rng';

import type { GrassQuality } from '../../../data/factoryTerrain';

/**
 * Per quality: side of the tile the tufts wrap around the camera (m), tufts and flower patches in it.
 * Quality changes only how many instances are drawn (allocated once for 'high').
 */
const LEVELS: Record<Exclude<GrassQuality, 'off'>, { tile: number; tufts: number; flowers: number }> = {
  low: { tile: 36, tufts: 1100, flowers: 160 },
  medium: { tile: 48, tufts: 2400, flowers: 320 },
  high: { tile: 64, tufts: 5200, flowers: 640 },
};
const CAP_TUFTS = LEVELS.high.tufts;
const CAP_FLOWERS = LEVELS.high.flowers;
/** Up to this many things push the blades aside (the player, the driven car, the nearest parked cars). */
export const GRASS_PUSHERS = 8;

/** Uniforms of the grass and flower shaders (module-level, like their materials; the view sets them). */
export const grassUniforms = {
  uTime: { value: 0 },
  uCam: { value: new THREE.Vector2() },
  uTile: { value: LEVELS.medium.tile },
  uHeights: { value: null as THREE.Texture | null },
  uCells: { value: null as THREE.Texture | null },
  /** Lattice margin (cells), last corner index along x and z. */
  uLattice: { value: new THREE.Vector3() },
  uWater: { value: -1e9 },
  /** Build tool around (x, z), radius, amount 0..1: blades shortened so ghosts and the grid read. */
  uFlatten: { value: new THREE.Vector4() },
  uPush: { value: Array.from({ length: GRASS_PUSHERS }, () => new THREE.Vector3()) },
  uWind: { value: new THREE.Vector2(0.8, 0.6) },
};

/** Shared GLSL: placement of an instance around the camera, the ground under it, its masks and its bend. */
const PLACE = /* glsl */ `
  attribute vec4 aTuft;
  attribute vec2 aBlade;
  uniform float uTime;
  uniform vec2 uCam;
  uniform float uTile;
  uniform sampler2D uHeights;
  uniform sampler2D uCells;
  uniform vec3 uLattice;
  uniform float uWater;
  uniform vec4 uFlatten;
  uniform vec3 uPush[${GRASS_PUSHERS}];
  uniform vec2 uWind;
  float grassCorner(ivec2 c) {
    return texelFetch(uHeights, clamp(c, ivec2(0), ivec2(int(uLattice.y), int(uLattice.z))), 0).r;
  }
  // Ground height and normal at p on the lattice triangles (the split of the physics and the mesh).
  float grassGround(vec2 p, out vec3 n) {
    vec2 f = p / 2.0 + uLattice.x;
    vec2 i = floor(f);
    vec2 uv = f - i;
    ivec2 c = ivec2(i);
    float h00 = grassCorner(c);
    float h10 = grassCorner(c + ivec2(1, 0));
    float h01 = grassCorner(c + ivec2(0, 1));
    float h11 = grassCorner(c + ivec2(1, 1));
    float h;
    vec2 g;
    if (uv.x + uv.y <= 1.0) {
      h = h00 + uv.x * (h10 - h00) + uv.y * (h01 - h00);
      g = vec2(h10 - h00, h01 - h00) / 2.0;
    } else {
      h = h11 + (1.0 - uv.x) * (h01 - h11) + (1.0 - uv.y) * (h10 - h11);
      g = vec2(h11 - h01, h11 - h10) / 2.0;
    }
    n = normalize(vec3(-g.x, 1.0, -g.y));
    return h;
  }
`;

/** Placement code, run at the start of main (the normal chunk comes first). Sets grassPos, grassNormal. */
const MAIN = /* glsl */ `
  // The tuft's spot in the tile, moved to the copy of the tile nearest the camera (stable in the world).
  vec2 grassTile = aTuft.xy * uTile;
  vec2 grassBase = grassTile + uTile * floor((uCam - grassTile) / uTile + 0.5);
  float grassAng = aTuft.z * 6.2831853;
  float grassC = cos(grassAng);
  float grassS = sin(grassAng);
  vec3 grassLocal = vec3(grassC * position.x - grassS * position.z, position.y, grassS * position.x + grassC * position.z);
  vec3 grassNormal;
  float grassH = grassGround(grassBase, grassNormal);
  // Masks: none on buildings, belts, nodes, water, steep slopes or out of the lattice; short on port pads,
  // on banks and near the aim while building; thinner far away.
  float grassKeep = 1.0;
  vec2 grassCell = floor(grassBase / 2.0) + uLattice.x;
  if (grassCell.x < 0.0 || grassCell.y < 0.0 || grassCell.x >= uLattice.y || grassCell.y >= uLattice.z) grassKeep = 0.0;
  else {
    vec4 cell = texelFetch(uCells, ivec2(grassCell), 0);
    if (cell.r > 0.9 || cell.a > 0.0) grassKeep = 0.0;
    else if (cell.r > 0.4) grassKeep *= 0.2;
    if (cell.g < 0.5) grassKeep *= 1.0 - min(1.0, cell.g * 255.0 / 40.0);
  }
  if (grassH < uWater + 0.05 || grassNormal.y < 0.82) grassKeep = 0.0;
  float grassDist = distance(grassBase, uCam);
  grassKeep *= 1.0 - smoothstep(0.35 * uTile, 0.5 * uTile, grassDist);
  grassKeep *= 1.0 - uFlatten.w * 0.85 * (1.0 - smoothstep(uFlatten.z * 0.7, uFlatten.z, distance(grassBase, uFlatten.xy)));
  #ifdef FLOWERS
  // Flowers in meadows, not everywhere.
  grassKeep *= step(0.18, sin(grassBase.x * 0.045 + 1.3) * sin(grassBase.y * 0.037 - 0.7) + 0.25 * (aTuft.w - 0.5));
  #endif
  float grassScale = grassKeep * (0.75 + 0.5 * aTuft.w);
  // Wind and the things pushing the blades aside (more at the tip: aBlade.x is the height along the blade).
  vec2 grassXZ = grassBase + grassLocal.xz;
  float grassT = aBlade.x * aBlade.x;
  float grassWind = 0.12 * sin(1.7 * uTime + 0.35 * grassXZ.x + 0.21 * grassXZ.y) + 0.06 * sin(3.1 * uTime + 0.9 * grassXZ.x - 0.6 * grassXZ.y);
  vec2 grassBend = uWind * grassWind * grassT;
  for (int k = 0; k < ${GRASS_PUSHERS}; k++) {
    vec3 pu = uPush[k];
    if (pu.z <= 0.0) continue;
    vec2 dp = grassXZ - pu.xy;
    float dd = length(dp);
    if (dd < pu.z) {
      float push = 1.0 - dd / pu.z;
      grassBend += dp / max(dd, 0.001) * push * 0.45 * aBlade.x;
      grassScale *= 1.0 - 0.5 * push;
    }
  }
  vec3 grassPos = vec3(grassXZ.x + grassBend.x * grassScale, grassH + grassLocal.y * grassScale, grassXZ.y + grassBend.y * grassScale);
`;

let grassMaterial: THREE.MeshLambertMaterial | null = null;
let flowerMaterial: THREE.MeshLambertMaterial | null = null;

/** Lambert (fog, lights, received shadows stay three's) moved to the instance's spot in the vertex shader. */
function makeMaterial(key: string, colorCode: string, colors: boolean): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, vertexColors: colors });
  if (colors) m.defines = { FLOWERS: '' };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, grassUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PLACE}\nvarying float vGrassT;\nvarying float vGrassRand;`)
      .replace('#include <beginnormal_vertex>', `${MAIN}\nvGrassT = aBlade.x;\nvGrassRand = aBlade.y + aTuft.w;\nvec3 objectNormal = normalize(mix(normal, grassNormal, 0.7));\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( tangent.xyz );\n#endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = grassPos;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGrassT;\nvarying float vGrassRand;')
      .replace('#include <color_fragment>', `#include <color_fragment>\n${colorCode}`)
      // Both faces of a blade light like the ground (no flipped normal on the back face).
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
  };
  m.customProgramCacheKey = () => key;
  return m;
}

function materials(): { grass: THREE.MeshLambertMaterial; flowers: THREE.MeshLambertMaterial } {
  // Dark at the root to light at the tip, a little hue jitter per blade (the ground's greens).
  grassMaterial ??= makeMaterial(
    'grass-v1',
    `vec3 grassRoot = vec3(0.07, 0.17, 0.035);
     vec3 grassTip = mix(vec3(0.29, 0.53, 0.073), vec3(0.42, 0.56, 0.12), fract(vGrassRand * 7.13));
     diffuseColor.rgb = mix(grassRoot, grassTip, smoothstep(0.0, 1.0, vGrassT));`,
    false,
  );
  flowerMaterial ??= makeMaterial('flowers-v1', '', true);
  return { grass: grassMaterial, flowers: flowerMaterial };
}

/** R2 low-discrepancy sequence: any prefix of the instances covers the tile evenly. */
function tuftAttribute(count: number, seed: number): THREE.InstancedBufferAttribute {
  const a = new Float32Array(count * 4);
  const rng = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    a[i * 4] = (0.5 + i * 0.7548776662466927) % 1;
    a[i * 4 + 1] = (0.5 + i * 0.5698402909980532) % 1;
    a[i * 4 + 2] = rng();
    a[i * 4 + 3] = rng();
  }
  return new THREE.InstancedBufferAttribute(a, 4);
}

/** A tuft: 24 blades (5 corners, 3 triangles each) in a 0.3 m disc. */
function tuftGeometry(): THREE.InstancedBufferGeometry {
  const rng = mulberry32(7);
  const pos: number[] = [];
  const blade: number[] = [];
  const idx: number[] = [];
  for (let b = 0; b < 24; b++) {
    const r = 0.3 * Math.sqrt(rng());
    const a = rng() * Math.PI * 2;
    const rx = Math.cos(a) * r;
    const rz = Math.sin(a) * r;
    const yaw = rng() * Math.PI;
    const w = 0.05 + rng() * 0.025;
    const h = 0.28 + rng() * 0.27;
    const lean = (rng() - 0.5) * 0.12;
    const seed = rng();
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const base = pos.length / 3;
    for (const [x, y] of [[-w / 2, 0], [w / 2, 0], [-w * 0.3, h * 0.55], [w * 0.3, h * 0.55], [0, h]] as const) {
      const lx = x + lean * (y / h);
      pos.push(rx + c * lx, y, rz + s * lx);
      blade.push(y / h, seed);
    }
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(blade, 2));
  g.setIndex(idx);
  g.setAttribute('aTuft', tuftAttribute(CAP_TUFTS, 11));
  return g;
}

const FLOWER_COLORS = [0xf4f1ea, 0xf2cf3b, 0xb48be0, 0xe0534a];

/** A patch of 6 flowers (stem and a 5-petal star), in a 0.5 m disc. */
function flowerGeometry(): THREE.InstancedBufferGeometry {
  const rng = mulberry32(5);
  const pos: number[] = [];
  const col: number[] = [];
  const blade: number[] = [];
  const idx: number[] = [];
  const stem = new THREE.Color(0x3d6b22);
  const head = new THREE.Color();
  for (let f = 0; f < 6; f++) {
    const r = 0.5 * Math.sqrt(rng());
    const a = rng() * Math.PI * 2;
    const fx = Math.cos(a) * r;
    const fz = Math.sin(a) * r;
    const h = 0.22 + rng() * 0.16;
    head.setHex(FLOWER_COLORS[Math.floor(rng() * FLOWER_COLORS.length)]!);
    const seed = rng();
    // Stem: a thin vertical triangle.
    let base = pos.length / 3;
    pos.push(fx - 0.012, 0, fz, fx + 0.012, 0, fz, fx, h, fz);
    for (let k = 0; k < 3; k++) col.push(stem.r, stem.g, stem.b);
    blade.push(0, seed, 0, seed, 1, seed);
    idx.push(base, base + 1, base + 2);
    // Head: center + 5 petal tips, nearly flat.
    base = pos.length / 3;
    pos.push(fx, h, fz);
    col.push(head.r * 0.8, head.g * 0.8, head.b * 0.8);
    blade.push(1, seed);
    for (let p = 0; p < 10; p++) {
      const ang = (p / 10) * Math.PI * 2;
      const rr = p % 2 === 0 ? 0.07 : 0.03;
      pos.push(fx + Math.cos(ang) * rr, h + 0.01, fz + Math.sin(ang) * rr);
      col.push(head.r, head.g, head.b);
      blade.push(1, seed);
    }
    for (let p = 0; p < 10; p++) idx.push(base, base + 1 + p, base + 1 + ((p + 1) % 10));
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(blade, 2));
  g.setIndex(idx);
  g.setAttribute('aTuft', tuftAttribute(CAP_FLOWERS, 29));
  return g;
}

/**
 * Animated grass on the relief: one draw call of tufts and one of flower patches, laid around the camera
 * in a wrapping tile, standing on the ground and hidden under buildings, belts, nodes and water by the
 * terrain's textures (FactoryView keeps them up to date).
 */
export class GrassField {
  readonly root = new THREE.Group();
  private readonly grass: THREE.Mesh;
  private readonly flowers: THREE.Mesh;
  private quality: GrassQuality = 'medium';

  constructor() {
    const m = materials();
    this.grass = new THREE.Mesh(tuftGeometry(), m.grass);
    this.flowers = new THREE.Mesh(flowerGeometry(), m.flowers);
    for (const mesh of [this.grass, this.flowers]) {
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      this.root.add(mesh);
    }
    this.root.name = 'grass';
    this.setQuality('medium');
  }

  setQuality(q: GrassQuality): void {
    this.quality = q;
    this.root.visible = q !== 'off';
    if (q === 'off') return;
    const l = LEVELS[q];
    (this.grass.geometry as THREE.InstancedBufferGeometry).instanceCount = l.tufts;
    (this.flowers.geometry as THREE.InstancedBufferGeometry).instanceCount = l.flowers;
    grassUniforms.uTile.value = l.tile;
    // Received shadows only from the medium quality up (one recompile when switching).
    this.grass.receiveShadow = this.flowers.receiveShadow = q !== 'low';
  }

  get current(): GrassQuality {
    return this.quality;
  }

  dispose(): void {
    this.grass.geometry.dispose();
    this.flowers.geometry.dispose();
    this.root.removeFromParent();
  }
}
