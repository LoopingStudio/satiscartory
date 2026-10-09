import { WEAR } from './balance';
import type { SlotId } from './blueprints';
import { ITEM_IDS, countLabel, type Inventory as ItemCounts, type ItemId } from './items';
import { formatCredits } from './sales';
import { condition, slotWear, worstSlotOf, type WearCar } from './wear';

/*
 * Texts of the wear (pure, French UI). The slots' genders differ (les roues, la carrosserie, le châssis, le moteur,
 * l'aileron): a sentence about a slot goes through a table, never a shared ending; a car is « elle » (une voiture).
 * What a HUD reads every frame allocates nothing but its string: the words are static, the worst slot is found
 * without a list. House typography: a plain space before « : », « ; » and « % », never a non-breaking one; ’ and
 * « »; a drop takes the minus sign (U+2212).
 */

export type WearTone = 'good' | 'warn' | 'bad';

/** Colour of a wear: green, orange above WEAR.WARN_ABOVE, red above WEAR.BLOCK_ABOVE (the race limit). */
export function wearTone(w = 0): WearTone {
  return w > WEAR.BLOCK_ABOVE ? 'bad' : w > WEAR.WARN_ABOVE ? 'warn' : 'good';
}

/** Lower-case word of each slot, in a sentence (« roues 46 % »). */
export const SLOT_WORD: Record<SlotId, string> = { chassis: 'châssis', engine: 'moteur', wheels: 'roues', panels: 'carrosserie', spoiler: 'aileron' };

/** A slot repaired, agreeing with it (toast). */
export const REPAIRED: Record<SlotId, string> = {
  chassis: 'Châssis réparé',
  engine: 'Moteur réparé',
  wheels: 'Roues réparées',
  panels: 'Carrosserie réparée',
  spoiler: 'Aileron réparé',
};

/** Taking a slot's worn parts off (« Aucun »), agreeing with them; the state follows in brackets. */
const TAKE_OFF: Record<SlotId, string> = {
  chassis: 'Retirer le châssis : il va dans la réserve',
  engine: 'Retirer le moteur : il va dans la réserve',
  wheels: 'Retirer les roues : elles vont dans la réserve',
  panels: 'Retirer la carrosserie : elle va dans la réserve',
  spoiler: 'Retirer l’aileron : il va dans la réserve',
};

/** State shown for a wear: « 46 % ». */
export function pct(w?: number): string {
  return `${condition(w)} %`;
}

/** A car's state by its most worn part (« roues 46 % »), null when it is new. */
export function stateText(car: WearCar): string | null {
  const s = worstSlotOf(car);
  return s ? `${SLOT_WORD[s.id]} ${pct(slotWear(car, s.id))}` : null;
}

/** `s` with its first letter in capitals (« état : … » → « État : … »). */
export function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Pad tip of a car row in the garage, the pieces that apply only: « Voiture de course · état : roues 46 % »,
 * « État : roues 46 % », « Voiture de course »; undefined for none. `state` is the car's stateText.
 */
export function carRowTip(racing: boolean, state: string | null): string | undefined {
  const tip = [racing ? 'Voiture de course' : '', state ? `état : ${state}` : ''].filter((t) => t).join(' · ');
  return tip ? capFirst(tip) : undefined;
}

// ------------------------------------------------------------------ effects

/** Relative changes of the feel of a worn car (−0.04 = −4 %): car/wornTuning.ts wearEffects. */
export interface EffectValues {
  grip: number;
  power: number;
  topSpeed: number;
  steer: number;
  brake: number;
  downforce: number;
}

const EFFECT_WORDS: readonly [keyof EffectValues, string][] = [
  ['grip', 'adhérence'],
  ['power', 'puissance'],
  ['topSpeed', 'vitesse de pointe'],
  ['steer', 'braquage'],
  ['brake', 'freinage'],
  ['downforce', 'appui'],
];

/** A relative change in whole percent with its sign: « −4 % », « +2 % » (U+2212 for a drop). */
function signedPct(v: number): string {
  return `${v < 0 ? '−' : '+'}${Math.round(Math.abs(v) * 100)} %`;
}

/**
 * « adhérence −4 % · puissance −1 % · vitesse de pointe −1 % · … »: the effects that show (0.5 % or more), null when
 * none does.
 */
