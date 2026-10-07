import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../core/physics/PhysicsWorld';
import { PLAYER } from '../data/player';

export interface OrbitOptions {
  /** Ground height under (x, z): the camera stays above it. */
  groundAt?: (x: number, z: number) => number;
  /** Colliders the pull-in ray may hit (default: all but the excluded one). */
  filter?: (c: RAPIER.Collider) => boolean;
}

/** Third-person over-the-shoulder camera with collision pull-in. */
export class OrbitCamera {
  yaw = 0;
  pitch = -0.35;
  distance: number = PLAYER.CAMERA_DISTANCE;
  sensitivity: number = PLAYER.MOUSE_SENSITIVITY;
  invertY = false;
  private currentDist: number = PLAYER.CAMERA_DISTANCE;
  private readonly pivot = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly shoulder = new THREE.Vector3();
  private readonly origin = new THREE.Vector3();
  private readonly back = new THREE.Vector3();
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  /** Smoothed height of the pivot (steps and slope breaks would bob the view); NaN = snap. */
  private pivotY = NaN;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly physics: PhysicsWorld,
    private readonly exclude: RAPIER.Collider,
    private readonly opts: OrbitOptions = {},
  ) {}

  rotate(dx: number, dy: number): void {
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity * (this.invertY ? -1 : 1);
    this.pitch = Math.max(-1.35, Math.min(0.9, this.pitch));
  }

  /** Turns by angles (rad), e.g. a stick's rate times dt; invertY applies as for the mouse. */
  turn(dYaw: number, dPitch: number): void {
    this.yaw -= dYaw;
    this.pitch -= dPitch * (this.invertY ? -1 : 1);
    this.pitch = Math.max(-1.35, Math.min(0.9, this.pitch));
  }

  /** Next of the given distances after the current one (wraps to the first). */
  cycleZoom(steps: readonly number[]): void {
    const next = steps.find((d) => d > this.distance + 0.25) ?? steps[0];
    if (next !== undefined) this.distance = Math.max(PLAYER.CAMERA_MIN, Math.min(PLAYER.CAMERA_MAX, next));
  }

  zoom(delta: number): void {
    this.distance = Math.max(PLAYER.CAMERA_MIN, Math.min(PLAYER.CAMERA_MAX, this.distance + delta * 0.8));
  }

  /** Forward direction on the ground plane (for movement). */
  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /** Next update puts the pivot right on the target (after a teleport). */
  snap(): void {
    this.pivotY = NaN;
  }

  update(target: THREE.Vector3, dt: number): void {
    const y = target.y + PLAYER.CAMERA_HEIGHT;
    if (!Number.isFinite(this.pivotY) || Math.abs(y - this.pivotY) > 2) this.pivotY = y;
    else this.pivotY += (y - this.pivotY) * (1 - Math.exp(-dt * 12));
    this.pivot.set(target.x, this.pivotY, target.z);
    // Camera looks along dir; it sits behind the pivot.
    const cp = Math.cos(this.pitch);
    this.dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    this.right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    this.shoulder.copy(this.right).multiplyScalar(PLAYER.CAMERA_SHOULDER);
    this.origin.copy(this.pivot).add(this.shoulder);

    // Collision: cast from the pivot toward the camera position.
    let dist = this.distance;
    this.back.copy(this.dir).negate();
    this.ray.origin = this.origin;
    this.ray.dir = this.back;
    const hit = this.physics.world.castRay(this.ray, dist + 0.3, true, undefined, undefined, this.exclude, undefined, this.opts.filter);
    if (hit) dist = Math.max(0.6, hit.timeOfImpact - 0.3);
    // Pull in fast, ease out slowly.
    const k = dist < this.currentDist ? 1 : 1 - Math.exp(-dt * 4);
    this.currentDist += (dist - this.currentDist) * k;

    this.desired.copy(this.origin).addScaledVector(this.back, this.currentDist);
    // Never under the ground (grazing views of a slope slip past the thin ray).
    const g = this.opts.groundAt;
    if (g) this.desired.y = Math.max(this.desired.y, g(this.desired.x, this.desired.z) + 0.35);
    this.camera.position.copy(this.desired);
    this.camera.lookAt(this.origin.addScaledVector(this.dir, 10));
  }
}
