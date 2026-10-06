import type { VehicleControls } from '../vehicle/Vehicle';

export interface BotState {
  x: number;
  z: number;
  /** Heading in radians (atan2(fwd.x, fwd.z)). */
  heading: number;
  /** Forward speed m/s. */
  speed: number;
}

/**
 * Simple waypoint-following driver (tests, medal calibration). Waypoints are
 * [x, z, maxKmh?] road centerline points from track/layout.ts `centerline()`.
 */
export class Bot {
  index = 0;
  private stuckTime = 0;
  private reverseTime = 0;

  constructor(
    private readonly points: [number, number, number?][],
    /** Cornering speed scale: hints assume 32 m/s² of lateral grip; scale = sqrt(latAccel / 32). */
    private readonly cornerScale = 1,
    private readonly braking = 14,
    private readonly radius = 7,
  ) {}

  get done(): boolean {
    return this.index >= this.points.length;
  }

  controls(s: BotState, dt: number): VehicleControls {
    while (this.index < this.points.length) {
      const [tx, tz] = this.points[this.index]!;
      if (Math.hypot(tx - s.x, tz - s.z) < this.radius) this.index++;
      else break;
    }
    if (this.done) return { throttle: 1, brake: 0, steer: 0, handbrake: false };
    const [tx, tz] = this.points[this.index]!;
    const d = Math.hypot(tx - s.x, tz - s.z);
    let err = Math.atan2(tx - s.x, tz - s.z) - s.heading;
    err = Math.atan2(Math.sin(err), Math.cos(err));

    let limit = Infinity;
    let acc = d;
    for (let k = this.index; k < Math.min(this.points.length, this.index + 4); k++) {
      if (k > this.index) acc += Math.hypot(this.points[k]![0] - this.points[k - 1]![0], this.points[k]![1] - this.points[k - 1]![1]);
      const lim = this.points[k]![2];
      if (lim !== undefined) {
        const v = (lim / 3.6) * this.cornerScale;
        limit = Math.min(limit, Math.sqrt(v * v + 2 * this.braking * Math.max(0, acc - 4)));
      }
    }
    if (Math.abs(err) > 0.9) limit = Math.min(limit, 11);

    if (Math.abs(s.speed) < 0.8) this.stuckTime += dt;
    else this.stuckTime = 0;
    if (this.stuckTime > 0.9) {
      this.reverseTime = 0.9;
      this.stuckTime = 0;
    }
    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      return { throttle: 0, brake: 1, steer: err < 0 ? 1 : -1, handbrake: false };
    }
    const steer = Math.max(-1, Math.min(1, err * 3));
    const tooFast = s.speed > limit;
    return { throttle: tooFast ? 0 : 1, brake: s.speed > limit + 2 ? 1 : 0, steer, handbrake: false };
  }
}