export function effectsText(e: EffectValues): string | null {
  const parts = EFFECT_WORDS.filter(([k]) => Math.round(Math.abs(e[k]) * 100) >= 1).map(([k, word]) => `${word} ${signedPct(e[k])}`);
  return parts.length ? parts.join(' · ') : null;
}

// ------------------------------------------------------------------ worn sets and repairs (garage)

/** A worn set, or what reads like one (a build slot): its item, count and wear (‰). */
interface SetLike {
  item: ItemId;
  n: number;
  wear: number;
}

/** What a repair cost: its items, or its credits. */
interface Paid {
  items?: ItemCounts;
  credits?: number;
}

/** Why a payment is refused: the items missing, or the credits short. */
interface Refusal {
  missing?: ItemCounts;
  short?: number;
}

/** Title of the credits pill (factory HUD, garage). */
export const CREDITS_TITLE = 'Crédits : ventes de voitures et de pièces usées ; ils paient les réparations';

/** Verb of a set as the subject: « 1 aileron va », « 4 roues vont ». */
export function goes(n: number): 'va' | 'vont' {
  return n > 1 ? 'vont' : 'va';
}

/** « 2 pneus, 1 plaque »: the counts in ITEM_IDS order (empty for none). */
export function itemsText(c: Readonly<ItemCounts>): string {
  return ITEM_IDS.filter((id) => (c[id] ?? 0) > 0).map((id) => countLabel(id, c[id]!)).join(', ');
}

/** « 1 lot », « 3 lots »; `worn`: « 1 lot usé », « 2 lots usés ». */
export function lotsText(n: number, worn = false): string {
  return `${n} lot${n > 1 ? 's' : ''}${worn ? (n > 1 ? ' usés' : ' usé') : ''}`;
}

/** A worn set: « 4 roues · 42 % », « 1 châssis · 42 % ». */
export function wornSetLabel(s: SetLike): string {
  return `${countLabel(s.item, s.n)} · ${pct(s.wear)}`;
}

/** « 4 roues · 46 % vont dans la réserve », « 1 aileron · 62 % va dans la réserve ». */
export function toReserveText(s: SetLike): string {
  return `${wornSetLabel(s)} ${goes(s.n)} dans la réserve`;
}

/** « 2 pneus » (items) or « 410 cr » (credits): what a repair cost. */
function costText(paid: Paid): string {
  return paid.credits ? formatCredits(paid.credits) : itemsText(paid.items ?? {});
}

/** « 2 pneus » (items) or « −290 cr » (credits): what a repair took. */
function takenText(paid: Paid): string {
  return paid.credits ? `−${formatCredits(paid.credits)}` : itemsText(paid.items ?? {});
}

/** Title of a repair paid in items: « Réparer avec 2 pneus (le sac d’abord, puis le hangar) ». */
export function repairTitle(items: Readonly<ItemCounts>): string {
  return `Réparer avec ${itemsText(items)} (le sac d’abord, puis le hangar)`;
}

/** Why a repair in items is disabled: « Il manque : 1 pneu (sac + hangar) ». */
export function missingTip(missing: Readonly<ItemCounts>): string {
  return `Il manque : ${itemsText(missing)} (sac + hangar)`;
}

/** Why a repair in credits is disabled: « Il te manque 140 cr (solde : 150 cr) ». */
export function shortTip(short: number, balance: number): string {
  return `Il te manque ${formatCredits(short)} (solde : ${formatCredits(balance)})`;
}

/** A refused repair (toast): « Il manque : 1 pneu », « Il te manque 140 cr ». */
export function refusedText(r: Refusal): string {
  return r.missing ? `Il manque : ${itemsText(r.missing)}` : `Il te manque ${formatCredits(r.short ?? 0)}`;
}

/** A slot repaired (toast): « Roues réparées : 2 pneus », « Roues réparées : −290 cr ». */
export function slotRepairedText(slot: SlotId, paid: Paid): string {
  return `${REPAIRED[slot]} : ${takenText(paid)}`;
}

/** « Tout réparer » done (toast): « Kart Oopi n°1 réparée : 3 pneus, 1 plaque », « … réparée : −870 cr ». */
export function carRepairedText(name: string, paid: Paid): string {
  return `${name} réparée : ${takenText(paid)}`;
}

export const REPAIR_ALL_TITLE = 'Répare toutes les pièces usées d’un coup';
export const RENEW_TITLE = 'Pose des pièces neuves du sac ou du hangar ; les usées vont dans la réserve';

