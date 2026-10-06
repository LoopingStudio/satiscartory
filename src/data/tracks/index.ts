import { parseTrack, type TrackData } from '../../track/TrackData';

const files = import.meta.glob('./*.json', { eager: true, import: 'default' });

/** Tracks shipped with the game, in campaign order. */
export const BUILTIN_ORDER = ['oval', 'hill'];

export const BUILTIN_TRACKS: TrackData[] = Object.values(files)
  .map((raw) => ({ ...parseTrack(raw), builtin: true }))
  .sort((a, b) => {
    const ia = BUILTIN_ORDER.indexOf(a.id);
    const ib = BUILTIN_ORDER.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
