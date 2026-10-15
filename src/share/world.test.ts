import { describe, expect, it } from 'vitest';
import { GameState } from '../state/GameState';
import { parseWorld, worldShare } from './world';
import { decodeShare, encodeShare } from './codec';
import { SaveManager } from '../state/SaveManager';

function world(): GameState {
  const s = new GameState();
  s.look = { name: 'Léa', body: 'blue', accent: 'yellow', hat: 'crown' };
  s.player = { x: 120, y: 0, z: 110, yaw: 1 };
  s.sim.give({ plate: 500, iron_rod: 500, bolt: 500 });
  s.tier = 5;
  const g = s.sim.place('garage', 70, 50, 0);
  if (!g.ok) throw new Error(g.check.error);
  s.cars = [{ id: 'k1', name: 'Kart Oopi n°1', blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' }, pose: null, wear: { wheels: 300 } }];
  s.settings.mouseSensitivity = 2.5;
  return s;
}

describe('sharing a world', () => {
  it('round trips through a code: the factory, the cars, who made it; not the sharer’s settings or challenges', async () => {
    const mine = world();
    const share = worldShare(mine);
    expect(share.save.settings).toBeUndefined();
    expect(share.save.challenges).toBeUndefined();
    const code = await encodeShare('monde', share);
    expect(code.length).toBeLessThan(40_000);
    const { state, visit } = parseWorld(await decodeShare('monde', code));
    expect(visit.from).toBe('Léa');
    expect(visit.look.hat).toBe('crown');
    expect(visit.player).toEqual({ x: 120, y: 0, z: 110, yaw: 1 });
    expect(state.sim.buildings.size).toBe(mine.sim.buildings.size);
    expect(state.cars[0]!.wear).toEqual({ wheels: 300 });
    expect(state.tier).toBe(5);
    // The visitor arrives at the spawn; the visit is never saved.
    expect(state.player).toBeNull();
    expect(state.ephemeral).toBe(true);
    expect(state.visit?.from).toBe('Léa');
    expect(SaveManager.save(state)).toBe(false);
  });

  it('refuses what is not a world', async () => {
    expect(() => parseWorld({ format: 'satiscartory-defi' })).toThrow(/pas un monde/);
    expect(() => parseWorld({ format: 'satiscartory-monde', version: 2 })).toThrow(/autre version/);
    expect(() => parseWorld({ format: 'satiscartory-monde', version: 1, save: { version: 1 } })).toThrow(/abîmé/);
    const challengeCode = await encodeShare('defi', { x: 1 });
    await expect(decodeShare('monde', challengeCode)).rejects.toThrow(/défi/);
  });

  it('a visit put in place keeps the visit; the visitor’s own game is not touched', () => {
    const own = new GameState();
    own.look = { name: 'Max', body: 'red', accent: 'teal', hat: 'none' };
    const { state: friend } = parseWorld(JSON.parse(JSON.stringify(worldShare(world()))));
    friend.look = own.look;
    own.replaceWith(friend);
    expect(own.visit?.from).toBe('Léa');
    expect(own.ephemeral).toBe(true);
    expect(own.look.name).toBe('Max');
  });
});

describe('what a shared world carries is cleaned', () => {
  it('car names lose any markup (they show in HTML hints)', () => {
    const w = worldShare(world());
    w.save.cars![0]!.name = '<img src=x onerror=alert(1)>Kart';
    const { state } = parseWorld(JSON.parse(JSON.stringify(w)));
    expect(state.cars[0]!.name).toBe('img src=x onerror=alert(1)Kart');
    expect(state.cars[0]!.name).not.toMatch(/[<>]/);
  });
});
