import { describe, expect, it } from 'vitest';
import { BLUEPRINTS, BLUEPRINT_IDS, CAR_PARTS } from './blueprints';
import { WEAR } from './balance';
import { blockedSlots, clearSlotWear, condition, sanitizeWear, sanitizeWornSet, slotCountFor, slotWear, worstSlotOf, worstWear, type WearCar } from './wear';

const KART = { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } as const;
const FULL = { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' } as const;
const sport = (wear?: WearCar['wear'], parts: WearCar['parts'] = FULL): WearCar => ({ blueprint: 'sport', parts, ...(wear ? { wear } : {}) });

describe('wear: state and race limit', () => {
  it('condition: 100 % only when new, 20 % at the limit (still racing), 19 % above it', () => {
    expect([condition(), condition(0), condition(1), condition(9), condition(10)]).toEqual([100, 100, 99, 99, 99]);
    expect([condition(WEAR.WARN_ABOVE), condition(WEAR.BLOCK_ABOVE), condition(WEAR.BLOCK_ABOVE + 1), condition(WEAR.MAX)]).toEqual([50, 20, 19, 0]);
    // Garbage never shows « NaN % ».
    expect([condition(NaN), condition(-5), condition(5000)]).toEqual([100, 100, 0]);
  });

  it('blockedSlots: above BLOCK_ABOVE only, the spoiler counts, a slot without its part does not; blueprint order', () => {
    expect(blockedSlots(sport({ wheels: 800, panels: 1000 }))).toEqual(['panels']);
    expect(blockedSlots(sport({ spoiler: 801, chassis: 950 }))).toEqual(['chassis', 'spoiler']);
    const { spoiler: _, ...noSpoiler } = FULL;
    expect(blockedSlots(sport({ spoiler: 900 }, noSpoiler))).toEqual([]);
    expect(blockedSlots({ blueprint: 'constructor', parts: {}, wear: { chassis: 1000 } })).toEqual([]);
  });

  it('worstSlotOf / worstWear: the most worn installed part (the first on a tie), nothing for a new car or an odd blueprint', () => {
    expect(worstSlotOf(sport())).toBeNull();
    expect(worstWear(sport())).toBe(0);
    expect(worstSlotOf(sport({ engine: 300, wheels: 420 }))?.id).toBe('wheels');
    expect(worstSlotOf(sport({ panels: 300, engine: 300 }))?.id).toBe('engine');
    expect(worstWear(sport({ spoiler: 610, wheels: 200 }))).toBe(610);
    expect(worstSlotOf({ blueprint: 'constructor', parts: KART, wear: { wheels: 500 } })).toBeNull();
    expect(worstWear({ blueprint: '__proto__', parts: KART, wear: { wheels: 500 } })).toBe(0);
    // The static slot of the blueprint: nothing allocated per call.
    expect(worstSlotOf(sport({ wheels: 5 }))).toBe(BLUEPRINTS.sport.slots[2]);
    expect(slotWear(sport({ spoiler: 70 }, { ...FULL, spoiler: undefined as never }), 'spoiler')).toBe(0);
  });

  it('clearSlotWear: the slot goes, and the key when nothing else is worn', () => {
    const car = sport({ wheels: 400, engine: 20 });
    clearSlotWear(car, 'wheels');
    expect(car.wear).toEqual({ engine: 20 });
    clearSlotWear(car, 'spoiler');
    expect(car.wear).toEqual({ engine: 20 });
    clearSlotWear(car, 'engine');
    expect('wear' in car).toBe(false);
    clearSlotWear(car, 'engine');
    expect('wear' in car).toBe(false);
  });

  it('slotCountFor: one count per item, whatever the blueprint (a worn set is a whole slot)', () => {
    for (const id of BLUEPRINT_IDS) for (const s of BLUEPRINTS[id].slots) for (const item of s.accepts) expect(slotCountFor(item)).toBe(s.count);
    expect([slotCountFor('wheel'), slotCountFor('panel'), slotCountFor('chassis'), slotCountFor('spoiler')]).toEqual([4, 4, 1, 1]);
    expect(slotCountFor('tire')).toBeNull();
  });
});

describe('wear: save data', () => {
  it('sanitizeWear keeps the installed parts of the blueprint, as integers in 0..1000, zeros dropped', () => {
    expect(sanitizeWear('sport', FULL, { wheels: 420, chassis: 12.6, panels: 1500, engine: -3, spoiler: 0 })).toEqual({ wheels: 420, chassis: 13, panels: WEAR.MAX });
    // Not a finite number: absent (new). Unknown keys and inherited ones: ignored.
    expect(sanitizeWear('sport', FULL, { wheels: NaN, engine: Infinity, chassis: '400', panels: null, turbo: 50, __proto__: { spoiler: 300 } })).toBeUndefined();
    expect(sanitizeWear('sport', FULL, JSON.parse('{"__proto__": {"wheels": 300}, "constructor": 5, "toString": 9}'))).toBeUndefined();
  });

  it('sanitizeWear drops a slot without its part, or with a part the slot does not take', () => {
    expect(sanitizeWear('kart', KART, { wheels: 300, panels: 400, spoiler: 200 })).toEqual({ wheels: 300 });
    expect(sanitizeWear('kart', { ...KART, wheels: 'panel' }, { wheels: 300, engine: 5 })).toEqual({ engine: 5 });
    expect(sanitizeWear('kart', {}, { wheels: 300 })).toBeUndefined();
  });

  it('sanitizeWear: no blueprint, no wear', () => {
    for (const bp of ['constructor', '__proto__', 'loaner', 'truck', 3, null]) expect(sanitizeWear(bp, KART, { wheels: 300 })).toBeUndefined();
    for (const raw of [undefined, null, 5, 'wheels', true]) expect(sanitizeWear('kart', KART, raw)).toBeUndefined();
    expect(sanitizeWear('kart', KART, [300, 300])).toBeUndefined();
  });

  it('sanitizeWornSet: a whole slot of a car part, its wear in 1..1000 (a broken wear is worn out, never repaired)', () => {
    expect(sanitizeWornSet({ item: 'wheel', n: 4, wear: 581.4 })).toEqual({ item: 'wheel', n: 4, wear: 581 });
    expect(sanitizeWornSet({ item: 'chassis', n: 1, wear: 0 })).toEqual({ item: 'chassis', n: 1, wear: 1 });
    expect(sanitizeWornSet({ item: 'panel', n: 4, wear: 4000 })).toEqual({ item: 'panel', n: 4, wear: WEAR.MAX });
    for (const wear of [NaN, '300', null, undefined]) expect(sanitizeWornSet({ item: 'spoiler', n: 1, wear })?.wear).toBe(WEAR.MAX);
    for (const bad of [{ item: 'tire', n: 4, wear: 300 }, { item: 'unobtainium', n: 1, wear: 300 }, { item: 'wheel', n: 2, wear: 300 }, { item: 'wheel', n: '4', wear: 300 }, null, 'wheel', 4])
      expect(sanitizeWornSet(bad)).toBeNull();
    // Every car part makes a valid set of its slot's count.
    for (const item of CAR_PARTS) expect(sanitizeWornSet({ item, n: slotCountFor(item), wear: 500 })).not.toBeNull();
  });
});