/** « Remplacer par du neuf (4 en stock) ». */
export function renewLabel(have: number): string {
  return `Remplacer par du neuf (${have} en stock)`;
}

/** Why « Remplacer par du neuf » is disabled: « Il en faut 4 en stock (tu en as 2) ». */
export function renewTip(need: number, have: number): string {
  return `Il en faut ${need} en stock (tu en as ${have})`;
}

/** Title of « Aucun » over a worn part: « Retirer l’aileron : il va dans la réserve (62 %) ». */
export function takeOffTitle(slot: SlotId, w: number): string {
  return `${TAKE_OFF[slot]} (${pct(w)})`;
}

/**
 * A part changed or taken off (toast): plain « Pièce changée » / « Pièce retirée », or with the worn set that went to
 * the reserve, « Pièce changée : 4 roues · 46 % vont dans la réserve ».
 */
export function swappedText(changed: boolean, worn: SetLike | null): string {
  const head = changed ? 'Pièce changée' : 'Pièce retirée';
  return worn ? `${head} : ${toReserveText(worn)}` : head;
}

export const VALUE_TITLE = 'Prix de vente au garage ou dans une concession : la valeur de ses pièces plus 25 %, moins le prix de sa réparation en crédits';

/** After a worn car's value: « (4 480 cr réparée) ». */
export function repairedValueText(price: number): string {
  return `(${formatCredits(price)} réparée)`;
}

/** Under « Vendre « X » pour … ? » for a worn car: « Usée : réparée, elle vaudrait 4 480 cr. ». */
export function wornSaleNote(price: number): string {
  return `Usée : réparée, elle vaudrait ${formatCredits(price)}.`;
}

/**
 * « Démonter « X » ? »: where its parts go, new ones (`fresh`) to the backpack, `worn` sets to the reserve.
 */
export function disassembleQuestion(name: string, fresh: boolean, worn: number): string {
  const q = `Démonter « ${name} » ?`;
  if (!worn) return `${q} Les pièces vont dans ton sac (le surplus au hangar).`;
  if (!fresh) return `${q} Ses pièces, toutes usées, vont dans la réserve.`;
  return `${q} Les pièces neuves vont dans ton sac (le surplus au hangar), les pièces usées dans la réserve.`;
}

/** A car taken apart (toast): new parts (`fresh`) to the backpack (`toHub` to the hub), `worn` sets to the reserve. */
export function disassembledText(name: string, fresh: boolean, toHub: number, worn: number): string {
  return `${name} démontée : ${whereTheyWent(fresh, toHub, worn, 'pièces neuves')}`;
}

/**
 * « Abandonner ce chantier (Kart Oopi) ? »: where the parts go (new ones to the backpack, worn sets to the reserve).
 * The build, not the car, is the subject: « ce Sportive » would not agree.
 */
export function abandonQuestion(blueprintName: string, fresh: boolean, worn: number): string {
  const q = `Abandonner ce chantier (${blueprintName}) ?`;
  if (!worn) return `${q} Les pièces posées vont dans ton sac (le surplus au hangar).`;
  if (!fresh) return `${q} Les pièces posées, toutes usées, vont dans la réserve.`;
  return `${q} Les pièces posées vont dans ton sac (le surplus au hangar), les pièces usées dans la réserve.`;
}

/** A build given up (toast). */
export function abandonedText(fresh: boolean, toHub: number, worn: number): string {
  return `Chantier abandonné : ${whereTheyWent(fresh, toHub, worn, 'pièces')}`;
}

/**
 * « pièces dans ton sac, 3 au hangar (sac plein) » without worn sets; with some, « {fresh word} dans ton sac, 2 lots
 * usés dans la réserve » (« pièces neuves » for a car taken apart), or only the reserve when every part was worn.
 */
function whereTheyWent(fresh: boolean, toHub: number, worn: number, freshWord: string): string {
  if (!worn) return toHub ? `pièces dans ton sac, ${toHub} au hangar (sac plein)` : 'pièces dans ton sac';
  const reserve = `${lotsText(worn, true)} dans la réserve`;
  if (!fresh) return reserve;
  return `${freshWord} dans ton sac${toHub ? ` (${toHub} au hangar, sac plein)` : ''}, ${reserve}`;
}

// ------------------------------------------------------------------ the reserve (« Pièces usées »)

export const WORN_INTRO =
  'Retirées des voitures, elles gardent leur usure. Répare-les pour les retrouver neuves dans ton sac, vends-les selon leur état, ou pose-les sur la voiture de ce garage. La réserve est la même dans tous les garages.';
