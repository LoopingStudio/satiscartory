import { describe, expect, it } from 'vitest';
import { BLUEPRINTS, BLUEPRINT_IDS, type SlotId } from './blueprints';
import { WEAR } from './balance';
import { wearEffects } from '../car/wornTuning';
import * as T from './wearText';
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

describe('wear texts of the garage (repairs, reserve)', () => {
  const W42 = { item: 'wheel', n: 4, wear: 580 } as const;
  const KART = 'Kart Oopi n°1';

  it('every slot has its agreeing « réparé » and « retirer » texts', () => {
    for (const id of BLUEPRINT_IDS) {
      for (const s of BLUEPRINTS[id].slots) {
        expect(T.REPAIRED[s.id]).toMatch(new RegExp(`^${s.name} réparée?s?$`));
        expect(T.takeOffTitle(s.id, 380)).toMatch(/^Retirer (le|la|les|l’)/);
      }
    }
    expect(Object.values(T.REPAIRED)).toEqual(['Châssis réparé', 'Moteur réparé', 'Roues réparées', 'Carrosserie réparée', 'Aileron réparé']);
    expect(T.takeOffTitle('spoiler', 380)).toBe('Retirer l’aileron : il va dans la réserve (62 %)');
    expect(T.takeOffTitle('wheels', 380)).toBe('Retirer les roues : elles vont dans la réserve (62 %)');
  });

  it('sets, counts and items: « 4 roues · 42 % », va / vont, ITEM_IDS order', () => {
    expect(T.wornSetLabel(W42)).toBe('4 roues · 42 %');
    expect(T.wornSetLabel({ item: 'chassis', n: 1, wear: 580 })).toBe('1 châssis · 42 %');
    expect(T.wornSetLabel({ item: 'wheel_racing', n: 4, wear: 580 })).toBe('4 roues racing · 42 %');
    expect([T.goes(1), T.goes(4)]).toEqual(['va', 'vont']);
    expect([T.lotsText(1), T.lotsText(3), T.lotsText(1, true), T.lotsText(2, true)]).toEqual(['1 lot', '3 lots', '1 lot usé', '2 lots usés']);
    expect(T.itemsText({ tire: 3, bolt: 2, plate: 1, iron_rod: 1 })).toBe('1 tige de fer, 1 plaque, 2 boulons, 3 pneus');
    expect(T.itemsText({ tire: 0 })).toBe('');
    expect(T.toReserveText({ item: 'wheel', n: 4, wear: 540 })).toBe('4 roues · 46 % vont dans la réserve');
    expect(T.toReserveText({ item: 'spoiler', n: 1, wear: 380 })).toBe('1 aileron · 62 % va dans la réserve');
  });

  it('repairs: titles, why a button is disabled, toasts (a drop takes U+2212)', () => {
    expect(T.repairTitle({ tire: 2 })).toBe('Réparer avec 2 pneus (le sac d’abord, puis le hangar)');
    expect(T.missingTip({ tire: 1 })).toBe('Il manque : 1 pneu (sac + hangar)');
    expect(T.shortTip(140, 150)).toBe('Il te manque 140 cr (solde : 150 cr)');
    expect(T.refusedText({ missing: { tire: 1 } })).toBe('Il manque : 1 pneu');
    expect(T.refusedText({ short: 140 })).toBe('Il te manque 140 cr');
    expect(T.slotRepairedText('wheels', { items: { tire: 2 } })).toBe('Roues réparées : 2 pneus');
    expect(T.slotRepairedText('wheels', { credits: 290 })).toBe('Roues réparées : −290 cr');
    expect(T.slotRepairedText('engine', { credits: 1290 })).toBe('Moteur réparé : −1 290 cr');
    expect(T.carRepairedText(KART, { credits: 870 })).toBe('Kart Oopi n°1 réparée : −870 cr');
    expect(T.carRepairedText(KART, { items: { tire: 3, plate: 1 } })).toBe('Kart Oopi n°1 réparée : 1 plaque, 3 pneus');
    expect(T.renewLabel(4)).toBe('Remplacer par du neuf (4 en stock)');
    expect(T.renewTip(4, 2)).toBe('Il en faut 4 en stock (tu en as 2)');
    expect(T.swappedText(true, null)).toBe('Pièce changée');
    expect(T.swappedText(false, null)).toBe('Pièce retirée');
    expect(T.swappedText(true, { item: 'wheel', n: 4, wear: 540 })).toBe('Pièce changée : 4 roues · 46 % vont dans la réserve');
    expect(T.swappedText(false, { item: 'spoiler', n: 1, wear: 380 })).toBe('Pièce retirée : 1 aileron · 62 % va dans la réserve');
  });

  it('a worn car: value, sale, dismantling (new parts to the backpack, worn sets to the reserve)', () => {
    expect(T.repairedValueText(4480)).toBe('(4 480 cr réparée)');
    expect(T.wornSaleNote(4480)).toBe('Usée : réparée, elle vaudrait 4 480 cr.');
    expect(T.disassembleQuestion(KART, true, 0)).toBe('Démonter « Kart Oopi n°1 » ? Les pièces vont dans ton sac (le surplus au hangar).');
    expect(T.disassembleQuestion(KART, true, 2)).toBe('Démonter « Kart Oopi n°1 » ? Les pièces neuves vont dans ton sac (le surplus au hangar), les pièces usées dans la réserve.');
    expect(T.disassembleQuestion(KART, false, 3)).toBe('Démonter « Kart Oopi n°1 » ? Ses pièces, toutes usées, vont dans la réserve.');
    expect(T.disassembledText(KART, true, 0, 0)).toBe('Kart Oopi n°1 démontée : pièces dans ton sac');
    expect(T.disassembledText(KART, true, 3, 0)).toBe('Kart Oopi n°1 démontée : pièces dans ton sac, 3 au hangar (sac plein)');
    expect(T.disassembledText(KART, true, 0, 2)).toBe('Kart Oopi n°1 démontée : pièces neuves dans ton sac, 2 lots usés dans la réserve');
    expect(T.disassembledText(KART, true, 3, 1)).toBe('Kart Oopi n°1 démontée : pièces neuves dans ton sac (3 au hangar, sac plein), 1 lot usé dans la réserve');
    expect(T.disassembledText(KART, false, 0, 3)).toBe('Kart Oopi n°1 démontée : 3 lots usés dans la réserve');
  });

  it('a build: the abandon question and toast, a worn set taken off, where a fitting set waits', () => {
    expect(T.abandonQuestion('Kart Oopi', true, 0)).toBe('Abandonner ce chantier (Kart Oopi) ? Les pièces posées vont dans ton sac (le surplus au hangar).');
    expect(T.abandonQuestion('Sportive', true, 0)).toBe('Abandonner ce chantier (Sportive) ? Les pièces posées vont dans ton sac (le surplus au hangar).');
    expect(T.abandonQuestion('Kart Oopi', true, 1)).toBe('Abandonner ce chantier (Kart Oopi) ? Les pièces posées vont dans ton sac (le surplus au hangar), les pièces usées dans la réserve.');
    expect(T.abandonQuestion('Kart Oopi', false, 2)).toBe('Abandonner ce chantier (Kart Oopi) ? Les pièces posées, toutes usées, vont dans la réserve.');
    expect(T.abandonedText(true, 0, 0)).toBe('Chantier abandonné : pièces dans ton sac');
    expect(T.abandonedText(true, 2, 0)).toBe('Chantier abandonné : pièces dans ton sac, 2 au hangar (sac plein)');
    expect(T.abandonedText(true, 0, 1)).toBe('Chantier abandonné : pièces dans ton sac, 1 lot usé dans la réserve');
    expect(T.abandonedText(false, 0, 1)).toBe('Chantier abandonné : 1 lot usé dans la réserve');
    expect(T.wornRemovedText(W42)).toBe('Retiré : 4 roues · 42 %, dans la réserve');
    expect(T.reserveHint(W42)).toBe('Dans la réserve : 4 roues · 42 % (Pièces usées, à gauche)');
    expect(T.poseWornLabel(W42)).toBe('Poser 4 roues · 42 % (réserve)');
    expect(T.installedInBuildText(W42)).toBe('Posé dans le chantier : 4 roues · 42 %');
  });

  it('the reserve: rows, totals, sale, repair and « Poser » texts', () => {
    expect(T.reserveRowText(3)).toBe('3 lots · la même dans tous les garages');
    expect(T.reserveRowText(1)).toBe('1 lot · la même dans tous les garages');
    expect(T.reserveSummary(3, 1840)).toBe('3 lots · valeur 1 840 cr');
    expect(T.sellSetTitle(672)).toBe('Vendre ce lot pour 672 cr');
    expect(T.sellSetTitle(0)).toBe('Hors d’usage : il ne vaut plus rien, mais se répare');
    expect(T.sellSetQuestion(W42, 672)).toBe('Vendre 4 roues · 42 % pour 672 cr ?');
    expect(T.setSoldText(W42, 672)).toBe('Vendu : 4 roues · 42 % · +672 cr');
    expect(T.setRepairedText(W42, { items: { tire: 3 } }, 0)).toBe('Réparé pour 3 pneus : 4 roues, dans ton sac');
    expect(T.setRepairedText(W42, { credits: 410 }, 0)).toBe('Réparé pour 410 cr : 4 roues, dans ton sac');
    expect(T.setRepairedText(W42, { credits: 410 }, 2)).toBe('Réparé pour 410 cr : 4 roues (2 au hangar, sac plein)');
    expect(T.installTitle(260)).toBe('Les pièces en place (74 %) vont dans la réserve');
    expect(T.installTitle(0)).toBe('Les pièces en place, neuves, retournent dans ton sac');
    expect(T.installedOnCarText(KART, W42, 'worn')).toBe('Posé sur Kart Oopi n°1 : 4 roues · 42 % ; les pièces en place vont dans la réserve');
    expect(T.installedOnCarText(KART, W42, 'new')).toBe('Posé sur Kart Oopi n°1 : 4 roues · 42 % ; les pièces en place, neuves, retournent dans ton sac');
    expect(T.installedOnCarText(KART, { item: 'spoiler', n: 1, wear: 380 }, null)).toBe('Posé sur Kart Oopi n°1 : 1 aileron · 62 %');
  });

  it('effectsText: the effects that show (0.5 % or more), with U+2212; null when none does', () => {
    const none = { grip: 0, power: 0, topSpeed: 0, steer: 0, brake: 0, downforce: 0 };
    expect(T.effectsText(none)).toBeNull();
    expect(T.effectsText({ ...none, grip: -0.004 })).toBeNull();
    expect(T.effectsText({ grip: -0.04, power: -0.01, topSpeed: -0.006, steer: -0.02, brake: -0.02, downforce: -0.05 })).toBe(
      'adhérence −4 % · puissance −1 % · vitesse de pointe −1 % · braquage −2 % · freinage −2 % · appui −5 %',
    );
    expect(T.effectsText({ ...none, steer: 0.02 })).toBe('braquage +2 %');
    // From the real effects: a kart's wheels at 50 % lose L(0.5) × 25 % of their grip; a few ‰ show nothing.
    const kart = { blueprint: 'kart' as const, parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } as const };
    expect(T.effectsText(wearEffects(kart, { wheels: 500 }))).toBe('adhérence −8 %');
    expect(T.effectsText(wearEffects(kart, { wheels: 10 }))).toBeNull();
    expect(T.effectsText(wearEffects(kart, undefined))).toBeNull();
  });

  it('the house typography everywhere: no non-breaking space, no straight apostrophe, drops with U+2212', () => {
    const slots: SlotId[] = ['chassis', 'engine', 'wheels', 'panels', 'spoiler'];
    const texts = [
      T.CREDITS_TITLE, T.REPAIR_ALL_TITLE, T.RENEW_TITLE, T.VALUE_TITLE, T.WORN_INTRO, T.WORN_NO_TARGET, T.BUILD_SLOT_BUSY,
      T.REMOVE_WORN_TITLE, T.POSE_WORN_TITLE, T.BUILD_WORN_TITLE, T.WORN_POSE_REFUSED,
      ...Object.values(T.REPAIRED), ...slots.map((s) => T.takeOffTitle(s, 999)),
      T.repairTitle({ tire: 2, plate: 1 }), T.missingTip({ bolt: 3 }), T.shortTip(1140, 150), T.refusedText({ short: 2140 }),
      T.slotRepairedText('panels', { credits: 520 }), T.carRepairedText('Sportive n°2', { credits: 1870 }),
      T.renewLabel(0), T.renewTip(4, 0), T.swappedText(true, W42), T.repairedValueText(4480), T.wornSaleNote(4480),
      T.disassembleQuestion('Sportive n°2', true, 2), T.disassembledText('Sportive n°2', true, 3, 2), T.abandonQuestion('Kart Oopi', true, 1),
      T.abandonedText(true, 3, 2), T.reserveRowText(2), T.reserveSummary(2, 1234), T.sellSetTitle(0), T.sellSetQuestion(W42, 1672),
      T.setSoldText(W42, 672), T.setRepairedText(W42, { credits: 1410 }, 2), T.installTitle(null), T.installTitle(260), T.installTitle(0),
      T.installedOnCarText('Sportive n°2', W42, 'worn'), T.installedInBuildText(W42), T.wornRemovedText(W42), T.poseWornLabel(W42),
      T.reserveHint(W42), T.effectsText({ grip: -0.04, power: -0.01, topSpeed: -0.01, steer: -0.02, brake: -0.02, downforce: -0.05 })!,
    ];
    for (const t of texts) {
      expect(t).not.toMatch(/[\u00a0\u202f']/);
      // A drop is « −290 cr », never an ASCII hyphen before a number.
      expect(t).not.toMatch(/-\s?\d/);
      // A plain space before « : », « ; », « % » and « ? » (never glued, never doubled).
      expect(t).not.toMatch(/\S[:;%?]|\s{2}/);
    }
  });
});
