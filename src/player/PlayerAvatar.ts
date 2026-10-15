import * as THREE from 'three';
import type { AssetLoader } from '../core/assets/AssetLoader';
import { ACCENT_COLORS, BODY_COLORS, DEFAULT_LOOK, accentColor, bodyColor, type CharacterLook } from '../data/character';
import { buildHat, disposeHat } from './hats';

const AVATAR_HEIGHT = 1.6;
/** Where hats sit, in the body's frame: the top of the hood (measured: 1.6 m, ~1.1 m wide near the top). */
const HEAD_TOP = 1.6;
/** Hats are modelled for a ~0.7 m head: the hood is wider. */
const HAT_SCALE = 1.4;
const LUMA = new THREE.Vector3(0.2126, 0.7152, 0.0722);

/**
 * Recolors the mascot in its own copy of the kit material: texels of the hooded suit (light grey-lavender)
 * and of the creature's skin (teal face and tentacles) take the look's colors, keeping their shading (luminance relative
 * to the model's own color); the dark visor stays. Untouched colors keep the exact original texels.
 */
function lookMaterial(source: THREE.Material): { material: THREE.Material; uniforms: Record<string, THREE.IUniform> } {
  const material = source.clone();
  const uniforms: Record<string, THREE.IUniform> = {
    uBody: { value: new THREE.Color(BODY_COLORS[0]!.hex) },
    uBodyRef: { value: new THREE.Color(BODY_COLORS[0]!.hex) },
    uBodyOn: { value: 0 },
    uAccent: { value: new THREE.Color(ACCENT_COLORS[0]!.hex) },
    uAccentRef: { value: new THREE.Color(ACCENT_COLORS[0]!.hex) },
    uAccentOn: { value: 0 },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uBody; uniform vec3 uBodyRef; uniform float uBodyOn;
uniform vec3 uAccent; uniform vec3 uAccentRef; uniform float uAccentOn;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
{
  vec3 c = diffuseColor.rgb;
  vec3 w = vec3(${LUMA.x}, ${LUMA.y}, ${LUMA.z});
  float mn = min(c.r, min(c.g, c.b));
  if (uAccentOn > 0.5 && c.g > c.r * 1.8 && c.g > 0.1) diffuseColor.rgb = uAccent * (dot(c, w) / dot(uAccentRef, w));
  else if (uBodyOn > 0.5 && mn > 0.33) diffuseColor.rgb = uBody * (dot(c, w) / dot(uBodyRef, w));
}`,
      );
  };
  material.customProgramCacheKey = () => 'oopi-look';
  return { material, uniforms };
}
/** The mascot's face points along -X in the source model: turn it to look along +Z. */
const FACE_YAW = Math.PI / 2;

/** The "oopi" mascot with procedural walk bob, lean and landing squash. */
export class PlayerAvatar {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly model: THREE.Object3D;
  private walkPhase = 0;
  private squash = 0;
  private yaw = 0;
  private lean = 0;
  private readonly blob: THREE.Mesh;
  private readonly materials: THREE.Material[] = [];
  private readonly uniforms: Record<string, THREE.IUniform>[] = [];
  private hat: THREE.Group | null = null;
  private hatKey = '';
  private readonly flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  private readonly tilt = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly n = new THREE.Vector3();

  constructor(private readonly assets: AssetLoader, look: CharacterLook = DEFAULT_LOOK) {
    this.model = assets.instantiate('factory-kit/oopi');
    // Its own material (the kit's one is shared with every factory model).
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material)) return;
      const { material, uniforms } = lookMaterial(m.material);
      m.material = material;
      this.materials.push(material);
      this.uniforms.push(uniforms);
    });
    const info = assets.info('factory-kit/oopi');
    const s = AVATAR_HEIGHT / info.size.y;
    // The source mesh is not centered on its origin: recenter it on X/Z and put its feet at y = 0.
    const c = info.bbox.getCenter(new THREE.Vector3());
    this.model.position.set(-c.x * s, -info.bbox.min.y * s, -c.z * s);
    this.model.scale.setScalar(s);
    const pivot = new THREE.Group();
    pivot.rotation.y = FACE_YAW;
    pivot.add(this.model);
    this.body.add(pivot);
    this.body.rotation.order = 'YXZ';
    this.root.add(this.body);
    // Soft blob shadow helps reading height while jumping.
    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.6, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.03;
    blob.name = 'blob';
    this.root.add(blob);
    this.blob = blob;
    this.setLook(look);
  }

  /** Applies a look (colors, hat); cheap when nothing changed. */
  setLook(look: CharacterLook): void {
    const body = bodyColor(look.body);
    const accent = accentColor(look.accent);
    for (const u of this.uniforms) {
      (u.uBody!.value as THREE.Color).setHex(body.hex);
      u.uBodyOn!.value = body.id === BODY_COLORS[0]!.id ? 0 : 1;
      (u.uAccent!.value as THREE.Color).setHex(accent.hex);
      u.uAccentOn!.value = accent.id === ACCENT_COLORS[0]!.id ? 0 : 1;
    }
    const key = `${look.hat}:${accent.id}`;
    if (key === this.hatKey) return;
    this.hatKey = key;
    if (this.hat) disposeHat(this.hat);
    this.hat = buildHat(this.assets, look.hat, accent.hex);
    if (this.hat) {
      this.hat.position.y = HEAD_TOP;
      this.hat.scale.setScalar(HAT_SCALE);
      this.body.add(this.hat);
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.blob.geometry.dispose();
    (this.blob.material as THREE.Material).dispose();
    if (this.hat) disposeHat(this.hat);
    for (const m of this.materials) m.dispose();
  }

  /**
   * Faces toward `targetYaw` smoothly. `ground` (height and slope dh/dx, dh/dz of the terrain under the
   * feet): on a slope the capsule's feet float a little (more on steeper slopes), the model and its blob
   * shadow are put back on the ground.
   */
  update(dt: number, pos: THREE.Vector3, speed: number, grounded: boolean, targetYaw: number, landed: number, ground: { y: number; sx: number; sz: number } | null = null): void {
    this.root.position.copy(pos);
    const gap = ground ? pos.y - ground.y : Infinity;
    if (ground && grounded && gap > -0.05 && gap < 0.3) {
      this.root.position.y = pos.y - Math.min(Math.max(gap, 0), 0.25);
      this.blob.position.y = ground.y - this.root.position.y + 0.03;
      this.n.set(-ground.sx, 1, -ground.sz).normalize();
      this.blob.quaternion.copy(this.tilt.setFromUnitVectors(this.up, this.n)).multiply(this.flat);
    } else {
      this.blob.position.y = 0.03;
      this.blob.quaternion.copy(this.flat);
    }
    // shortest-angle smoothing
    let d = targetYaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * (1 - Math.exp(-dt * 12));
    this.body.rotation.y = this.yaw;

    const moving = grounded && speed > 0.5;
    this.walkPhase += dt * (moving ? 4 + speed * 1.1 : 0);
    if (landed > 0) this.squash = Math.max(this.squash, landed);
    this.squash *= Math.exp(-dt * 9);
    const bob = moving ? Math.abs(Math.sin(this.walkPhase)) * 0.12 : 0;
    const sq = this.squash * 0.35;
    this.body.position.y = bob;
    this.body.scale.set(1 + sq * 0.6, 1 - sq + (moving ? Math.sin(this.walkPhase * 2) * 0.03 : 0), 1 + sq * 0.6);
    const targetLean = moving ? Math.min(0.25, speed * 0.02) : 0;
    this.lean += (targetLean - this.lean) * (1 - Math.exp(-dt * 8));
    this.body.rotation.x = this.lean;
    this.body.rotation.z = moving ? Math.sin(this.walkPhase) * 0.06 : 0;
  }
}
