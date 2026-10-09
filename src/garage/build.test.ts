import { describe, expect, it } from 'vitest';
import { buildComplete, buildEmpty, buildLook, buildProgress, carFromBuild, installPart, leftovers, newBuild, refundBuild, removePart, sanitizeBuild } from './build';
import type { Inventory as ItemCounts } from '../data/items';

const total = (s: ItemCounts) => Object.values(s).reduce((a, n) => a + (n ?? 0), 0);

describe('car build (chantier)', () => {
  it('takes wheels as they come: two now, two later, never more than the slot holds', () => {
    const stock: ItemCounts = { wheel: 2 };
    const b = newBuild(7, 'kart');
    expect(installPart(stock, b, 'wheels', 'wheel')).toBe(2);
    expect(b.parts.wheels).toEqual({ item: 'wheel', n: 2 });
    expect(stock.wheel).toBe(0);
    expect(buildProgress(b)).toEqual({ done: 2, total: 6 });
    stock.wheel = 5;
    expect(installPart(stock, b, 'wheels', 'wheel')).toBe(2);
    expect(stock.wheel).toBe(3);
    expect(installPart(stock, b, 'wheels', 'wheel')).toBe(0);
    expect(buildComplete(b)).toBe(false);
  });

  it('refuses another kind of item in a started slot, and items the slot does not accept', () => {
    const stock: ItemCounts = { wheel: 1, wheel_racing: 4, engine: 1 };
    const b = newBuild(7, 'kart');
    installPart(stock, b, 'wheels', 'wheel');
    expect(installPart(stock, b, 'wheels', 'wheel_racing')).toBe(0);
    expect(installPart(stock, b, 'wheels', 'engine')).toBe(0);
    expect(installPart(stock, b, 'nope', 'engine')).toBe(0);
    // Taken off, the slot takes racing wheels.
    expect(removePart(stock, b, 'wheels', [])).toBe(1);
    expect(stock.wheel).toBe(1);
    expect(installPart(stock, b, 'wheels', 'wheel_racing')).toBe(4);
  });

  it('rolls out a complete car with the installed parts; an optional slot only when full', () => {
    const stock: ItemCounts = { chassis: 1, engine: 1, wheel: 4, panel: 4, spoiler: 0 };
    const b = newBuild(7, 'sport');
    for (const [slot, item] of [['chassis', 'chassis'], ['engine', 'engine'], ['wheels', 'wheel']] as const) installPart(stock, b, slot, item);
    expect(buildComplete(b)).toBe(false);
    expect(carFromBuild(b, 3)).toBeNull();
    stock.panel = 3;
    installPart(stock, b, 'panels', 'panel');
    expect(buildLook(b).body).toBe('bare');
    stock.panel = 1;
    installPart(stock, b, 'panels', 'panel');
    expect(buildComplete(b)).toBe(true);
    const car = carFromBuild(b, 3)!;
    expect(car).toEqual({ id: 'car-3', name: 'Sportive n°3', blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' } });
    expect(leftovers(b)).toEqual({});
  });

  it('gives back every installed part, nothing lost or created', () => {
    const stock: ItemCounts = { chassis: 2, engine: 1, wheel: 3, panel: 2 };
    const before = total(stock);
    const b = newBuild(7, 'sport');
    installPart(stock, b, 'chassis', 'chassis');
    installPart(stock, b, 'wheels', 'wheel');
    installPart(stock, b, 'panels', 'panel');
    expect(total(stock) + buildProgress(b).done).toBe(before);
    refundBuild(stock, b, []);
    expect(total(stock)).toBe(before);
    expect(buildEmpty(b)).toBe(true);
  });

  it('a worn set taken off goes to the reserve with its wear, new parts to the storage', () => {
    const stock: ItemCounts = { engine: 1 };
    const worn: { item: 'wheel' | 'chassis'; n: number; wear: number }[] = [];
    const b = newBuild(7, 'kart');
    b.parts.wheels = { item: 'wheel', n: 4, wear: 420 };
    b.parts.chassis = { item: 'chassis', n: 1, wear: 9 };
    installPart(stock, b, 'engine', 'engine');
    // A slot holding a worn set takes nothing more.
    expect(installPart({ wheel: 4 }, b, 'wheels', 'wheel')).toBe(0);
    expect(removePart(stock, b, 'wheels', worn)).toBe(4);
    expect(worn).toEqual([{ item: 'wheel', n: 4, wear: 420 }]);
    expect(stock).toEqual({ engine: 0 });
    refundBuild(stock, b, worn);
    expect(worn).toEqual([{ item: 'wheel', n: 4, wear: 420 }, { item: 'chassis', n: 1, wear: 9 }]);
    expect(stock).toEqual({ engine: 1 });
    expect(buildEmpty(b)).toBe(true);
  });

  it('describes what the bay shows', () => {
    const stock: ItemCounts = { chassis: 1, engine: 1, wheel: 3 };
    const b = newBuild(7, 'kart');
    expect(buildLook(b)).toEqual({ body: 'ghost', wheels: 0, wheelItem: null, engine: false, spoiler: false });
    installPart(stock, b, 'wheels', 'wheel');
    installPart(stock, b, 'engine', 'engine');
    expect(buildLook(b)).toEqual({ body: 'ghost', wheels: 3, wheelItem: 'wheel', engine: true, spoiler: false });
    installPart(stock, b, 'chassis', 'chassis');
    expect(buildLook(b).body).toBe('solid'); // the kart has no panels
  });

  it('restores builds from saves and drops what does not fit', () => {
    expect(sanitizeBuild({ garage: 4, blueprint: 'kart', parts: { wheels: { item: 'wheel', n: 9 }, engine: { item: 'panel', n: 1 }, x: { item: 'wheel', n: 1 } } })).toEqual({
      garage: 4,
      blueprint: 'kart',
      parts: { wheels: { item: 'wheel', n: 4 } },
    });
    expect(sanitizeBuild({ garage: 4, blueprint: 'loaner', parts: {} })).toBeNull();
    expect(sanitizeBuild({ garage: 'a', blueprint: 'kart' })).toBeNull();
    expect(sanitizeBuild(null)).toBeNull();
  });
});
