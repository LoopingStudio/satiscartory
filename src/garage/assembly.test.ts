import { describe, expect, it } from 'vitest';
import { assemble, checkAssembly, costOf, defaultChoices, disassemble, swapPart } from './assembly';
import { BLUEPRINTS } from '../data/blueprints';
import { computeCarStats, statBars } from '../car/stats';
import type { Inventory } from '../data/items';

describe('assembly', () => {
  it('a kart needs 1 chassis, 1 engine and 4 wheels', () => {
    expect(costOf(BLUEPRINTS.kart, defaultChoices(BLUEPRINTS.kart))).toEqual({ chassis: 1, engine: 1, wheel: 4 });
  });

  it('reports missing parts and assembles when everything is there', () => {
    const storage: Inventory = { chassis: 1, engine: 1, wheel: 3 };
    const choices = defaultChoices(BLUEPRINTS.kart);
    expect(checkAssembly(storage, 'kart', choices)).toEqual({ ok: false, missing: { wheel: 1 }, invalidSlots: [] });
    expect(assemble(storage, 'kart', choices, 1)).toBeNull();
    storage.wheel = 4;
    const car = assemble(storage, 'kart', choices, 1)!;
    expect(car.parts).toEqual({ chassis: 'chassis', engine: 'engine', wheels: 'wheel' });
    expect(storage).toEqual({ chassis: 0, engine: 0, wheel: 0 });
  });

  it('the sport car takes panels and an optional spoiler', () => {
    const storage: Inventory = { chassis: 1, engine: 1, wheel_racing: 4, panel: 4, spoiler: 1 };
    const choices = { ...defaultChoices(BLUEPRINTS.sport), wheels: 'wheel_racing' as const, spoiler: 'spoiler' as const };
    const car = assemble(storage, 'sport', choices, 2)!;
    expect(car.parts.spoiler).toBe('spoiler');
    expect(storage.panel).toBe(0);
  });

  it('cannot assemble the loaner or put wrong parts in a slot', () => {
    expect(checkAssembly({}, 'loaner', {}).ok).toBe(false);
    const bad = { ...defaultChoices(BLUEPRINTS.kart), wheels: 'engine' as const };
    expect(checkAssembly({ chassis: 1, engine: 9 }, 'kart', bad).invalidSlots).toContain('wheels');
  });

  it('disassembling returns every part; swapping trades parts with storage', () => {
    const storage: Inventory = { chassis: 1, engine: 1, wheel: 4, wheel_racing: 4 };
    const car = assemble(storage, 'kart', defaultChoices(BLUEPRINTS.kart), 3)!;
    expect(swapPart(storage, car, 'wheels', 'wheel_racing')).toBe(true);
    expect(car.parts.wheels).toBe('wheel_racing');
    expect(storage).toMatchObject({ wheel: 4, wheel_racing: 0 });
    expect(swapPart(storage, car, 'wheels', null)).toBe(false); // required slot
    disassemble(storage, car);
    expect(storage).toMatchObject({ chassis: 1, engine: 1, wheel: 4, wheel_racing: 4 });
  });
});

describe('car stats', () => {
  it('parts change the stats and the two blueprints differ clearly', () => {
    const kart = computeCarStats({ blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } });
    const kartR = computeCarStats({ blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing' } });
    const sport = computeCarStats({ blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' } });
    const sportS = computeCarStats({ blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel', spoiler: 'spoiler' } });
    expect(kartR.grip).toBeGreaterThan(kart.grip * 1.2);
    expect(sportS.downforce).toBeGreaterThan(sport.downforce);
    expect(sportS.topSpeedMs).toBeLessThan(sport.topSpeedMs);
    expect(sport.topSpeedMs).toBeGreaterThan(kart.topSpeedMs * 1.5);
    expect(sport.massKg).toBeGreaterThan(kart.massKg * 2.5);
    const bk = statBars(kart);
    const bs = statBars(sport);
    expect(bs.speed).toBeGreaterThan(bk.speed + 3);
    expect(bs.weight).toBeGreaterThan(bk.weight + 4);
  });
});

describe('review regressions (garage/state)', () => {
  it('bestChoices picks racing wheels / spoiler when in stock', async () => {
    const { bestChoices } = await import('./assembly');
    expect(bestChoices(BLUEPRINTS.kart, { wheel_racing: 4 }).wheels).toBe('wheel_racing');
    expect(bestChoices(BLUEPRINTS.kart, { wheel_racing: 3, wheel: 4 }).wheels).toBe('wheel');
    expect(bestChoices(BLUEPRINTS.sport, { spoiler: 1 }).spoiler).toBe('spoiler');
    expect(bestChoices(BLUEPRINTS.sport, {}).spoiler).toBeNull();
    expect(checkAssembly({ chassis: 1, engine: 1, wheel_racing: 4 }, 'kart', bestChoices(BLUEPRINTS.kart, { chassis: 1, engine: 1, wheel_racing: 4 })).ok).toBe(true);
  });

  it('choosing the loaner (null) survives a save/load; dangling ids fall back', async () => {
    const { GameState } = await import('../state/GameState');
    const s = new GameState();
    s.cars.push({ id: 'car-1', name: 'K', blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } });
    s.selectedCarId = null;
    expect(GameState.fromSave(JSON.parse(JSON.stringify(s.serialize()))).selectedCarId).toBeNull();
    s.selectedCarId = 'car-9';
    expect(GameState.fromSave(JSON.parse(JSON.stringify(s.serialize()))).selectedCarId).toBe('car-1');
  });
});
