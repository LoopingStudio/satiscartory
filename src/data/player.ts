/** On-foot character tuning (meters, seconds). */
export const PLAYER = {
  WALK_SPEED: 6,
  SPRINT_SPEED: 11,
  JUMP_SPEED: 5.6,
  /** Max obstacle height climbed automatically (conveyors are 0.8 m: walkable like in Satisfactory). */
  STEP_HEIGHT: 0.9,
  /** Build reach from the player, in meters. */
  REACH: 28,
  CAMERA_DISTANCE: 6.5,
  CAMERA_MIN: 2.5,
  CAMERA_MAX: 14,
  CAMERA_SHOULDER: 0.7,
  CAMERA_HEIGHT: 1.65,
  MOUSE_SENSITIVITY: 0.0022,
  /** Right stick at full tilt, in rad/s (times the pad sensitivity setting). */
  PAD_YAW_SPEED: 3.2,
  PAD_PITCH_SPEED: 2.1,
  /** Camera distances cycled by the pad (D-pad up). */
  PAD_ZOOM_STEPS: [4, 6.5, 10],
} as const;
