import { describe, expect, it } from 'vitest';
import { analyzeTrack } from './validate';
import { parseTrack, type TrackData, type TrackPiece } from './TrackData';
import { pieceConnectors, pieceCells } from './connectors';

const track = (pieces: TrackPiece[]): TrackData => ({ format: 'satiscartory-track', version: 1, id: 't', name: 'T', author: 'a', pieces, medals: null });
const P = (t: string, x: number, z: number, r = 0, y = 0): TrackPiece => ({ t, x, z, y, r });

/** Closed rectangle: start (1,0) → (2,0) → bend (3,0) → cp (3,1) → bend (3,2) → (2,2) → finish (1,2) → bend (0,2) → (0,1) → bend (0,0). */
export const LOOP = () =>
  track([
    P('start', 1, 0, 0),
    P('straight', 2, 0, 0),
    P('bend', 3, 0, 0),
    P('checkpoint', 3, 1, 1),
    P('bend', 3, 2, 3),
    P('straight', 2, 2, 0),
    P('finish', 1, 2, 0),
    P('bend', 0, 2, 2),
    P('straight', 0, 1, 1),
    P('bend', 0, 0, 1),
  ]);

describe('track connectors', () => {
  it('rotating a straight by one turn makes it run along Z', () => {
    const c = pieceConnectors(P('straight', 5, 5, 1), 0).map((c) => c.side).sort();
    expect(c).toEqual([0, 2]);
  });
  it('a 2x2 curve covers 4 cells and its connectors rotate with it', () => {
    expect(pieceCells(P('curve', 1, 1, 1))).toHaveLength(4);
    const c = pieceConnectors(P('curve', 1, 1, 1), 0);
    expect(c).toContainEqual(expect.objectContaining({ cx: 1, cz: 2, side: 0 }));
    expect(c).toContainEqual(expect.objectContaining({ cx: 2, cz: 1, side: 1 }));
  });
  it('slopes connect a low side to a higher level', () => {
    const c = pieceConnectors(P('slope', 0, 0, 0, 2), 0);
    expect(c.find((x) => x.side === 3)!.level).toBe(2);
    expect(c.find((x) => x.side === 1)!.level).toBe(3);
  });
});

describe('analyzeTrack', () => {
  it('accepts a straight line start → cp → finish', () => {
    const a = analyzeTrack(track([P('start', 0, 0), P('straight', 1, 0), P('checkpoint', 2, 0), P('finish', 3, 0)]));
    expect(a.ok).toBe(true);
    expect(a.path).toEqual([0, 1, 2, 3]);
  });

  it('accepts a closed loop with bends and a checkpoint', () => {
    const a = analyzeTrack(LOOP());
    expect(a.issues).toEqual([]);
    expect(a.path.length).toBe(7);
  });

  it('follows a 2x2 curve', () => {
    const a = analyzeTrack(track([P('start', 0, 0), P('curve', 1, 0, 0), P('checkpoint', 2, 2, 1), P('finish', 2, 3, 1)]));
    expect(a.issues).toEqual([]);
  });

  it('climbs with slopes and requires matching levels', () => {
    const ok = analyzeTrack(track([P('start', 0, 0), P('slope', 1, 0), P('checkpoint', 2, 0, 0, 1), P('finish', 3, 0, 0, 1)]));
    expect(ok.issues).toEqual([]);
    const bad = analyzeTrack(track([P('start', 0, 0), P('slope', 1, 0), P('checkpoint', 2, 0, 0, 0), P('finish', 3, 0, 0, 0)]));
    expect(bad.ok).toBe(false);
    expect(bad.issues.map((i) => i.code)).toContain('openEnd');
  });

  it('reports missing start/finish, overlaps, broken links and off-path checkpoints', () => {
    expect(analyzeTrack(track([P('finish', 0, 0)])).issues.map((i) => i.code)).toContain('noStart');
    expect(analyzeTrack(track([P('start', 0, 0)])).issues.map((i) => i.code)).toContain('noFinish');
    expect(analyzeTrack(track([P('start', 0, 0), P('finish', 0, 0)])).issues.map((i) => i.code)).toContain('overlap');
    const gap = analyzeTrack(track([P('start', 0, 0), P('checkpoint', 1, 0), P('finish', 3, 0)]));
    expect(gap.issues.map((i) => i.code)).toContain('openEnd');
    const offPath = analyzeTrack(track([P('start', 0, 0), P('finish', 1, 0), P('checkpoint', 5, 5)]));
    expect(offPath.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['finishUnreachable']));
    const backwards = analyzeTrack(track([P('start', 1, 0, 2), P('checkpoint', 3, 0), P('finish', 2, 0)]));
    expect(backwards.issues.map((i) => i.code)).toContain('startBlocked');
    expect(analyzeTrack(track([P('start', 0, 0), P('finish', 1, 0)])).issues.map((i) => i.code)).toContain('noCheckpoint');
  });

  it('drives through a finish reached before every checkpoint (the race ignores it then)', () => {
    // start → finish → cp → … the first finish pass does not end the route
    const t = track([P('start', 0, 0), P('finish', 1, 0), P('checkpoint', 2, 0), P('straight', 3, 0)]);
    const a = analyzeTrack(t);
    expect(a.issues.map((i) => i.code)).toContain('openEnd');
    const loop = LOOP();
    loop.pieces[1] = P('finish', 2, 0, 0); // finish right after the start, checkpoint later in the loop
    loop.pieces[6] = P('straight', 1, 2, 0);
    expect(analyzeTrack(loop).issues.map((i) => i.code)).toContain('loopWithoutFinish');
  });

  it('detects a loop that never reaches the finish', () => {
    const t = LOOP();
    t.pieces[6] = P('straight', 1, 2, 0);
    t.pieces.push(P('finish', 10, 10));
    expect(analyzeTrack(t).issues.map((i) => i.code)).toContain('loopWithoutFinish');
  });
});

describe('parseTrack', () => {
  it('normalizes untrusted JSON and drops unknown pieces', () => {
    const t = parseTrack({ format: 'satiscartory-track', version: 1, name: 'x', pieces: [{ t: 'start', x: 1.4, z: 2, y: -3, r: 5 }, { t: 'nope', x: 0, z: 0 }], medals: { author: 1 } });
    expect(t.pieces).toEqual([{ t: 'start', x: 1, z: 2, y: 0, r: 1 }]);
    expect(t.medals).toBeNull();
    expect(() => parseTrack({ format: 'other' })).toThrow();
  });
});
