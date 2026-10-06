import { parseTrack, type TrackData } from '../track/TrackData';
import { BUILTIN_TRACKS } from '../data/tracks';

const KEY = 'satiscartory.tracks.v1';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** User-made tracks (localStorage) + builtin tracks. */
export const TrackStore = {
  userTracks(): TrackData[] {
    const raw = storage()?.getItem(KEY);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw) as unknown[];
      const out: TrackData[] = [];
      for (const t of arr) {
        try {
          out.push({ ...parseTrack(t), builtin: undefined });
        } catch {
          /* skip broken entries */
        }
      }
      return out;
    } catch {
      return [];
    }
  },

  all(): TrackData[] {
    return [...BUILTIN_TRACKS, ...this.userTracks()];
  },

  get(id: string): TrackData | null {
    return this.all().find((t) => t.id === id) ?? null;
  },

  save(track: TrackData): void {
    const list = this.userTracks().filter((t) => t.id !== track.id);
    list.push({ ...track, builtin: undefined });
    storage()?.setItem(KEY, JSON.stringify(list));
  },

  remove(id: string): void {
    storage()?.setItem(KEY, JSON.stringify(this.userTracks().filter((t) => t.id !== id)));
  },

  newId(): string {
    return `u-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
  },
};
