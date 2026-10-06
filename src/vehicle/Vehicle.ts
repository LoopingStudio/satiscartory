import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { CarGeometry } from '../car/geometry';
import type { VehicleTuning } from '../car/tuning';
import { CAR_SCALE } from '../config/constants';
import { VEHICLE } from '../data/vehicle';

export interface VehicleControls {
  /** 0..1 */
  throttle: number;
  /** 0..1 (brake, or reverse when stopped) */
  brake: number;
  /** -1..1, positive = left */
  steer: number;
  handbrake: boolean;
}

export const NO_CONTROLS: VehicleControls = { throttle: 0, brake: 0, steer: 0, handbrake: false };

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Arcade car on Rapier's DynamicRayCastVehicleController. Chassis-local axes:
 * +Y up, +Z forward, +X left. The physics world is stepped by the owner
 * (call `step()` before `world.step()` and `afterWorldStep()` right after).
 */
export class Vehicle {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  readonly prevPos = new THREE.Vector3();
  readonly curPos = new THREE.Vector3();
  readonly prevQuat = new THREE.Quaternion();
  readonly curQuat = new THREE.Quaternion();
  /** Signed speed along the car's forward axis (m/s). */
  speed = 0;
  steerAngle = 0;
  wheelsInContact = 0;
  /** Seconds spent upside-down or stuck (for auto-respawn). */
  flippedTime = 0;
  drifting = false;
  /** Wheels currently touching the off-road ground (grass). */
  wheelsOffroad = 0;
  /** Collider considered off-road (slow, low grip). */
  offroad: RAPIER.Collider | null = null;
  readonly wheelSpin: number[] = [];
  private readonly frontIdx: number[] = [];
  private readonly rearIdx: number[] = [];
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly right = new THREE.Vector3();

