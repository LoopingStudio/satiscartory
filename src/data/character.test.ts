import { describe, expect, it } from 'vitest';
import { ACCENT_COLORS, BODY_COLORS, DEFAULT_LOOK, HATS, NAME_MAX, cleanName, randomLook, sanitizeLook } from './character';
import { GameState } from '../state/GameState';

describe('character look', () => {
  it('cleans names: trimmed, collapsed, control characters out, capped, never empty', () => {
    expect(cleanName('  Léa   la   pilote ')).toBe('Léa la pilote');
    expect(cleanName('a\nb\tc')).toBe('a b c');
    expect(cleanName('x'.repeat(40))).toHaveLength(NAME_MAX);
    expect(cleanName('   ')).toBe(DEFAULT_LOOK.name);
    expect(cleanName(42)).toBe(DEFAULT_LOOK.name);
  });

  it('sanitizes a look from a save or a shared code', () => {
    expect(sanitizeLook(undefined)).toEqual(DEFAULT_LOOK);
    expect(sanitizeLook({ name: 'Max', body: 'red', accent: 'nope', hat: 'sombrero' })).toEqual({ name: 'Max', body: 'red', accent: DEFAULT_LOOK.accent, hat: DEFAULT_LOOK.hat });
    expect(sanitizeLook('junk')).toEqual(DEFAULT_LOOK);
  });

  it('the default look is the mascot as made (first colors of each palette)', () => {
    expect(DEFAULT_LOOK.body).toBe(BODY_COLORS[0]!.id);
    expect(DEFAULT_LOOK.accent).toBe(ACCENT_COLORS[0]!.id);
    expect(HATS[0]!.id).toBe('none');
  });

  it('a random look keeps the name and only uses known values', () => {
    let i = 0;
    const seq = [0.99, 0.5, 0.2];
    const look = randomLook('Sam', () => seq[i++ % seq.length]!);
    expect(look.name).toBe('Sam');
    expect(sanitizeLook(look)).toEqual(look);
  });

  it('is saved with the game and restored', () => {
    const s = new GameState();
    s.look = { name: 'Nina', body: 'blue', accent: 'yellow', hat: 'crown' };
    const back = GameState.fromSave(JSON.parse(JSON.stringify(s.serialize())));
    expect(back.look).toEqual(s.look);
    // A save from before the customization: the default look.
    const old = s.serialize();
    delete old.look;
    expect(GameState.fromSave(old).look).toEqual(DEFAULT_LOOK);
  });
});
