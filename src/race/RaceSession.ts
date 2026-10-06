export type RacePhase = 'countdown' | 'running' | 'finished';

export type RaceEvent =
  | { type: 'go' }
  | { type: 'checkpoint'; piece: number; index: number; ms: number }
  | { type: 'finish'; ms: number }
  | { type: 'missingCheckpoints'; remaining: number };

/**
 * Pure race state machine (timing in physics ticks, sub-tick precision from
 * gate crossings). Checkpoints count in any order; the finish only counts
 * once every checkpoint has been crossed (Trackmania rules).
 */
export class RaceSession {
  phase: RacePhase = 'countdown';
  /** Physics ticks elapsed since GO. */
  ticks = 0;
  private countdownLeft: number;
  readonly passed = new Set<number>();
  /** Time (ms) of each checkpoint crossing, in crossing order. */
  readonly splits: number[] = [];
  finishMs: number | null = null;
  /** Piece index of the last checkpoint crossed (respawn point), or null. */
  lastCheckpoint: number | null = null;
  respawns = 0;
  /** Forward minus backward crossings of the finish: reversing through it never counts as finishing. */
  private finishNet = 0;

  constructor(
    readonly checkpointCount: number,
    readonly dtMs: number,
    readonly countdownTicks: number,
  ) {
    this.countdownLeft = countdownTicks;
  }

  /** Current race time in ms (0 during the countdown). */
  get timeMs(): number {
    if (this.finishMs !== null) return this.finishMs;
    return this.ticks * this.dtMs;
  }

  /** Countdown seconds remaining (for the 3-2-1 display). */
  get countdownMs(): number {
    return this.countdownLeft * this.dtMs;
  }

  /** Advances one physics tick. */
  step(): RaceEvent[] {
    if (this.phase === 'countdown') {
      this.countdownLeft--;
      if (this.countdownLeft <= 0) {
        // The car already drives during the GO tick: it is the first timed tick.
        this.phase = 'running';
        this.ticks = 1;
        return [{ type: 'go' }];
      }
      return [];
    }
    if (this.phase === 'running') this.ticks++;
    return [];
  }

  /**
   * A gate was crossed during the last tick at fraction t of the step
   * (t = 1 → at the end of the tick). `forward` = crossed in the route direction
   * (only matters for the finish). Times are rounded to the millisecond here so
   * every consumer (medals, records, author time, HUD) sees the same value.
   */
  cross(kind: 'checkpoint' | 'finish' | 'start', piece: number, t: number, forward = true): RaceEvent[] {
    if (this.phase !== 'running') return [];
    const ms = Math.round(Math.max(0, (this.ticks - 1 + t) * this.dtMs));
    if (kind === 'checkpoint') {
      if (this.passed.has(piece)) return [];
      this.passed.add(piece);
      this.splits.push(ms);
      this.lastCheckpoint = piece;
      return [{ type: 'checkpoint', piece, index: this.splits.length - 1, ms }];
    }
    if (kind === 'finish') {
      this.finishNet += forward ? 1 : -1;
      if (!forward || this.finishNet < 1) return [];
      if (this.passed.size < this.checkpointCount) return [{ type: 'missingCheckpoints', remaining: this.checkpointCount - this.passed.size }];
      this.finishMs = ms;
      this.phase = 'finished';
      return [{ type: 'finish', ms }];
    }
    return [];
  }
}
