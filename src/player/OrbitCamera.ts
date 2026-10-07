import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../core/physics/PhysicsWorld';
import { PLAYER } from '../data/player';

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

  constructor(readonly camera: THREE.PerspectiveCamera, private readonly physics: PhysicsWorld, private readonly exclude: RAPIER.Collider) {}

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

  update(target: THREE.Vector3, dt: number): void {
    this.pivot.set(target.x, target.y + PLAYER.CAMERA_HEIGHT, target.z);
    // Camera looks along dir; it sits behind the pivot.
    const cp = Math.cos(this.pitch);
    this.dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    this.right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const shoulder = this.right.clone().multiplyScalar(PLAYER.CAMERA_SHOULDER);
    const origin = this.pivot.clone().add(shoulder);

    // Collision: cast from the pivot toward the camera position.
    let dist = this.distance;
    const back = this.dir.clone().negate();
    const ray = new RAPIER.Ray(origin, back);
    const hit = this.physics.world.castRay(ray, dist + 0.3, true, undefined, undefined, this.exclude);
    if (hit) dist = Math.max(0.6, hit.timeOfImpact - 0.3);
    // Pull in fast, ease out slowly.
    const k = dist < this.currentDist ? 1 : 1 - Math.exp(-dt * 4);
    this.currentDist += (dist - this.currentDist) * k;

    this.desired.copy(origin).addScaledVector(back, this.currentDist);
    this.camera.position.copy(this.desired);
    this.camera.lookAt(origin.addScaledVector(this.dir, 10));
  }
}
