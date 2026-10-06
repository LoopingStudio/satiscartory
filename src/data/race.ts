/** Time-trial rules and tuning. */
export const RACE = {
  /** Countdown before GO, in physics ticks (90 = 1.5 s). */
  COUNTDOWN_TICKS: 90,
  /** Respawn this far past the last checkpoint gate (m), facing the crossing direction. */
  RESPAWN_AHEAD: 3,
  /** Respawn below this distance under the lowest road surface (fell off the track). */
  FALL_LIMIT: 25,
  /** Medal thresholds as multiples of the author time (Trackmania-like). */
  MEDAL_RATIOS: { gold: 1.07, silver: 1.18, bronze: 1.5 },
} as const;
