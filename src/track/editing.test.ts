import { describe, expect, it } from 'vitest';
import { History, placePiece, removeAt, pieceAt, overlapping } from './editing';
import { emptyTrack } from './TrackData';
import { analyzeTrack } from './validate';

describe('track editing', () => {
  it('places, replaces and removes pieces; edits clear medals', () => {
    let t = emptyTrack('x', 'X');
    t.medals = { author: 1, gold: 2, silver: 3, bronze: 4 };
    t = placePiece(t, { t: 'straight', x: 0, z: 0, y: 0, r: 0 });
    expect(t.medals).toBeNull();
    t = placePiece(t, { t: 'curve', x: 0, z: 0, y: 0, r: 0 }); // 2x2 replaces the straight
    expect(t.pieces).toHaveLength(1);
    expect(pieceAt(t, 1, 1)?.t).toBe('curve');
    expect(overlapping(t, { t: 'straight', x: 1, z: 1, y: 0, r: 0 })).toEqual([0]);
    t = removeAt(t, 1, 1);
    expect(t.pieces).toHaveLength(0);
  });

  it('keeps a single start', () => {
    let t = emptyTrack('x', 'X');
    t = placePiece(t, { t: 'start', x: 0, z: 0, y: 0, r: 0 });
    t = placePiece(t, { t: 'start', x: 5, z: 5, y: 0, r: 1 });
    expect(t.pieces.filter((p) => p.t === 'start')).toEqual([{ t: 'start', x: 5, z: 5, y: 0, r: 1 }]);
  });

  it('rejects out-of-bounds placements and undoes edits', () => {
    let t = emptyTrack('x', 'X');
    expect(placePiece(t, { t: 'straight', x: 999, z: 0, y: 0, r: 0 }).pieces).toHaveLength(0);
    const h = new History();
    h.push(t);
    t = placePiece(t, { t: 'straight', x: 0, z: 0, y: 0, r: 0 });
    h.push(t);
    t = placePiece(t, { t: 'straight', x: 1, z: 0, y: 0, r: 0 });
    t = h.undo(t)!;
    expect(t.pieces).toHaveLength(1);
    t = h.undo(t)!;
    expect(t.pieces).toHaveLength(0);
    expect(h.undo(t)).toBeNull();
  });

  it('builds a valid closed track piece by piece', () => {
    let t = emptyTrack('x', 'X');
    for (const p of [
      { t: 'start', x: 0, z: 0, y: 0, r: 0 },
      { t: 'slope', x: 1, z: 0, y: 0, r: 0 },
      { t: 'straight', x: 2, z: 0, y: 1, r: 0 },
      { t: 'slope', x: 3, z: 0, y: 0, r: 2 },
      { t: 'curve', x: 4, z: 0, y: 0, r: 0 },
      { t: 'checkpoint', x: 5, z: 2, y: 0, r: 1 },
      { t: 'finish', x: 5, z: 3, y: 0, r: 1 },
    ]) t = placePiece(t, p);
    expect(analyzeTrack(t).ok).toBe(true);
  });
});