  constructor(
    private readonly world: RAPIER.World,
    readonly geometry: CarGeometry,
    public tuning: VehicleTuning,
    spawn: { position: THREE.Vector3; yaw: number },
  ) {
    const s = CAR_SCALE;
    const [minX, minY, minZ] = geometry.bodyMin;
    const [maxX, maxY, maxZ] = geometry.bodyMax;
    const hx = ((maxX - minX) / 2) * s * 0.92;
    const hz = ((maxZ - minZ) / 2) * s * 0.95;
    // Keep the box above the wheel bottoms so it never drags on the road.
    const lowest = Math.max(minY, Math.min(...geometry.wheels.map((w) => w.center[1]))) * s;
    const top = maxY * s;
    const hy = (top - lowest) / 2;
    const cy = lowest + hy;
    const cz = ((minZ + maxZ) / 2) * s;
    // Center of mass between the axles (not the body box center) so the car sits level.
    const comZ = (geometry.wheels.reduce((acc, w) => acc + w.center[2], 0) / Math.max(1, geometry.wheels.length)) * s;

    const q = new THREE.Quaternion().setFromAxisAngle(UP, spawn.yaw);
    const comY = cy + tuning.comY;
    const m = tuning.massKg;
    // Box inertia, boosted on roll/pitch so the car resists flipping.
    const ix = (m / 12) * ((2 * hy) ** 2 + (2 * hz) ** 2) * 1.8;
    const iy = (m / 12) * ((2 * hx) ** 2 + (2 * hz) ** 2);
    const iz = (m / 12) * ((2 * hx) ** 2 + (2 * hy) ** 2) * 2.2;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.position.x, spawn.position.y, spawn.position.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setCcdEnabled(true)
        .setLinearDamping(0)
        .setAngularDamping(0.6)
        .setAdditionalMassProperties(m, { x: 0, y: comY, z: comZ }, { x: ix, y: iy, z: iz }, { x: 0, y: 0, z: 0, w: 1 }),
    );
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(0, cy, cz).setDensity(0).setFriction(0.15).setRestitution(0.05),
      this.body,
    );

    this.controller = world.createVehicleController(this.body);
    this.controller.indexUpAxis = 1;
    this.controller.setIndexForwardAxis = 2; // (sic) setter name in the typings
    geometry.wheels.forEach((w, i) => {
      const r = w.radius * s;
      const conn = { x: w.center[0] * s, y: w.center[1] * s + tuning.suspensionRest, z: w.center[2] * s };
      this.controller.addWheel(conn, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, tuning.suspensionRest, r);
      (w.front ? this.frontIdx : this.rearIdx).push(i);
      this.wheelSpin.push(0);
    });
    this.applyTuning(tuning);
    this.readPose();
    this.prevPos.copy(this.curPos);
    this.prevQuat.copy(this.curQuat);
  }

  applyTuning(t: VehicleTuning): void {
    this.tuning = t;
    const vc = this.controller;
    for (let i = 0; i < vc.numWheels(); i++) {
      vc.setWheelSuspensionStiffness(i, t.suspensionStiffness);
      vc.setWheelSuspensionCompression(i, t.suspensionCompression);
      vc.setWheelSuspensionRelaxation(i, t.suspensionRelaxation);
      vc.setWheelMaxSuspensionTravel(i, t.suspensionTravel);
      vc.setWheelMaxSuspensionForce(i, 1e7);
      vc.setWheelFrictionSlip(i, t.frictionSlip);
      vc.setWheelSideFrictionStiffness(i, t.sideFrictionStiffness);
    }
  }

  private readPose(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.curPos.set(t.x, t.y, t.z);
    this.curQuat.set(r.x, r.y, r.z, r.w);
  }

  /** Applies controls and assists, then updates the raycast vehicle. Call before world.step(). */
  step(dt: number, c: VehicleControls): void {
    const t = this.tuning;
    const vc = this.controller;
    const body = this.body;
    this.prevPos.copy(this.curPos);
    this.prevQuat.copy(this.curQuat);

    const r = body.rotation();
    this.q.set(r.x, r.y, r.z, r.w);
    this.fwd.set(0, 0, 1).applyQuaternion(this.q);
    this.up.set(0, 1, 0).applyQuaternion(this.q);
    this.right.set(-1, 0, 0).applyQuaternion(this.q);
    const lv = body.linvel();
    this.v.set(lv.x, lv.y, lv.z);
    const speed = this.v.dot(this.fwd);
    const absSpeed = Math.abs(speed);
    this.speed = speed;

    // Steering: speed-sensitive and smoothed.
    const speedRatio = Math.min(1, absSpeed / t.topSpeedMs);
    const maxSteer = t.steerMaxRad * (1 - (1 - t.steerAtTopSpeed) * speedRatio);
    const target = c.steer * maxSteer;
    const k = 1 - Math.exp(-dt * t.steerSpeed * (c.steer === 0 ? 1.6 : 1));
    this.steerAngle += (target - this.steerAngle) * k;
    // Positive steering angle turns left (toward +X) with our axle convention.
    for (const i of this.frontIdx) vc.setWheelSteering(i, this.steerAngle);

    // Engine / brake / reverse.
    let engine = 0;
    let brake = 0;
    if (c.throttle > 0) engine = t.engineN * c.throttle;
    if (c.brake > 0) {
      if (speed > 1.0) brake = t.brakeN * c.brake;
      else engine -= t.reverseN * c.brake;
    }
    if (c.throttle > 0 && c.brake > 0 && speed > 1.0) engine = 0;
    const front = (engine * (1 - t.rearBias)) / Math.max(1, this.frontIdx.length);
    const rear = (engine * t.rearBias) / Math.max(1, this.rearIdx.length);
    for (const i of this.frontIdx) vc.setWheelEngineForce(i, front);
    for (const i of this.rearIdx) vc.setWheelEngineForce(i, rear);
    // Rapier brakes take an impulse per step. The handbrake adds to the foot brake on the rear wheels.
    const brakeImpulse = (brake * dt) / 4;
    const coast = c.throttle === 0 && c.brake === 0 ? (t.massKg * VEHICLE.COAST_DECEL * dt) / 4 : 0;
    const handbrake = c.handbrake ? (t.brakeN * VEHICLE.HANDBRAKE_BRAKE * dt) / 4 : 0;
    for (const i of this.frontIdx) vc.setWheelBrake(i, brakeImpulse + coast);
    for (const i of this.rearIdx) vc.setWheelBrake(i, brakeImpulse + coast + handbrake);

    // Handbrake drift: rear tires lose side grip.
    this.drifting = c.handbrake && absSpeed > 8;
    for (const i of this.rearIdx) vc.setWheelSideFrictionStiffness(i, this.drifting ? t.driftSideFriction : t.sideFrictionStiffness);

    // Aerodynamics: drag along velocity, rolling resistance, downforce along the car's down axis.
    const vmag = this.v.length();
    if (vmag > 0.01) {
      // Off-road: heavy extra resistance (top speed ≈ 60 km/h on grass).
      const offroad = (this.wheelsOffroad / 4) * (t.engineN / VEHICLE.OFFROAD_SPEED) * vmag;
      const drag = t.dragK * vmag * vmag + t.rollingK * vmag + offroad;
      const s = (-drag * dt) / vmag;
      body.applyImpulse({ x: this.v.x * s, y: this.v.y * s, z: this.v.z * s }, true);
    }
    const df = t.downforceK * speed * speed * dt;
    body.applyImpulse({ x: -this.up.x * df, y: -this.up.y * df, z: -this.up.z * df }, true);

    // Air control: level the car while airborne and let the player turn it.
    if (this.wheelsInContact === 0) {
      const av = body.angvel();
      // Rotation axis that brings the car's up vector back toward world up.
      const level = new THREE.Vector3().crossVectors(this.up, UP).multiplyScalar(t.airControl * dt);
      const yawTarget = c.steer * VEHICLE.AIR_YAW;
      body.setAngvel({ x: av.x + level.x, y: av.y + (yawTarget - av.y) * Math.min(1, dt * 2), z: av.z + level.z }, true);
    }

    vc.updateVehicle(dt);

    let contact = 0;
    let offroad = 0;
    for (let i = 0; i < vc.numWheels(); i++) {
      if (vc.wheelIsInContact(i)) {
        contact++;
        if (this.offroad && vc.wheelGroundObject(i)?.handle === this.offroad.handle) offroad++;
      }
      this.wheelSpin[i] = vc.wheelRotation(i) ?? 0;
    }
    this.wheelsInContact = contact;
    this.wheelsOffroad = offroad;

    // On its side / upside-down, or resting on fewer than 3 wheels without moving: auto-respawn timer.
    const tilted = this.up.y < 0.5;
    const resting = contact < 3 && Math.abs(this.v.y) < 0.5;
    if (absSpeed < 3 && (tilted || resting)) this.flippedTime += dt;
    else this.flippedTime = 0;
  }

  /** Reads the new pose after world.step(). */
  afterWorldStep(): void {
    this.readPose();
  }

  /** Teleports the car (respawn), zeroing velocities. */
  reset(position: THREE.Vector3, yaw: number): void {
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    this.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerAngle = 0;
    this.flippedTime = 0;
    this.readPose();
    this.prevPos.copy(this.curPos);
    this.prevQuat.copy(this.curQuat);
  }

  /** Freezes the car in place (countdown). */
  hold(): void {
    this.body.setLinvel({ x: 0, y: Math.min(0, this.body.linvel().y), z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** Interpolated pose for rendering. */
  interpolate(alpha: number, pos: THREE.Vector3, quat: THREE.Quaternion): void {
    pos.lerpVectors(this.prevPos, this.curPos, alpha);
    quat.slerpQuaternions(this.prevQuat, this.curQuat, alpha);
  }

  /** World-space wheel suspension length (for visuals). */
  suspensionLength(i: number): number {
    return this.controller.wheelSuspensionLength(i) ?? this.tuning.suspensionRest;
  }

  dispose(): void {
    this.world.removeVehicleController(this.controller);
    this.world.removeRigidBody(this.body);
  }
}
