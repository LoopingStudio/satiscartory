import { TRACK_PIECES } from '../data/trackPieces';
import { pieceCells } from './connectors';
import type { TrackData, TrackPiece } from './TrackData';

/** Editor bounds (cells) around the origin. */
export const EDITOR_LIMIT = 48;
export const MAX_LEVEL = 8;

const key = (x: number, z: number) => `${x},${z}`;

/** Indices of the pieces sharing at least one cell with `piece`. */
export function overlapping(track: TrackData, piece: TrackPiece): number[] {
  const cells = new Set(pieceCells(piece).map(([x, z]) => key(x, z)));
  const out: number[] = [];
  track.pieces.forEach((p, i) => {
    if (pieceCells(p).some(([x, z]) => cells.has(key(x, z)))) out.push(i);
  });
  return out;
}

export function inBounds(piece: TrackPiece): boolean {
  return pieceCells(piece).every(([x, z]) => Math.abs(x) <= EDITOR_LIMIT && Math.abs(z) <= EDITOR_LIMIT) && piece.y >= 0 && piece.y <= MAX_LEVEL;
}

/**
 * Places a piece, replacing whatever it overlaps. Only one start is allowed:
 * placing a start removes the previous one. Any edit invalidates the medals
 * (the author must validate the track again).
 */
export function placePiece(track: TrackData, piece: TrackPiece): TrackData {
  if (!TRACK_PIECES[piece.t] || !inBounds(piece)) return track;
  const drop = new Set(overlapping(track, piece));
  if (TRACK_PIECES[piece.t]!.gate === 'start') track.pieces.forEach((p, i) => TRACK_PIECES[p.t]?.gate === 'start' && drop.add(i));
  return { ...track, medals: null, pieces: [...track.pieces.filter((_, i) => !drop.has(i)), { ...piece }] };
}

/** Removes the piece covering cell (x, z), if any. */
export function removeAt(track: TrackData, x: number, z: number): TrackData {
  const idx = track.pieces.findIndex((p) => pieceCells(p).some(([px, pz]) => px === x && pz === z));
  if (idx < 0) return track;
  return { ...track, medals: null, pieces: track.pieces.filter((_, i) => i !== idx) };
}

export function pieceAt(track: TrackData, x: number, z: number): TrackPiece | null {
  return track.pieces.find((p) => pieceCells(p).some(([px, pz]) => px === x && pz === z)) ?? null;
}

/** Undo stack of track snapshots (pieces only). */
export class History {
  private stack: TrackPiece[][] = [];
  push(track: TrackData): void {
    this.stack.push(track.pieces.map((p) => ({ ...p })));
    if (this.stack.length > 100) this.stack.shift();
  }
  undo(track: TrackData): TrackData | null {
    const prev = this.stack.pop();
    return prev ? { ...track, medals: null, pieces: prev } : null;
  }
  get size(): number {
    return this.stack.length;
  }
}
