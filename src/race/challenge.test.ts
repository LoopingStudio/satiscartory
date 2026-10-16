import { describe, expect, it } from 'vitest';
import { GHOST_STEP_MS, GhostRecorder, ghostPoseAt, unpackGhost } from './ghost';
import { challengeKey, challengeTrack, sanitizeChallenge, type Challenge } from './challenge';
import { decodeShare, encodeShare, shareKindOf, shareLink } from '../share/codec';
import { emptyTrack, type TrackData } from '../track/TrackData';
import { GameState } from '../state/GameState';

function lap(): GhostRecorder {
  const r = new GhostRecorder();
  // 60 Hz steps over 10 s along +X at 30 m/s, turning slowly.
  for (let i = 0; i <= 600; i++) {
    const t = (i * 1000) / 60;
    const a = t / 20000;
    r.push(t, { x: 30 * (t / 1000), y: 0.5, z: -12.25 }, { x: 0, y: Math.sin(a), z: 0, w: Math.cos(a) });
  }
  return r;
}

const track = (over: Partial<TrackData> = {}): TrackData => ({ ...emptyTrack('mine-1', 'Boucle de Léa'), pieces: [{ t: 'start', x: 0, z: 0, y: 0, r: 0 }], ...over });

function challenge(over: Partial<Challenge> = {}): Challenge {
  return {
    format: 'satiscartory-defi', version: 1, from: 'Léa', track: track(), car: { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } },
    carName: 'Kart Oopi n°1', timeMs: 21745, ghost: lap().pack(), at: 1_790_000_000_000, ...over,
  };
}

describe('ghost', () => {
  it('keeps one pose per step and gives it back interpolated, to the centimeter', () => {
    const r = lap();
    expect(r.count).toBe(101);
    const g = unpackGhost(r.pack())!;
    const p = { x: 0, y: 0, z: 0 };
    const q = { x: 0, y: 0, z: 0, w: 1 };
    ghostPoseAt(g, 2550, p, q);
    expect(p.x).toBeCloseTo(76.5, 1);
    expect(p.y).toBeCloseTo(0.5, 2);
    expect(p.z).toBeCloseTo(-12.25, 2);
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 5);
    // Held at the last pose past the end, at the first before the GO.
    ghostPoseAt(g, 99_999, p, q);
    expect(p.x).toBeCloseTo(300, 1);
    ghostPoseAt(g, -5, p, q);
    expect(p.x).toBe(0);
  });

  it('refuses broken packs', () => {
    expect(unpackGhost(null)).toBeNull();
    expect(unpackGhost({ step: GHOST_STEP_MS, p: [1, 2], q: [] })).toBeNull();
    expect(unpackGhost({ step: 50, p: [0, 0, 0], q: [0, 0, 0, 1000] })).toBeNull();
    expect(unpackGhost({ step: GHOST_STEP_MS, p: [0, 0.5, 0], q: [0, 0, 0, 1000] })).toBeNull();
  });
});

describe('challenge codes', () => {
  it('round trip through a code and a link, small enough to send', async () => {
    const c = challenge();
    const code = await encodeShare('defi', c);
    expect(shareKindOf(code)).toBe('defi');
    expect(code.length).toBeLessThan(6000);
    const back = sanitizeChallenge(await decodeShare('defi', shareLink('defi', code, 'https://satiscartory.example/?x=1#old')));
    expect(back.from).toBe('Léa');
    expect(back.timeMs).toBe(21745);
    expect(challengeKey(back)).toBe(challengeKey(c));
    // Pasted with line breaks in it.
    expect(sanitizeChallenge(await decodeShare('defi', code.replace(/(.{60})/g, '$1\n'))).timeMs).toBe(21745);
  });

  it('says why a code cannot be read', async () => {
    const world = await encodeShare('monde', { a: 1 });
    await expect(decodeShare('defi', world)).rejects.toThrow(/monde/);
    await expect(decodeShare('defi', 'bonjour')).rejects.toThrow(/pas un code de défi/);
    const code = await encodeShare('defi', challenge());
    await expect(decodeShare('defi', code.slice(0, code.length / 2))).rejects.toThrow(/incomplet/);
    expect(() => sanitizeChallenge({ format: 'satiscartory-defi', version: 1, track: track(), timeMs: 1000, ghost: { step: 1 } })).toThrow(/fantôme/);
    expect(() => sanitizeChallenge({ format: 'other' })).toThrow();
  });

  it('cleans what a friend sent: unknown parts, a long name', () => {
    const c = sanitizeChallenge(challenge({ from: 'x'.repeat(40), car: { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'gold-engine' as never, wheels: 'wheel' } } }));
    expect(c.from.length).toBeLessThanOrEqual(16);
    expect(c.car.parts.engine).toBeUndefined();
  });

  it('an official circuit is this game’s own; an editor circuit is raced apart from the player’s', () => {
    const official = [track({ id: 'oval', name: 'Ovale', builtin: true, pieces: [{ t: 'start', x: 1, z: 1, y: 0, r: 0 }] })];
    expect(challengeTrack(challenge({ track: track({ id: 'oval', builtin: true }) }), official)).toBe(official[0]);
    const theirs = challengeTrack(challenge(), official);
    expect(theirs.id).toBe('defi:mine-1');
    expect(theirs.builtin).toBeUndefined();
  });

  it('received challenges are kept (the same one once), with the save', () => {
    const s = new GameState();
    const a = challenge();
    s.addChallenge(a);
    s.addChallenge({ ...a });
    s.addChallenge(challenge({ from: 'Max', timeMs: 20000 }));
    expect(s.challenges.map((c) => c.from)).toEqual(['Max', 'Léa']);
    const back = GameState.fromSave(JSON.parse(JSON.stringify(s.serialize())));
    expect(back.challenges).toHaveLength(2);
    s.removeChallenge(challengeKey(a));
    expect(s.challenges).toHaveLength(1);
  });
});
