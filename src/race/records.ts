/** Personal best on a track. */
export interface TrackRecord {
  bestMs: number | null;
  /** Checkpoint split times of the best run (ms from start, in crossing order). */
  splits: number[];
  /** Car used for the best run. */
  carId?: string | null;
  attempts: number;
}
