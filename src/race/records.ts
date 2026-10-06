/** Personal best on a track. */
export interface TrackRecord {
  bestMs: number | null;
  /** Checkpoint split times of the best run (ms from start, in crossing order). */
  splits: number[];
  /** Car used for the best run. */
  carId?: string | null;
  attempts: number;
}

/** Records a finished run; returns whether it is a new personal best and the previous best. */
export function submitRun(
  records: Record<string, TrackRecord>,
  trackId: string,
  ms: number,
  splits: number[],
  carId: string | null,
): { improved: boolean; previous: number | null } {
  const rec = (records[trackId] ??= { bestMs: null, splits: [], carId: null, attempts: 0 });
  rec.attempts++;
  const previous = rec.bestMs;
  if (previous === null || ms < previous) {
    rec.bestMs = Math.round(ms);
    rec.splits = splits.map((s) => Math.round(s));
    rec.carId = carId;
    return { improved: true, previous };
  }
  return { improved: false, previous };
}

/** Counts an attempt that was not finished (restart / quit). */
export function countAttempt(records: Record<string, TrackRecord>, trackId: string): void {
  const rec = (records[trackId] ??= { bestMs: null, splits: [], carId: null, attempts: 0 });
  rec.attempts++;
}
