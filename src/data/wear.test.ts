import { describe, expect, it } from 'vitest';
import { BLUEPRINTS, BLUEPRINT_IDS, CAR_PARTS } from './blueprints';
import { WEAR } from './balance';
import { BODY_LOOK_SLOT, blockedSlots, clearSlotWear, condition, isBlocked, raceBlocker, repairCredits, repairItems, sanitizeSetWear, sanitizeWear, sanitizeWornSet, shownConditions, shownWorst, slotCountFor, slotWear, smokeAmount, wearLevel, wearLookCode, worstSlotOf, worstWear, wornCarPrice, wornSetPrice, type CarWear, type ShownWorst, type WearCar } from './wear';
import { CAR_SALES, PART_VALUES, carPrice } from './sales';
import type { ItemId } from './items';

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

  it('raceBlocker / isBlocked: the car itself and its slots above the limit; null for the loaner, at 800 ‰ and without the spoiler', () => {
    const car = sport({ wheels: 801, spoiler: 950 });
    expect(raceBlocker(car)).toEqual({ kind: 'wear', car, slots: ['wheels', 'spoiler'] });
    expect(raceBlocker(car)?.car).toBe(car);
    expect(isBlocked(car)).toBe(true);
    expect(raceBlocker(null)).toBeNull();
    expect([raceBlocker(sport({ wheels: WEAR.BLOCK_ABOVE })), isBlocked(sport({ wheels: WEAR.BLOCK_ABOVE }))]).toEqual([null, false]);
    expect([raceBlocker(sport()), isBlocked(sport())]).toEqual([null, false]);
    // Taking the worn-out spoiler off (« Aucun ») lifts the block, even before its wear key goes.
    const { spoiler: _, ...noSpoiler } = FULL;
    expect([raceBlocker(sport({ spoiler: 1000 }, noSpoiler)), isBlocked(sport({ spoiler: 1000 }, noSpoiler))]).toEqual([null, false]);
    // isBlocked agrees with raceBlocker on a grid of wears.
    for (const w of [0, 1, 500, 799, 800, 801, 999, 1000]) for (const slot of ['chassis', 'engine', 'wheels', 'panels', 'spoiler'] as const)
      expect(isBlocked(sport({ [slot]: w }))).toBe(raceBlocker(sport({ [slot]: w })) !== null);
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

describe('wear: shown state', () => {
  it('shownConditions writes the % of each slot (−1: empty) and tells when one changed, a thousandth more does not', () => {
    const car = sport({ wheels: 4 }, { ...FULL, spoiler: undefined as never });
    const out: number[] = [];
    expect(shownConditions(car, out)).toBe(true);
    expect(out).toEqual([100, 100, 99, 100, -1]);
    expect(shownConditions(car, out)).toBe(false);
    car.wear!.wheels = 9;
    expect(shownConditions(car, out)).toBe(false);
    car.wear!.wheels = 10;
    expect(shownConditions(car, out)).toBe(false);
    car.wear!.wheels = 11;
    expect(shownConditions(car, out)).toBe(true);
    expect(out[2]).toBe(98);
    expect(shownConditions({ blueprint: 'constructor', parts: {} }, out)).toBe(false);
  });

  it('shownWorst: the most worn part and its %, true only when either changes (a HUD touches the DOM then only)', () => {
    const car = sport();
    const out: ShownWorst = { slot: null, pct: -1 };
    expect(shownWorst(car, out)).toBe(true);
    expect(out).toEqual({ slot: null, pct: 100 });
    expect(shownWorst(car, out)).toBe(false);
    car.wear = { wheels: 9 };
    expect(shownWorst(car, out)).toBe(true);
    expect(out).toEqual({ slot: 'wheels', pct: 99 });
    // A thousandth that does not change the % shown, the same part: nothing to redraw.
    car.wear.wheels = 10;
    expect(shownWorst(car, out)).toBe(false);
    car.wear.wheels = 11;
    expect(shownWorst(car, out)).toBe(true);
    expect(out.pct).toBe(98);
    // Another part takes the lead at the same %: the part shown changes.
    car.wear.panels = 12;
    expect(shownWorst(car, out)).toBe(true);
    expect(out).toEqual({ slot: 'panels', pct: 98 });
    // Repaired: new again.
    delete car.wear;
    expect(shownWorst(car, out)).toBe(true);
    expect(out).toEqual({ slot: null, pct: 100 });
    expect(shownWorst({ blueprint: 'constructor', parts: KART, wear: { wheels: 500 } }, out)).toBe(false);
  });

  it('every-frame helpers allocate nothing: the same `out`, static slots, primitives only', () => {
    const car = sport({ wheels: 540, engine: 120 });
    const out: ShownWorst = { slot: null, pct: -1 };
    shownWorst(car, out);
    const arr: number[] = [];
    shownConditions(car, arr);
    const slot = worstSlotOf(car);
    for (let i = 0; i < 1000; i++) {
      expect(shownWorst(car, out)).toBe(false);
      expect(shownConditions(car, arr)).toBe(false);
      // The blueprint's own SlotDef every time, never a copy.
      expect(worstSlotOf(car)).toBe(slot);
    }
    expect(slot).toBe(BLUEPRINTS.sport.slots[2]);
    expect(Object.keys(out)).toEqual(['slot', 'pct']);
    expect(arr).toHaveLength(BLUEPRINTS.sport.slots.length);
    expect([typeof worstWear(car), typeof isBlocked(car)]).toEqual(['number', 'boolean']);
  });
});

describe('wear: prices', () => {
  // [item, n, wear, items, credits]: the plan's table (800 ‰) and worn out (1000 ‰).
  const QUOTES: [ItemId, number, number, Record<string, number>, number][] = [
    ['wheel', 4, 800, { tire: 4 }, 560],
    ['wheel_racing', 4, 800, { tire: 7 }, 1120],
    ['chassis', 1, 800, { plate: 1, iron_rod: 1, bolt: 2 }, 380],
    ['engine', 1, 800, { plate: 2, iron_rod: 1, bolt: 2 }, 470],
    ['panel', 4, 800, { plate: 2, bolt: 4 }, 520],
    ['spoiler', 1, 800, { plate: 1, bolt: 1 }, 200],
    ['wheel', 4, 1000, { tire: 4 }, 700],
    ['wheel_racing', 4, 1000, { tire: 8 }, 1400],
    ['chassis', 1, 1000, { plate: 1, iron_rod: 1, bolt: 2 }, 480],
    ['engine', 1, 1000, { plate: 2, iron_rod: 1, bolt: 2 }, 590],
    ['panel', 4, 1000, { plate: 2, bolt: 4 }, 650],
    ['spoiler', 1, 1000, { plate: 1, bolt: 1 }, 250],
  ];

  it.each(QUOTES)('repairing %s ×%i worn %i ‰: the kit (wheels: tires; other parts: half the recipe) or credits', (item, n, w, items, credits) => {
    expect(repairItems(item, n, w)).toEqual(items);
    expect(repairCredits(item, n, w)).toBe(credits);
  });

  it('rounded up, never free: from 1 ‰ on at least 1 of each item of the kit and 10 cr; nothing for a new part', () => {
    expect(repairItems('wheel', 4, 1)).toEqual({ tire: 1 });
    expect(repairItems('engine', 1, 1)).toEqual({ plate: 1, iron_rod: 1, bolt: 1 });
    for (const item of CAR_PARTS) {
      const n = slotCountFor(item)!;
      expect(repairCredits(item, n, 1), item).toBe(10);
      expect(Object.values(repairItems(item, n, 1)).every((k) => k! >= 1), item).toBe(true);
      expect(Object.keys(repairItems(item, n, 1)).length, item).toBeGreaterThan(0);
      expect(repairItems(item, n, 0), item).toEqual({});
      expect(repairCredits(item, n, 0), item).toBe(0);
    }
    // After one race (about 25 ‰ of tires): 1 tire or 20 cr.
    expect([repairItems('wheel', 4, 25), repairCredits('wheel', 4, 25)]).toEqual([{ tire: 1 }, 20]);
    // A worn set of « 4 roues · 42 % » (580 ‰): 3 tires or 410 cr, or sold for 672 cr.
    expect([repairItems('wheel', 4, 580), repairCredits('wheel', 4, 580), wornSetPrice('wheel', 4, 580)]).toEqual([{ tire: 3 }, 410, 672]);
  });

  it('quotes grow with the wear, and repairing always costs less than making the parts new', () => {
    for (const item of CAR_PARTS) {
      const n = slotCountFor(item)!;
      let prev = 0;
      for (let w = 0; w <= WEAR.MAX; w += 25) {
        const c = repairCredits(item, n, w);
        expect(c, `${item} ${w}`).toBeGreaterThanOrEqual(prev);
        prev = c;
      }
      // Worn out: the kit is worth less than the parts (with the same margin: less than what the dealer pays for them).
      expect(repairCredits(item, n, WEAR.MAX), item).toBeLessThan((PART_VALUES[item] * n * 5) / 4);
    }
  });

  it('a worn set sells for its value × its state (no margin): never more than new, 0 worn out', () => {
    expect(wornSetPrice('wheel', 4, 1000)).toBe(0);
    expect(wornSetPrice('chassis', 1, 1)).toBe(Math.floor(PART_VALUES.chassis * 0.999));
    for (const item of CAR_PARTS) {
      const n = slotCountFor(item)!;
      let prev = Infinity;
      for (let w = 1; w <= WEAR.MAX; w += 37) {
        const p = wornSetPrice(item, n, w);
        expect(Number.isInteger(p) && p >= 0 && p <= PART_VALUES[item] * n, `${item} ${w}`).toBe(true);
        expect(p).toBeLessThanOrEqual(prev);
        prev = p;
      }
    }
  });

  it('a worn car sells for its new price minus its repair in credits: repairing then selling brings in exactly the same', () => {
    let seed = 11;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) >>> 16;
    for (const sale of CAR_SALES) {
      expect(wornCarPrice(sale.blueprint, sale.parts)).toBe(sale.price);
      expect(wornCarPrice(sale.blueprint, sale.parts, {})).toBe(sale.price);
      for (let k = 0; k < 40; k++) {
        const wear: CarWear = {};
        let repair = 0;
        for (const s of BLUEPRINTS[sale.blueprint].slots) {
          const item = sale.parts[s.id];
          if (!item || next() % 3 === 0) continue;
          const w = 1 + (next() % WEAR.MAX);
          wear[s.id] = w;
          repair += repairCredits(item, s.count, w);
        }
        expect(wornCarPrice(sale.blueprint, sale.parts, wear) + repair).toBe(sale.price);
      }
      // Worn out everywhere: still worth something (never below 0).
      const out: CarWear = Object.fromEntries(BLUEPRINTS[sale.blueprint].slots.map((s) => [s.id, WEAR.MAX]));
      expect(wornCarPrice(sale.blueprint, sale.parts, out)).toBeGreaterThan(0);
    }
    const full = { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' };
    expect(wornCarPrice('sport', full, { chassis: 1000, engine: 1000, wheels: 1000, panels: 1000, spoiler: 1000 })).toBe(7950 - 3370);
    // The plan's examples: a kart with wheels at 500 ‰, then wheels 800, engine 250, chassis 100.
    expect(wornCarPrice('kart', KART, { wheels: 500 })).toBe(4130);
    expect(wornCarPrice('kart', KART, { wheels: 800, engine: 250, chassis: 100 })).toBe(3720);
    // Wear of a slot without its part, an odd blueprint: no discount, no crash.
    expect(wornCarPrice('kart', KART, { panels: 900 })).toBe(carPrice('kart', KART));
    expect(wornCarPrice('constructor', KART, { wheels: 900 })).toBe(0);
  });

  it('dismantling then selling the worn sets always brings in less than selling the car (a quarter of the parts’ value at least)', () => {
    const grid = [1, 10, 100, 250, 500, 799, 800, 801, 999, 1000];
    for (const sale of CAR_SALES) {
      const slots = BLUEPRINTS[sale.blueprint].slots.filter((s) => sale.parts[s.id]);
      for (const a of grid) {
        for (const b of grid) {
          // Every slot worn (alternately a and b): every part goes to the reserve, and each set is sold.
          const wear: CarWear = {};
          slots.forEach((s, i) => (wear[s.id] = i % 2 ? a : b));
          const sets = slots.reduce((sum, s) => sum + wornSetPrice(sale.parts[s.id]!, s.count, wear[s.id]!), 0);
          const quarter = slots.reduce((sum, s) => sum + (PART_VALUES[sale.parts[s.id]!] * s.count) / 4, 0);
          // Rounding: the car's price ±5, each repair up to 10 more.
          expect(wornCarPrice(sale.blueprint, sale.parts, wear) - sets, `${sale.blueprint} ${a}/${b}`).toBeGreaterThanOrEqual(quarter - 5 - 10 * slots.length);
        }
      }
    }
  });

  it('sanitizeSetWear: 1..1000, a broken value is worn out', () => {
    expect([sanitizeSetWear(420.4), sanitizeSetWear(0), sanitizeSetWear(-3), sanitizeSetWear(1e9)]).toEqual([420, 1, 1, WEAR.MAX]);
    for (const raw of [NaN, Infinity, '5', null, undefined, {}]) expect(sanitizeSetWear(raw)).toBe(WEAR.MAX);
  });
});

describe('wear: 3D look', () => {
  it('wearLevel: one step above each of 250, 500 and 800 ‰, the darkest one where the car no longer races', () => {
    const at = [0, 1, 250, 251, 500, 501, 800, 801, 1000];
    expect(at.map(wearLevel)).toEqual([0, 0, 0, 1, 1, 2, 2, 3, 3]);
    expect(WEAR.LOOK_ABOVE[2]).toBe(WEAR.BLOCK_ABOVE);
    expect(WEAR.LOOK_ABOVE[1]).toBe(WEAR.WARN_ABOVE);
    // The darkest step is exactly the blocked cars.
    for (let w = 0; w <= WEAR.MAX; w++) expect(wearLevel(w) === 3, `${w}`).toBe(w > WEAR.BLOCK_ABOVE);
    for (const w of [undefined, NaN, -5]) expect(wearLevel(w)).toBe(0);
    expect(wearLevel(Infinity)).toBe(3);
  });

  it('smokeAmount: none up to 700 ‰ included, then growing to 1 at 1000 ‰', () => {
    expect([smokeAmount(), smokeAmount(0), smokeAmount(699), smokeAmount(700), smokeAmount(NaN)]).toEqual([0, 0, 0, 0, 0]);
    expect(smokeAmount(701)).toBeGreaterThan(0);
    expect(smokeAmount(850)).toBeCloseTo(0.5, 12);
    expect([smokeAmount(1000), smokeAmount(5000)]).toEqual([1, 1]);
    let last = 0;
    for (let w = 700; w <= 1000; w++) {
      expect(smokeAmount(w)).toBeGreaterThanOrEqual(last);
      last = smokeAmount(w);
    }
  });

  it('BODY_LOOK_SLOT: the panels on the Sportive, the chassis on the kart (its frame is its body)', () => {
    expect(BODY_LOOK_SLOT).toEqual({ kart: 'chassis', sport: 'panels', loaner: 'chassis' });
  });

  it('wearLookCode: wheels + 4 × body + 16 × spoiler, 0 when new', () => {
    expect([wearLookCode('kart', undefined), wearLookCode('kart', {}), wearLookCode('sport', { engine: 1000 })]).toEqual([0, 0, 0]);
    // The kart's body follows its chassis.
    expect(wearLookCode('kart', { wheels: 600, chassis: 300 })).toBe(2 + 4 * 1);
    // The Sportive's follows its panels; its chassis, hidden under them, only shows on the gauge.
    expect(wearLookCode('sport', { chassis: 1000 })).toBe(0);
    expect(wearLookCode('sport', { panels: 801, wheels: 251 })).toBe(1 + 4 * 3);
    expect(wearLookCode('sport', { spoiler: 900 })).toBe(16 * 3);
    expect(wearLookCode('sport', { wheels: 1000, panels: 1000, spoiler: 1000 })).toBe(63);
    // An unknown blueprint (or an inherited key) shows its chassis, without failing.
    expect(wearLookCode('constructor', { chassis: 600, wheels: 300 })).toBe(1 + 4 * 2);
    expect(wearLookCode('nope', { panels: 900 })).toBe(0);
  });
});
