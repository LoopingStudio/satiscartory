/** Shared raycast-vehicle tuning (per-car values come from car stats). */
export const VEHICLE = {
  /** Share of engine force lost to rolling resistance at top speed (rest is aero drag). */
  ROLLING_SHARE: 0.08,
  REAR_BIAS: 0.6,
  REVERSE_FACTOR: 0.45,
  /** frictionSlip = BASE + PER_GRIP × grip */
  FRICTION_SLIP_BASE: 1.6,
  FRICTION_SLIP_PER_GRIP: 1.4,
  SIDE_FRICTION_PER_GRIP: 1.0,
  DRIFT_SIDE_FRICTION: 0.55,
  /** Handbrake braking (fraction of brake force) applied to the rear wheels. */
  HANDBRAKE_BRAKE: 0.06,
  STEER_AT_TOP_SPEED: 0.3,
  STEER_SPEED: 5,
  SUSPENSION_REST: 0.28,
  SUSPENSION_TRAVEL: 0.25,
  SUSPENSION_STIFFNESS: 55,
  SUSPENSION_COMPRESSION: 4.4,
  SUSPENSION_RELAXATION: 2.6,
  COM_Y: -0.25,
  AIR_CONTROL: 6,
  /** Yaw rate (rad/s) reachable with full steer while airborne. */
  AIR_YAW: 2.5,
  /** Deceleration (m/s²) when coasting without throttle or brake. */
  COAST_DECEL: 0.6,
  /** Top speed (m/s) on grass: off-road resistance balances the engine there. */
  OFFROAD_SPEED: 16,
  /** Seconds upside-down/stuck before an automatic respawn. */
  FLIP_RESPAWN_S: 1.6,
} as const;
