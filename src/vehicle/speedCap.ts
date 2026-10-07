import type { VehicleTuning } from '../car/tuning';

/** The soft speed cap starts resisting at this fraction of the cap. */
export const SPEED_CAP_KNEE = 0.8;

/**
 * Downhill, gravity pushes past a cap sized on flat ground (a sports car reached ~124 km/h down 25° under
 * a 90 km/h cap). Extra resistance (N, along the velocity) that cancels the downhill pull above the knee,
 * fading in up to the cap: `vy` is the velocity's vertical direction (−1..1, negative going down),
 * `gravity` the car's own (m/s²).
 */
export function slopeCapForce(massKg: number, gravity: number, vy: number, cap: number, v: number): number {
  const knee = cap * SPEED_CAP_KNEE;
  if (!(cap > 0) || v <= knee || vy >= 0) return 0;
  return massKg * gravity * -vy * Math.min(1, (v - knee) / (cap - knee));
}

/**
 * Extra resistance (N) of a soft speed cap at horizontal speed `v` (m/s): zero up to `SPEED_CAP_KNEE × cap`,
 * then linear, sized so that full throttle on flat ground tops out at `cap` (engine = drag + rolling + cap
 * resistance there). Zero for a car that is slower than the cap anyway. Pure (tests, Vehicle).
 */
export function speedCapForce(t: Pick<VehicleTuning, 'engineN' | 'dragK' | 'rollingK'>, cap: number, v: number): number {
  const knee = cap * SPEED_CAP_KNEE;
  if (!(cap > 0) || v <= knee) return 0;
  const surplus = t.engineN - t.dragK * cap * cap - t.rollingK * cap;
  if (surplus <= 0) return 0;
  return (surplus / (cap - knee)) * (v - knee);
}
