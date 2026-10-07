import * as THREE from 'three';
import type { AssetLoader } from '../core/assets/AssetLoader';

const AVATAR_HEIGHT = 1.6;
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
  private readonly flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  private readonly tilt = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly n = new THREE.Vector3();

  constructor(assets: AssetLoader) {
    this.model = assets.instantiate('factory-kit/oopi');
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
  }

  dispose(): void {
    this.root.removeFromParent();
    this.blob.geometry.dispose();
    (this.blob.material as THREE.Material).dispose();
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
