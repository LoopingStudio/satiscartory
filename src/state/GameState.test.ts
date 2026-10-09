import { describe, expect, it } from 'vitest';
import { GameState } from './GameState';
import { FACTORY_CELL } from '../config/constants';
import { LEGACY_MAP_OFFSET } from '../data/factoryMap';
import { TIERS } from '../data/tiers';
import { TERRAIN_RULES } from '../data/factoryTerrain';
import { FactorySim } from '../factory/sim/FactorySim';
import { bayPose } from '../garage/parking';

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

describe('GameState credits', () => {
  const reload = (s: GameState) => GameState.fromSave(JSON.parse(JSON.stringify(s.serialize())));
  const KART = { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } as const;

  it('credits and sales live in the sim: saved, reloaded, carried by replaceWith', () => {
    const s = new GameState();
    expect([s.sim.credits, s.sim.sales]).toEqual([0, {}]);
    s.sim.sell('kart', KART);
    const r = reload(s);
    expect([r.sim.credits, r.sim.sales]).toEqual([4480, { kart: 1 }]);
    const a = new GameState();
    a.replaceWith(r);
    expect([a.sim.credits, a.sim.carsSold]).toEqual([4480, 1]);
  });

  it('a save from before the dealer starts with no credits', () => {
    const data = new GameState().serialize();
    delete data.factory.credits;
    delete data.factory.sales;
    const s = GameState.fromSave(data);
    expect([s.sim.credits, s.sim.sales, s.sim.carsSold]).toEqual([0, {}, 0]);
  });

  it('a save that had every tier of its version gets Commerce (tier 6) for free, the others pay for it', () => {
    const load = (tier: number, tierMax?: number) => {
      const data = new GameState().serialize();
      data.tier = tier;
      if (tierMax === undefined) delete data.tierMax;
      else data.tierMax = tierMax;
      return GameState.fromSave(data);
    };
    expect(TIERS.length).toBe(6);
    expect(load(5, 5).tier).toBe(6);
    expect(load(5, 5).isUnlocked('dealer')).toBe(true);
    expect(load(4, 5).tier).toBe(4);
    expect(load(5, 6).tier).toBe(5);
    expect(load(5, 6).isUnlocked('dealer')).toBe(false);
    // Before tierMax was saved, a full save had 4 tiers.
    expect(load(4).tier).toBe(6);
    expect(new GameState().serialize().tierMax).toBe(6);
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

describe('GameState on the relief', () => {
  it('the « Herbe » setting defaults to medium and falls back to it when invalid', () => {
    const data = new GameState().serialize();
    data.settings = { ...data.settings };
    delete (data.settings as Record<string, unknown>).grass;
    expect(GameState.fromSave(data).settings.grass).toBe('medium');
    expect(GameState.fromSave({ ...data, settings: { ...data.settings, grass: 'ultra' as never } }).settings.grass).toBe('medium');
    expect(GameState.fromSave({ ...data, settings: { ...data.settings, grass: 'off' } }).settings.grass).toBe('off');
  });

  it('a save from before the relief: a car left in the lake waits for a bay, a player deep in it starts at the spawn', () => {
    const data = new GameState().serialize();
    data.factory.version = 3;
    delete data.factory.terrain;
    const s0 = new GameState();
    const lake = s0.sim.terrain.lake!;
    const x = lake.x * FACTORY_CELL;
    const z = lake.z * FACTORY_CELL;
    data.cars = [
      { id: 'wet', name: 'Wet', blueprint: 'kart', parts: {}, pose: { x, y: 0, z, yaw: 0 } },
      { id: 'dry', name: 'Dry', blueprint: 'kart', parts: {}, pose: { x: 127, y: 0, z: 110, yaw: 0 } },
    ];
    data.player = { x, y: 0.1, z, yaw: 0 };
    const s = GameState.fromSave(data);
    expect(s.sim.terrain.id).toBe('vallonne-1');
    expect(s.cars.find((c) => c.id === 'wet')!.pose).toBeNull();
    expect(s.cars.find((c) => c.id === 'dry')!.pose).toEqual({ x: 127, y: 0, z: 110, yaw: 0 });
    expect(s.player).toBeNull();
  });

  it('a save from before the relief: its cars stand on the ground, on a hill or on their garage’s new pad', () => {
    const relief = new GameState().sim;
    const t = relief.terrain;
    // A garage spot off the plateau that the relief raises by 1 m or more.
    let spot: { x: number; z: number } | null = null;
    for (let z = 4; z < 60 && !spot; z += 2) {
      for (let x = 4; x < 60 && !spot; x += 2) {
        const r = relief.check('garage', x, z, 0, { free: true });
        if (r.ok && (r.py ?? 0) >= 100) spot = { x, z };
      }
    }
    expect(spot).not.toBeNull();
    // A gentle hillside 3 m up, away from that garage.
    const g = { gx: 0, gz: 0, twist: 0 };
    let hill: { x: number; z: number } | null = null;
    for (let cz = 70; cz < 124 && !hill; cz++) {
      for (let cx = 4; cx < 124 && !hill; cx++) {
        const x = (cx + 0.5) * FACTORY_CELL;
        const z = (cz + 0.5) * FACTORY_CELL;
        if (t.heightAt(x, z) > 3 && Math.max(Math.abs(t.cellGrad(cx, cz, g).gx), Math.abs(g.gz)) < 40 && !t.isWetCell(cx, cz)) hill = { x, z };
      }
    }
    expect(hill).not.toBeNull();
    const flat = new GameState(FactorySim.newGame({ terrain: 'flat' }));
    expect(flat.sim.place('garage', spot!.x, spot!.z, 0, { free: true }).ok).toBe(true);
    flat.cars = [
      { id: 'bay', name: 'Bay', blueprint: 'kart', parts: {}, pose: bayPose({ x: spot!.x, z: spot!.z, rot: 0 }) },
      { id: 'hill', name: 'Hill', blueprint: 'kart', parts: {}, pose: { x: hill!.x, y: 0, z: hill!.z, yaw: 0 } },
    ];
    const data = flat.serialize();
    data.factory.version = 3;
    delete data.factory.terrain;
    const s = GameState.fromSave(data);
    const garage = [...s.sim.buildings.values()].find((b) => b.type === 'garage')!;
    expect(garage.py).toBeGreaterThanOrEqual(100);
    expect(s.cars.find((c) => c.id === 'bay')!.pose!.y).toBeCloseTo(garage.py! / 100, 6);
    expect(s.cars.find((c) => c.id === 'hill')!.pose!.y).toBeCloseTo(s.sim.terrain.heightAt(hill!.x, hill!.z), 6);
  });

  it('a relief save keeps its cars where they were left, even on a slope too steep for a belt', () => {
    const s0 = new GameState();
    const t = s0.sim.terrain;
    const g = { gx: 0, gz: 0, twist: 0 };
    let cell: [number, number] | null = null;
    for (let cz = 4; cz < 124 && !cell; cz++) {
      for (let cx = 4; cx < 124 && !cell; cx++) {
        const m = Math.max(Math.abs(t.cellGrad(cx, cz, g).gx), Math.abs(g.gz));
        if (m > TERRAIN_RULES.BELT_GRAD && m <= 92 && !t.isWetCell(cx, cz)) cell = [cx, cz];
      }
    }
    expect(cell).not.toBeNull();
    const x = (cell![0] + 0.5) * FACTORY_CELL;
    const z = (cell![1] + 0.5) * FACTORY_CELL;
    const pose = { x, y: t.heightAt(x, z), z, yaw: 0 };
    s0.cars = [{ id: 'c', name: 'C', blueprint: 'kart', parts: {}, pose }];
    const s = GameState.fromSave(JSON.parse(JSON.stringify(s0.serialize())));
    expect(s.cars[0]!.pose).toEqual(pose);
  });
});

describe('GameState: car wear', () => {
  const reload = (s: GameState) => GameState.fromSave(JSON.parse(JSON.stringify(s.serialize())));
  const KART = { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } as const;
  const SPORT = { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' } as const;

  it('round-trips through the save, and replaceWith carries it', () => {
    const s = new GameState();
    s.cars = [{ id: 'a', name: 'A', blueprint: 'sport', parts: { ...SPORT }, pose: null, wear: { wheels: 420, panels: 1000, chassis: 3 } }];
    const r = reload(s);
    expect(r.cars[0]!.wear).toEqual({ wheels: 420, panels: 1000, chassis: 3 });
    const a = new GameState();
    a.replaceWith(r);
    expect(a.cars[0]!.wear).toEqual({ wheels: 420, panels: 1000, chassis: 3 });
    expect(r.serialize().version).toBe(1);
  });

  it('a save from before the wear, and a new car, have no wear key at all', async () => {
    const data = new GameState().serialize();
    data.cars = [{ id: 'old', name: 'Old', blueprint: 'kart', parts: { ...KART }, pose: null }];
    const s = GameState.fromSave(data);
    expect('wear' in s.cars[0]!).toBe(false);
    // Assembled now: new, no key, and none in the save either.
    const { assembleCar } = await import('../garage/actions');
    s.sim.hub.add('chassis', 1);
    s.sim.hub.add('engine', 1);
    s.sim.hub.add('wheel', 4);
    const car = assembleCar(s, 'kart', { ...KART }, { id: 9, x: 40, z: 40, rot: 0 })!;
    expect('wear' in car).toBe(false);
    expect(JSON.stringify(s.serialize().cars)).not.toContain('wear');
    expect('wear' in reload(s).cars.find((c) => c.id === car.id)!).toBe(false);
  });

  it('broken wear data is cleaned: installed parts of the blueprint only, integers in 0..1000, nothing when nothing is left', () => {
    const data = new GameState().serialize();
    data.cars = JSON.parse(JSON.stringify([
      { id: 'a', name: 'A', blueprint: 'sport', parts: { ...SPORT }, wear: { wheels: 420.6, panels: 5000, engine: -8, chassis: 'x', spoiler: 300, turbo: 9 } },
      { id: 'b', name: 'B', blueprint: 'kart', parts: { ...KART }, wear: { wheels: null, engine: 0 } },
      { id: 'c', name: 'C', blueprint: 'kart', parts: { ...KART }, wear: 'worn' },
      { id: 'd', name: 'D', blueprint: 'constructor', parts: { ...KART }, wear: { wheels: 300 } },
      { id: 'e', name: 'E', blueprint: 'kart', parts: { ...KART, wheels: 'panel' }, wear: { wheels: 300, chassis: 2 } },
    ]));
    const s = GameState.fromSave(data);
    const byId = (id: string) => s.cars.find((c) => c.id === id)!;
    expect(byId('a').wear).toEqual({ wheels: 421, panels: 1000 });
    for (const id of ['b', 'c', 'd']) expect('wear' in byId(id)).toBe(false);
    expect(byId('e').wear).toEqual({ chassis: 2 });
  });

  it('swapping a part (for now) takes its wear away with it, the others stay', async () => {
    const { swapCarPart } = await import('../garage/actions');
    const s = new GameState();
    s.sim.hub.add('wheel_racing', 4);
    s.cars = [{ id: 'a', name: 'A', blueprint: 'kart', parts: { ...KART }, pose: null, wear: { wheels: 700, engine: 40 } }];
    expect(swapCarPart(s, 'a', 'wheels', 'wheel_racing')).toBe(true);
    expect(s.cars[0]!.wear).toEqual({ engine: 40 });
    expect(s.inventory.count('wheel')).toBe(4);
  });
});
