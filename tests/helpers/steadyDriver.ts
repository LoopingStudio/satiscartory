import type { VehicleControls } from '../../src/vehicle/Vehicle';
import type { BotState } from '../../src/race/bot';

/**
 * A steady test driver (wear calibration), smoother than the race Bot: it tracks its progress along the road's
 * centerline (never "misses" a waypoint after a jump and turns back), steers at a point ahead that moves away with the
 * speed (pure pursuit), and follows a speed profile with proportional throttle and brake: the corner speeds of the
 * hints for `latAccel` m/s² of grip, braking at `braking` m/s² before them. Driven below the car's grip limit, the
 * same car laps the Ovale in the same time give or take a few milliseconds, whatever tiny change it gets: its lap time
 * measures the car's engine, drag and brakes (the Bot's laps jump by several % for a 0.1 % change of the engine). Not
 * its tires: below the limit, the grip it assumes (`latAccel`) sets its corner speeds. On the Colline's jumps a lap is
 * still a knife edge: compare many starts (tests/wear-sim.test.ts).
 */
export class SteadyDriver {
  private readonly x: number[] = [];
  private readonly z: number[] = [];
  /** Distance along the line at each point (m). */
  private readonly s: number[] = [];
  /** Corner speed at each point (m/s), Infinity off the corners. */
  private readonly v: number[] = [];
  /** Current segment: from point seg to seg + 1. */
  private seg = 0;
  private stuckTime = 0;
  private reverseTime = 0;

  constructor(start: { x: number; z: number }, points: [number, number, number?][], latAccel: number, private readonly braking: number) {
    const scale = Math.sqrt(latAccel / 32);
    const add = (x: number, z: number, kmh?: number) => {
      const n = this.x.length;
      this.s.push(n ? this.s[n - 1]! + Math.hypot(x - this.x[n - 1]!, z - this.z[n - 1]!) : 0);
      this.x.push(x);
      this.z.push(z);
      this.v.push(kmh === undefined ? Infinity : (kmh / 3.6) * scale);
    };
    add(start.x, start.z);
    for (const [x, z, kmh] of points) add(x, z, kmh);
    // Past the last point: straight on, through the finish.
    const n = this.x.length;
    const dx = this.x[n - 1]! - this.x[n - 2]!;
    const dz = this.z[n - 1]! - this.z[n - 2]!;
    const l = Math.hypot(dx, dz) || 1;
    add(this.x[n - 1]! + (dx / l) * 200, this.z[n - 1]! + (dz / l) * 200);
  }

  /** Distance along the line of the point nearest to (px, pz) on the segments around the current one (updates seg). */
  private progress(px: number, pz: number): number {
    let best = Infinity;
    let bestS = 0;
    let bestSeg = this.seg;
    const last = this.x.length - 2;
    for (let i = Math.max(0, this.seg - 2); i <= Math.min(last, this.seg + 4); i++) {
      const ax = this.x[i]!;
      const az = this.z[i]!;
      const ex = this.x[i + 1]! - ax;
      const ez = this.z[i + 1]! - az;
      const len2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / len2));
      const d = Math.hypot(ax + ex * t - px, az + ez * t - pz);
      if (d < best - 1e-9) {
        best = d;
        bestSeg = i;
        bestS = this.s[i]! + t * Math.sqrt(len2);
      }
    }
    this.seg = bestSeg;
    return bestS;
  }

  /** Point of the line at distance `s` along it. */
  private at(s: number, out: { x: number; z: number }): void {
    let i = this.seg;
    while (i < this.x.length - 2 && this.s[i + 1]! < s) i++;
    const span = this.s[i + 1]! - this.s[i]! || 1;
    const t = Math.max(0, Math.min(1, (s - this.s[i]!) / span));
    out.x = this.x[i]! + (this.x[i + 1]! - this.x[i]!) * t;
    out.z = this.z[i]! + (this.z[i + 1]! - this.z[i]!) * t;
  }

  private readonly target = { x: 0, z: 0 };

  controls(st: BotState, dt: number): VehicleControls {
    const s = this.progress(st.x, st.z);
    const speed = st.speed;
    this.at(s + 5 + 0.3 * Math.abs(speed), this.target);
    let err = Math.atan2(this.target.x - st.x, this.target.z - st.z) - st.heading;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    // Speed allowed now: each corner ahead, with the distance left to brake for it.
    let limit = Infinity;
    for (let k = this.seg + 1; k < this.x.length && this.s[k]! - s < 250; k++) {
      const v = this.v[k]!;
      if (v !== Infinity) limit = Math.min(limit, Math.sqrt(v * v + 2 * this.braking * Math.max(0, this.s[k]! - s - 4)));
    }
    if (Math.abs(speed) < 0.8) this.stuckTime += dt;
    else this.stuckTime = 0;
    if (this.stuckTime > 1.5) {
      this.reverseTime = 0.9;
      this.stuckTime = 0;
    }
    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      return { throttle: 0, brake: 1, steer: err < 0 ? 1 : -1, handbrake: false };
    }
    const steer = Math.max(-1, Math.min(1, err * 2.5));
    const throttle = Math.max(0, Math.min(1, (limit - speed) / 1.5));
    const brake = Math.max(0, Math.min(1, (speed - limit - 0.5) / 2));
    return { throttle, brake, steer, handbrake: false };
  }
}
