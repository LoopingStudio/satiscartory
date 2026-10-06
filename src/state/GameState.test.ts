import { describe, expect, it } from 'vitest';
import { GameState } from './GameState';
import { FACTORY_CELL } from '../config/constants';
import { LEGACY_MAP_OFFSET } from '../data/factoryMap';
import { TIERS } from '../data/tiers';

describe('GameState migrations', () => {
  it('moves the player with the factory when loading a save from the 64×64 map', () => {
    const data = new GameState().serialize();
    data.factory.version = 2;
    data.factory.buildings = [{ type: 'hub', id: 1, x: 30, z: 30, rot: 0 }];
    data.player = { x: 63, y: 0.1, z: 54, yaw: 0 };
    const s = GameState.fromSave(data);
    const shift = LEGACY_MAP_OFFSET * FACTORY_CELL;
    expect(s.player).toEqual({ x: 63 + shift, y: 0.1, z: 54 + shift, yaw: 0 });
    // a current save is left untouched
    const again = GameState.fromSave(s.serialize());
    expect(again.player).toEqual(s.player);
  });
});

describe('GameState tiers', () => {
  const reload = (s: GameState) => GameState.fromSave(JSON.parse(JSON.stringify(s.serialize())));

  it('a new game starts at tier 0 with an empty hub and backpack', () => {
    const s = new GameState();
    expect(s.tier).toBe(0);
    expect(s.sim.storage).toEqual({});
    expect(s.inventory.usedSlots).toBe(0);
    expect(s.isUnlocked('hub')).toBe(true);
    expect(s.isUnlocked('drill')).toBe(false);
  });

  it('round-trips through the save', () => {
    for (let t = 0; t <= TIERS.length; t++) {
      const s = new GameState();
      s.tier = t;
      expect(reload(s).tier).toBe(t);
    }
  });

  it('a save from before the tiers keeps everything unlocked', () => {
    const data = new GameState().serialize();
    delete data.tier;
    const s = GameState.fromSave(data);
    expect(s.tier).toBe(TIERS.length);
    expect(TIERS.flatMap((t) => t.unlocks).every((b) => s.isUnlocked(b))).toBe(true);
  });

  it('garbage tier values are clamped', () => {
    const load = (tier: unknown) => GameState.fromSave({ ...new GameState().serialize(), tier: tier as number }).tier;
    expect(load(-3)).toBe(0);
    expect(load(99)).toBe(TIERS.length);
    expect(load(2.7)).toBe(2);
    // not a number: treated like a save without tiers
    expect(load(NaN)).toBe(TIERS.length);
    expect(load(Infinity)).toBe(TIERS.length);
    expect(load('2')).toBe(TIERS.length);
    expect(load(null)).toBe(TIERS.length);
  });

  it('replaceWith copies the tier', () => {
    const a = new GameState();
    const b = new GameState();
    b.tier = 3;
    a.replaceWith(b);
    expect(a.tier).toBe(3);
    expect(a.isUnlocked('press')).toBe(true);
    expect(a.isUnlocked('assembler')).toBe(false);
  });

  it('unlockNextTier reports what is missing and changes nothing when unaffordable', () => {
    const s = new GameState();
    s.inventory.add('iron_rod', 4);
    s.sim.give({ iron_rod: 2 });
    const before = { inv: s.inventory.serialize(), hub: { ...s.sim.storage } };
    expect(s.unlockNextTier()).toEqual({ ok: false, missing: { iron_rod: TIERS[0]!.cost.iron_rod! - 6 } });
    expect(s.tier).toBe(0);
    expect({ inv: s.inventory.serialize(), hub: { ...s.sim.storage } }).toEqual(before);
  });

  it('unlockNextTier pays backpack first, then hub, one tier at a time', () => {
    const s = new GameState();
    const cost = TIERS[0]!.cost.iron_rod!;
    s.inventory.add('iron_rod', cost - 3);
    s.sim.give({ iron_rod: 5 });
    expect(s.unlockNextTier()).toEqual({ ok: true });
    expect(s.tier).toBe(1);
    expect(s.inventory.count('iron_rod')).toBe(0);
    expect(s.sim.count('iron_rod')).toBe(2);
    expect(s.isUnlocked('drill')).toBe(true);
    expect(s.isUnlocked('smelter')).toBe(false);
    // the next tier costs more than what is left
    expect(s.unlockNextTier().ok).toBe(false);
    expect(s.tier).toBe(1);
  });

  it('unlockNextTier refuses when every tier is unlocked', () => {
    const s = new GameState();
    s.tier = TIERS.length;
    s.sim.give({ plate: 1000, iron_rod: 1000, bolt: 1000, tire: 1000 });
    const hub = { ...s.sim.storage };
    expect(s.unlockNextTier()).toEqual({ ok: false });
    expect(s.tier).toBe(TIERS.length);
    expect(s.sim.storage).toEqual(hub);
  });
});
