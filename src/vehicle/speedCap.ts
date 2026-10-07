import type { VehicleTuning } from '../car/tuning';

/** The soft speed cap starts resisting at this fraction of the cap. */
export const SPEED_CAP_KNEE = 0.8;

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
