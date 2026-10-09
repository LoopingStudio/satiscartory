import { describe, expect, it } from 'vitest';
import { BLUEPRINTS, BLUEPRINT_IDS } from './blueprints';
import { WEAR } from './balance';
import { SLOT_WORD, capFirst, carRowTip, pct, stateText, wearTone } from './wearText';

describe('wear texts', () => {
  it('wearTone: green up to WARN_ABOVE, orange up to the race limit, red above it (the same « above » as the block)', () => {
    expect([wearTone(), wearTone(0), wearTone(WEAR.WARN_ABOVE)]).toEqual(['good', 'good', 'good']);
    expect([wearTone(WEAR.WARN_ABOVE + 1), wearTone(WEAR.BLOCK_ABOVE)]).toEqual(['warn', 'warn']);
    expect([wearTone(WEAR.BLOCK_ABOVE + 1), wearTone(WEAR.MAX)]).toEqual(['bad', 'bad']);
  });

  it('pct and stateText: « 46 % », the most worn part, null when new', () => {
    expect([pct(), pct(540), pct(801)]).toEqual(['100 %', '46 %', '19 %']);
    const parts = { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' };
    expect(stateText({ blueprint: 'sport', parts })).toBeNull();
    expect(stateText({ blueprint: 'sport', parts, wear: { engine: 100, wheels: 540 } })).toBe('roues 46 %');
    expect(stateText({ blueprint: 'sport', parts, wear: { panels: 999 } })).toBe('carrosserie 0 %');
    expect(stateText({ blueprint: 'constructor', parts, wear: { wheels: 540 } })).toBeNull();
  });

  it('carRowTip: the pieces that apply, the first one capitalised; undefined for none (PadNav shows no tip)', () => {
    const worn = stateText({ blueprint: 'kart', parts: { wheels: 'wheel' }, wear: { wheels: 540 } });
    expect(carRowTip(true, worn)).toBe('Voiture de course · état : roues 46 %');
    expect(carRowTip(false, worn)).toBe('État : roues 46 %');
    expect(carRowTip(true, null)).toBe('Voiture de course');
    expect(carRowTip(false, stateText({ blueprint: 'kart', parts: { wheels: 'wheel' } }))).toBeUndefined();
    expect([capFirst('état'), capFirst('')]).toEqual(['État', '']);
  });

  it('every slot has its word; the house typography (no non-breaking space, no straight apostrophe)', () => {
    for (const id of BLUEPRINT_IDS) for (const s of BLUEPRINTS[id].slots) expect(SLOT_WORD[s.id]).toBeTruthy();
    for (const t of [carRowTip(true, 'roues 46 %')!, carRowTip(false, 'roues 46 %')!]) expect(t).not.toMatch(/[\u00a0\u202f']/);
    const texts = [...Object.values(SLOT_WORD), pct(540), stateText({ blueprint: 'kart', parts: { wheels: 'wheel' }, wear: { wheels: 540 } })!];
    for (const t of texts) {
      expect(t).not.toMatch(/[  ']/);
      expect(t).toBe(t.toLowerCase());
    }
  });
});
