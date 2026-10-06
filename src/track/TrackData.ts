import { TRACK_PIECES } from '../data/trackPieces';

export interface TrackPiece {
  /** Piece id (see data/trackPieces.ts). */
  t: string;
  x: number;
  z: number;
  /** Base height level (1 level = 0.25 tile). */
  y: number;
  /** Rotation in quarter turns (0..3). */
  r: number;
}

export interface Medals {
  author: number;
  gold: number;
  silver: number;
  bronze: number;
}

export interface TrackData {
  format: 'satiscartory-track';
  version: 1;
  id: string;
  name: string;
  author: string;
  pieces: TrackPiece[];
  /** Medal times in ms (null until the author validated the track). */
  medals: Medals | null;
  /** Shipped with the game (not editable). */
  builtin?: boolean;
}

export function emptyTrack(id: string, name: string): TrackData {
  return { format: 'satiscartory-track', version: 1, id, name, author: 'Moi', pieces: [], medals: null };
}

/** Validates/normalizes untrusted JSON (localStorage, paste). Throws on garbage. */
export function parseTrack(raw: unknown): TrackData {
  const d = raw as Partial<TrackData>;
  if (!d || typeof d !== 'object' || d.format !== 'satiscartory-track') throw new Error('Format de circuit inconnu');
  if (d.version !== 1) throw new Error(`Version de circuit non supportée : ${String(d.version)}`);
  if (!Array.isArray(d.pieces)) throw new Error('Circuit sans pièces');
  const pieces: TrackPiece[] = [];
  for (const p of d.pieces) {
    if (!p || typeof p !== 'object' || !TRACK_PIECES[p.t]) continue;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);
    pieces.push({ t: p.t, x: n(p.x), z: n(p.z), y: Math.max(0, Math.min(12, n(p.y))), r: ((n(p.r) % 4) + 4) % 4 });
  }
  const m = d.medals;
  const medals =
    m && typeof m === 'object' && [m.author, m.gold, m.silver, m.bronze].every((v) => typeof v === 'number' && v > 0)
      ? { author: m.author, gold: m.gold, silver: m.silver, bronze: m.bronze }
      : null;
  return {
    format: 'satiscartory-track',
    version: 1,
    id: typeof d.id === 'string' && d.id ? d.id : `t-${pieces.length}`,
    name: typeof d.name === 'string' && d.name ? d.name.slice(0, 40) : 'Sans nom',
    author: typeof d.author === 'string' ? d.author.slice(0, 30) : 'Inconnu',
    pieces,
    medals,
    builtin: d.builtin === true ? true : undefined,
  };
}
