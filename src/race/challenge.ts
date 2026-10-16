import { blueprintById } from '../data/blueprints';
import { sanitizeLook, cleanName, type CharacterLook } from '../data/character';
import { isItemId } from '../data/items';
import type { CarSpec } from '../car/stats';
import { parseTrack, type TrackData } from '../track/TrackData';
import { unpackGhost, type Ghost, type PackedGhost } from './ghost';

/*
 * Challenges (pure): « Défier un ami » packs a finished run (the circuit, the car, the time, the ghost, who drove it)
 * into a code; the friend races against that ghost and may send theirs back. The circuit travels whole, so a circuit
 * of the editor can be raced by someone who never had it; an official circuit is taken from the friend's own game.
 */

export interface Challenge {
  format: 'satiscartory-defi';
  version: 1;
  /** Who set the time, and their character (the name tag over the ghost). */
  from: string;
  look?: CharacterLook;
  track: TrackData;
  car: CarSpec;
  carName: string;
  timeMs: number;
  ghost: PackedGhost;
  /** When it was set (ms since 1970). */
  at: number;
}

/** A spec from untrusted data: a known blueprint, item ids only (the loaner when broken). */
function sanitizeSpec(raw: unknown): CarSpec {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<CarSpec>;
  const bp = blueprintById(r.blueprint);
  if (!bp) return { blueprint: 'loaner', parts: {} };
  const parts: CarSpec['parts'] = {};
  for (const s of bp.slots) {
    const item = (r.parts as Record<string, unknown> | undefined)?.[s.id];
    if (isItemId(item) && s.accepts.includes(item)) parts[s.id] = item;
  }
  return { blueprint: bp.id, parts };
}

/** A challenge from a friend's code. Throws a French message when it cannot be raced. */
export function sanitizeChallenge(raw: unknown): Challenge {
  const r = raw as Partial<Challenge> | null;
  if (!r || typeof r !== 'object' || r.format !== 'satiscartory-defi') throw new Error('Ce n’est pas un défi Satiscartory');
  if (r.version !== 1) throw new Error('Ce défi vient d’une autre version du jeu');
  const track = parseTrack(r.track);
  if (!track.pieces.length) throw new Error('Le circuit de ce défi est vide');
  const timeMs = typeof r.timeMs === 'number' && Number.isFinite(r.timeMs) && r.timeMs > 0 ? Math.round(r.timeMs) : null;
  if (timeMs === null) throw new Error('Ce défi n’a pas de temps');
  if (!unpackGhost(r.ghost)) throw new Error('Le fantôme de ce défi est abîmé');
  return {
    format: 'satiscartory-defi',
    version: 1,
    from: cleanName(r.from),
    look: sanitizeLook(r.look),
    track,
    car: sanitizeSpec(r.car),
    carName: typeof r.carName === 'string' && r.carName ? r.carName.slice(0, 40) : (blueprintById(r.car?.blueprint)?.name ?? 'Voiture'),
    timeMs,
    ghost: r.ghost as PackedGhost,
    at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0,
  };
}

/** Its ghost, ready to show (sanitizeChallenge checked it). */
export function challengeGhost(c: Challenge): Ghost {
  return unpackGhost(c.ghost)!;
}

/** Same challenge (received twice): same circuit, driver, time and date. */
export function challengeKey(c: Pick<Challenge, 'track' | 'from' | 'timeMs' | 'at'>): string {
  return `${c.track.id}|${c.from}|${c.timeMs}|${c.at}`;
}

/** The circuit to race: an official one from this game when the challenge names one, else the one it carries. */
export function challengeTrack(c: Challenge, official: readonly TrackData[]): TrackData {
  if (c.track.builtin) {
    const mine = official.find((t) => t.id === c.track.id);
    if (mine) return mine;
  }
  // A circuit of the editor (or an official one this game lacks): raced as it came, never mixed with the player's own.
  return { ...c.track, id: `defi:${c.track.id}`, builtin: undefined };
}