export const WORN_NO_TARGET = 'Pour poser une pièce usée, gare une voiture dans ce garage, ou commence une voiture dans sa place.';
export const BUILD_SLOT_BUSY = 'Cet emplacement du chantier a déjà des pièces : retire-les d’abord';
export const REMOVE_WORN_TITLE = 'Retour dans la réserve : la pièce garde son usure';
export const POSE_WORN_TITLE = 'Commence la voiture dans la place avec ce lot de la réserve : il garde son usure';
export const BUILD_WORN_TITLE = 'Pose ce lot dans le chantier de ce garage : il garde son usure';
export const WORN_POSE_REFUSED = 'Rien à poser : place prise, ou emplacement déjà commencé';

/** Left row of the reserve: « 3 lots · la même dans tous les garages ». */
export function reserveRowText(lots: number): string {
  return `${lotsText(lots)} · la même dans tous les garages`;
}

/** Totals of the reserve: « 3 lots · valeur 1 840 cr ». */
export function reserveSummary(lots: number, value: number): string {
  return `${lotsText(lots)} · valeur ${formatCredits(value)}`;
}

/** Title of « Vendre » for a set worth `price`: « Vendre ce lot pour 672 cr », or why it is worth nothing. */
export function sellSetTitle(price: number): string {
  return price > 0 ? `Vendre ce lot pour ${formatCredits(price)}` : 'Hors d’usage : il ne vaut plus rien, mais se répare';
}

/** The sale of a set to confirm: « Vendre 4 roues · 42 % pour 672 cr ? ». */
export function sellSetQuestion(s: SetLike, price: number): string {
  return `Vendre ${wornSetLabel(s)} pour ${formatCredits(price)} ?`;
}

/** A set sold (toast): « Vendu : 4 roues · 42 % · +672 cr ». */
export function setSoldText(s: SetLike, price: number): string {
  return `Vendu : ${wornSetLabel(s)} · +${formatCredits(price)}`;
}

/** A set repaired (toast): « Réparé pour 3 pneus : 4 roues, dans ton sac », « … : 4 roues (2 au hangar, sac plein) ». */
export function setRepairedText(s: SetLike, paid: Paid, toHub: number): string {
  return `Réparé pour ${costText(paid)} : ${countLabel(s.item, s.n)}${toHub ? ` (${toHub} au hangar, sac plein)` : ', dans ton sac'}`;
}

/**
 * Title of « Poser sur … » by what the slot holds: worn parts (their wear) go to the reserve, new ones back to the
 * backpack; `null` for an empty slot.
 */
export function installTitle(inPlace: number | null): string {
  if (inPlace === null) return 'L’emplacement est vide : le lot s’y pose avec son usure';
  return inPlace > 0 ? `Les pièces en place (${pct(inPlace)}) vont dans la réserve` : 'Les pièces en place, neuves, retournent dans ton sac';
}

/** A set put on a car (toast), with what became of the parts in place (`'worn'`, `'new'`, or `null` for none). */
export function installedOnCarText(name: string, s: SetLike, inPlace: 'worn' | 'new' | null): string {
  const head = `Posé sur ${name} : ${wornSetLabel(s)}`;
  if (inPlace === 'worn') return `${head} ; les pièces en place vont dans la réserve`;
  if (inPlace === 'new') return `${head} ; les pièces en place, neuves, retournent dans ton sac`;
  return head;
}

/** A set put into a build (toast): « Posé dans le chantier : 4 roues · 42 % ». */
export function installedInBuildText(s: SetLike): string {
  return `Posé dans le chantier : ${wornSetLabel(s)}`;
}

/** A worn set taken off a build (toast): « Retiré : 4 roues · 42 %, dans la réserve ». */
export function wornRemovedText(s: SetLike): string {
  return `Retiré : ${wornSetLabel(s)}, dans la réserve`;
}

/** Draft: start the car with a set of the reserve, « Poser 4 roues · 42 % (réserve) ». */
export function poseWornLabel(s: SetLike): string {
  return `Poser ${wornSetLabel(s)} (réserve)`;
}

/** An empty build slot with nothing in stock: « Dans la réserve : 4 roues · 42 % (Pièces usées, à gauche) ». */
export function reserveHint(s: SetLike): string {
  return `Dans la réserve : ${wornSetLabel(s)} (Pièces usées, à gauche)`;
}
