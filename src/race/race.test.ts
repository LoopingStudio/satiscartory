import { describe, expect, it } from 'vitest';
import { crossGate } from './crossing';
import { RaceSession } from './RaceSession';
import { medalFor, medalsFromAuthor } from './medals';
import { submitRun, type TrackRecord } from './records';

const gate = { center: { x: 0, y: 0, z: 0 }, forward: { x: 1, y: 0, z: 0 }, halfWidth: 6, height: 7 };

describe('crossGate', () => {
  it('detects a crossing with its fraction and direction', () => {
    const r = crossGate({ x: -1, y: 0.5, z: 0 }, { x: 3, y: 0.5, z: 1 }, gate);
    expect(r).toEqual({ t: 0.25, dir: 1 });
    expect(crossGate({ x: 3, y: 0.5, z: 0 }, { x: -1, y: 0.5, z: 0 }, gate)?.dir).toBe(-1);
  });
  it('ignores segments beside, above or not reaching the gate', () => {
    expect(crossGate({ x: -1, y: 0, z: 7 }, { x: 1, y: 0, z: 7 }, gate)).toBeNull();
    expect(crossGate({ x: -1, y: 9, z: 0 }, { x: 1, y: 9, z: 0 }, gate)).toBeNull();
    expect(crossGate({ x: -3, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, gate)).toBeNull();
  });
  it('never misses a crossing at 300 km/h (83 m/s → 1.4 m per 60 Hz step)', () => {
    const step = 83.3 / 60;
    let hits = 0;
    for (let i = 0; i < 400; i++) {
      const offset = (i / 400) * step;
      let x = -10 + offset;
      while (x < 10) {
        if (crossGate({ x, y: 0, z: 0.5 }, { x: x + step, y: 0, z: 0.5 }, gate)) hits++;
        x += step;
      }
    }
    expect(hits).toBe(400);
  });
});

describe('RaceSession', () => {
  const dt = 1000 / 60;
  it('counts down, then times the run with sub-tick precision', () => {
    const s = new RaceSession(1, dt, 90);
    for (let i = 0; i < 89; i++) expect(s.step()).toEqual([]);
    expect(s.step()).toEqual([{ type: 'go' }]);
    expect(s.phase).toBe('running');
    // the GO tick is the first timed tick
    expect(s.timeMs).toBeCloseTo(dt, 5);
    for (let i = 0; i < 119; i++) s.step();
    expect(s.timeMs).toBeCloseTo(2000, 5);
    const ev = s.cross('checkpoint', 7, 0.5);
    expect(ev[0]).toMatchObject({ type: 'checkpoint', piece: 7, index: 0 });
    expect((ev[0] as { ms: number }).ms).toBe(Math.round(119.5 * dt));
    expect(s.lastCheckpoint).toBe(7);
  });

  it('requires every checkpoint (any order) before the finish counts', () => {
    const s = new RaceSession(2, dt, 1);
    s.step();
    s.step();
    expect(s.cross('finish', 9, 1)).toEqual([{ type: 'missingCheckpoints', remaining: 2 }]);
    s.cross('checkpoint', 5, 1);
    s.cross('checkpoint', 5, 1); // same CP twice counts once
    expect(s.cross('finish', 9, 1)[0]?.type).toBe('missingCheckpoints');
    s.cross('checkpoint', 3, 1);
    const fin = s.cross('finish', 9, 1);
    expect(fin[0]?.type).toBe('finish');
    expect(s.phase).toBe('finished');
    const t = s.timeMs;
    s.step();
    expect(s.timeMs).toBe(t);
    expect(s.splits).toHaveLength(2);
  });

  it('a finish crossed backwards never counts, even after driving forward through it again', () => {
    const s = new RaceSession(0, dt, 1);
    s.step();
    s.step();
    expect(s.cross('finish', 1, 0.5, false)).toEqual([]);
    expect(s.cross('finish', 1, 0.5, true)).toEqual([]); // net 0: just undid the reverse
    expect(s.phase).toBe('running');
    expect(s.cross('finish', 1, 0.5, true)[0]?.type).toBe('finish'); // a real lap later
  });

  it('rounds times once so medals, records and the HUD agree', () => {
    const s = new RaceSession(0, dt, 1);
    s.step();
    for (let i = 0; i < 738; i++) s.step();
    const ev = s.cross('finish', 1, 0.4, true);
    const ms = (ev[0] as { ms: number }).ms;
    expect(Number.isInteger(ms)).toBe(true);
    expect(s.timeMs).toBe(ms);
  });

  it('ignores gates during the countdown', () => {
    const s = new RaceSession(0, dt, 10);
    expect(s.cross('finish', 1, 1)).toEqual([]);
  });
});

describe('medals & records', () => {
  it('derives thresholds from the author time and awards the best medal', () => {
    const m = medalsFromAuthor(30000);
    expect(m.author).toBe(30000);
    expect(m.gold).toBeGreaterThan(m.author);
    expect(m.silver).toBeGreaterThan(m.gold);
    expect(m.bronze).toBeGreaterThan(m.silver);
    expect(medalFor(29000, m)).toBe('author');
    expect(medalFor(m.gold, m)).toBe('gold');
    expect(medalFor(m.bronze + 1, m)).toBeNull();
    expect(medalFor(10, null)).toBeNull();
  });

  it('keeps the personal best and its splits', () => {
    const rec: Record<string, TrackRecord> = {};
    expect(submitRun(rec, 'oval', 30000, [10000, 20000], 'c1')).toEqual({ improved: true, previous: null });
    expect(submitRun(rec, 'oval', 31000, [9000, 21000], 'c1')).toEqual({ improved: false, previous: 30000 });
    expect(submitRun(rec, 'oval', 29500.4, [9000, 19000], 'c2')).toEqual({ improved: true, previous: 30000 });
    expect(rec.oval).toEqual({ bestMs: 29500, splits: [9000, 19000], carId: 'c2', attempts: 3 });
  });
});
