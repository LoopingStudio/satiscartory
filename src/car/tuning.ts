import type { CarStats } from './stats';
import { VEHICLE } from '../data/vehicle';

/** Parameters consumed by the raycast vehicle (physics units). */
export interface VehicleTuning {
  massKg: number;
  /** Total engine force (split across the 4 wheels). */
  engineN: number;
  /** Fraction of engine force sent to the rear axle. */
  rearBias: number;
  /** Quadratic drag coefficient: F = -k v|v| (top speed emerges where engine = drag). */
  dragK: number;
  /** Linear rolling resistance (N per m/s). */
  rollingK: number;
  brakeN: number;
  reverseN: number;
  /** Rapier wheel friction slip (max friction coefficient). */
  frictionSlip: number;
  sideFrictionStiffness: number;
  /** Rear side friction while drifting (handbrake). */
  driftSideFriction: number;
  downforceK: number;
  steerMaxRad: number;
  /** Fraction of steer kept at top speed (speed-sensitive steering). */
  steerAtTopSpeed: number;
  steerSpeed: number;
  suspensionRest: number;
  suspensionTravel: number;
  suspensionStiffness: number;
  suspensionCompression: number;
  suspensionRelaxation: number;
  /** Center of mass height offset (m, negative = lower = harder to flip). */
  comY: number;
  /** Air control angular acceleration (rad/s²). */
  airControl: number;
  topSpeedMs: number;
}

export function tuningFromStats(s: CarStats): VehicleTuning {
  const rollingK = (s.engineN * VEHICLE.ROLLING_SHARE) / s.topSpeedMs;
  const dragK = (s.engineN * (1 - VEHICLE.ROLLING_SHARE)) / (s.topSpeedMs * s.topSpeedMs);
  return {
    massKg: s.massKg,
    engineN: s.engineN,
    rearBias: VEHICLE.REAR_BIAS,
    dragK,
    rollingK,
    brakeN: s.brakeN,
    reverseN: s.engineN * VEHICLE.REVERSE_FACTOR,
    frictionSlip: VEHICLE.FRICTION_SLIP_BASE + VEHICLE.FRICTION_SLIP_PER_GRIP * s.grip,
    sideFrictionStiffness: VEHICLE.SIDE_FRICTION_PER_GRIP * s.grip,
    driftSideFriction: VEHICLE.DRIFT_SIDE_FRICTION,
    downforceK: s.downforce * (s.massKg / 1000),
    steerMaxRad: s.steerRad,
    steerAtTopSpeed: VEHICLE.STEER_AT_TOP_SPEED,
    steerSpeed: VEHICLE.STEER_SPEED,
    suspensionRest: VEHICLE.SUSPENSION_REST,
    suspensionTravel: VEHICLE.SUSPENSION_TRAVEL,
    suspensionStiffness: VEHICLE.SUSPENSION_STIFFNESS,
    suspensionCompression: VEHICLE.SUSPENSION_COMPRESSION,
    suspensionRelaxation: VEHICLE.SUSPENSION_RELAXATION,
    comY: VEHICLE.COM_Y,
    airControl: VEHICLE.AIR_CONTROL,
    topSpeedMs: s.topSpeedMs,
  };
}
