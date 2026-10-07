import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

/** Opt-in for cars outside the race (factory relief). */
export interface ChaseOptions {
  /** Ground height under (x, z): the camera stays above it (descents, valleys). */
  groundAt?: (x: number, z: number) => number;
  /** Colliders the occlusion ray may hit (default: all but the car). */
  filter?: (c: RAPIER.Collider) => boolean;
}

/** Smoothed chase camera with speed-based FOV, Trackmania style. */
export class ChaseCamera {
  distance = 7.5;
  height = 2.6;
  lookAhead = 6;
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly dir = new THREE.Vector3(0, 0, 1);
  private initialized = false;

  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

  /** `world`/`exclude` enable pulling the camera in front of obstacles (gate posts, walls). */
  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly world?: RAPIER.World,
    private readonly exclude?: RAPIER.Collider,
    private readonly opts: ChaseOptions = {},
  ) {}

  snap(): void {
    this.initialized = false;
  }

  update(dt: number, carPos: THREE.Vector3, carQuat: THREE.Quaternion, velocity: THREE.Vector3, topSpeed: number): void {
    const heading = new THREE.Vector3(0, 0, 1).applyQuaternion(carQuat);
    heading.y = 0;
    if (heading.lengthSq() < 1e-4) heading.set(0, 0, 1);
    heading.normalize();
    const flatVel = new THREE.Vector3(velocity.x, 0, velocity.z);
    const speed = flatVel.length();
    // Follow the heading, blend toward the velocity direction when sliding fast (drifts read better).
    const target = heading.clone();
    if (speed > 5 && flatVel.dot(heading) > 0) target.lerp(flatVel.normalize(), 0.35).normalize();
    if (!this.initialized) {
      this.dir.copy(target);
    } else {
      this.dir.lerp(target, 1 - Math.exp(-dt * 4)).normalize();
    }
    const speedRatio = Math.min(1, speed / Math.max(1, topSpeed));
    const dist = this.distance + speedRatio * 2.5;
    const desired = carPos.clone().addScaledVector(this.dir, -dist).add(new THREE.Vector3(0, this.height + speedRatio * 0.6, 0));
    const lookAt = carPos.clone().addScaledVector(this.dir, this.lookAhead).add(new THREE.Vector3(0, 1.0, 0));
    const ground = this.opts.groundAt;
    if (ground) desired.y = Math.max(desired.y, ground(desired.x, desired.z) + 1.4);
    if (!this.initialized) {
      this.pos.copy(desired);
      this.look.copy(lookAt);
      this.initialized = true;
    } else {
      // Horizontal position is rigid (the smoothed direction gives the lag);
      // only height is eased so bumps and landings don't shake the view.
      const y = this.pos.y + (desired.y - this.pos.y) * (1 - Math.exp(-dt * 8));
      this.pos.copy(desired);
      this.pos.y = y;
      this.look.copy(lookAt);
    }
    this.camera.position.copy(this.pos);
    if (this.world) {
      // Keep the car visible: pull the camera in when something sits between them.
      const from = carPos.clone().add(new THREE.Vector3(0, 1.2, 0));
      const to = this.pos.clone().sub(from);
      const len = to.length();
      if (len > 0.5) {
        to.divideScalar(len);
        this.ray.origin = { x: from.x, y: from.y, z: from.z };
        this.ray.dir = { x: to.x, y: to.y, z: to.z };
        const hit = this.world.castRay(this.ray, len, true, undefined, undefined, this.exclude, undefined, this.opts.filter);
        if (hit && hit.timeOfImpact > 0.8) this.camera.position.copy(from).addScaledVector(to, hit.timeOfImpact - 0.4);
      }
    }
    if (ground) {
      const c = this.camera.position;
      c.y = Math.max(c.y, ground(c.x, c.z) + 0.6);
    }
    this.camera.lookAt(this.look);
    const fov = 68 + speedRatio * 16;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt * 3));
      this.camera.updateProjectionMatrix();
    }
  }
}
