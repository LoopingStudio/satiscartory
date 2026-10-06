import type { TrackData, TrackPiece } from '../track/TrackData';

const P = (t: string, x: number, z: number, r = 0, y = 0): TrackPiece => ({ t, x, z, y, r });

/** Dev test strip: straights, a slope up/down, a big curve and a jump ramp. */
export const TEST_TRACK: TrackData = {
  format: 'satiscartory-track',
  version: 1,
  id: 'dev-test',
  name: 'Piste d’essai',
  author: 'Satiscartory',
  builtin: true,
  medals: null,
  pieces: [
    P('start', 0, 0),
    P('straight', 1, 0),
    P('straight', 2, 0),
    P('straight', 3, 0),
    P('slope', 4, 0),
    P('straight', 5, 0, 0, 1),
    P('straight', 6, 0, 0, 1),
    P('slope', 7, 0, 2),
    P('straight', 8, 0),
    P('curve', 9, 0, 0),
    P('straight', 10, 2, 1),
    P('straight', 10, 3, 1),
    P('checkpoint', 10, 4, 1),
    P('straight', 10, 5, 1),
    P('slope-high', 10, 6, 3), // r=3: uphill toward +Z
    // gap: jump over (10, 7) and land on (10, 8)
    P('straight', 10, 8, 1),
    P('straight', 10, 9, 1),
    P('finish', 10, 10, 1),
  ],
};

/** Dev drag strip: 60 straight tiles (720 m) to check top speeds. */
export const DRAG_TRACK: TrackData = {
  format: 'satiscartory-track',
  version: 1,
  id: 'dev-drag',
  name: 'Ligne droite (dev)',
  author: 'Satiscartory',
  builtin: true,
  medals: null,
  pieces: [P('start', 0, 0), ...Array.from({ length: 58 }, (_, i) => P('straight-barrier', i + 1, 0)), P('finish', 59, 0)],
};

/** Dev skid pad: 12×12 paved tiles (144 m square) for handling tests. */
export const PAD_TRACK: TrackData = {
  format: 'satiscartory-track',
  version: 1,
  id: 'dev-pad',
  name: 'Aire d’essai (dev)',
  author: 'Satiscartory',
  builtin: true,
  medals: null,
  pieces: Array.from({ length: 144 }, (_, i) => P(i === 6 ? 'start' : 'straight', Math.floor(i / 12), i % 12)),
};

export const DEV_TRACKS: Record<string, TrackData> = { test: TEST_TRACK, drag: DRAG_TRACK, pad: PAD_TRACK };
