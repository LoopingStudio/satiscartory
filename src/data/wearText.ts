import { WEAR } from './balance';
import { blueprintById, type SlotId } from './blueprints';
import { ITEM_IDS, countLabel, type Inventory as ItemCounts, type ItemId } from './items';
import { formatCredits } from './sales';
import { blockedSlots, condition, isBlocked, slotWear, worstSlotOf, type CarWear, type WearCar } from './wear';

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
 * « État : roues 46 % · à réparer », « Voiture de course »; undefined for none. `state` is the car's stateText,
 * `blocked` past the race limit.
 */
export function carRowTip(racing: boolean, state: string | null, blocked = false): string | undefined {
  const tip = [racing ? 'Voiture de course' : '', state ? `état : ${state}` : '', blocked ? TO_REPAIR : ''].filter((t) => t).join(' · ');
  return tip ? capFirst(tip) : undefined;
}

// ------------------------------------------------------------------ the race limit (a car to repair)

/** After a car's name or state: « Dans la place : Kart Oopi n°1 · à réparer ». */
export const TO_REPAIR = 'à réparer';
/** Tag of a car row in the garage. */
export const TO_REPAIR_TAG = 'À réparer';
/** Title of the halted panel of a race, label of a blocked « Courir » (track selection). */
export const TO_REPAIR_AT_GARAGE = 'À réparer au garage';
/** The button that races the loaner instead of a car to repair. */
export const RACE_LOANER = 'Courir avec le kart de location';
/** Under the halted panel's title. */
export const HALTED_NOTE = 'Ramène-la au garage en la conduisant dans l’usine, ou cours avec le kart de location.';
/** State line of the track selection: the loaner, a car without wear. */
export const LOANER_STATE = 'Prêté par le circuit : il ne s’use pas.';
export const NEW_STATE = 'État : neuve';

/**
 * The slots that keep a car from racing, with their state: « roues à 18 % », « roues à 18 %, carrosserie à 12 % »
 * (blueprint order); null when it races.
 */
export function blockText(car: WearCar): string | null {
  const slots = blockedSlots(car);
  return slots.length ? slots.map((s) => `${SLOT_WORD[s]} à ${pct(slotWear(car, s))}`).join(', ') : null;
}

/** A blocked car asked for a race (toast): « Kart Oopi n°1 est à réparer au garage : tu cours avec le kart de location ». */
export function fallbackText(name: string): string {
  return `${name} est à réparer au garage : tu cours avec le kart de location`;
}

/** Halted panel (« Recommencer » with a car past the limit): « Kart Oopi n°1 ne peut plus prendre le départ : roues à 18 %. ». */
export function haltedText(name: string, block: string): string {
  return `${name} ne peut plus prendre le départ : ${block}.`;
}

/** Finish panel of a car past the limit: « Kart Oopi n°1 est à réparer au garage : roues à 18 %. ». */
export function finishBlockedText(name: string, block: string): string {
  return `${name} est à réparer au garage : ${block}.`;
}

/** Car option of the track selection: « Kart Oopi n°1 (à réparer) ». */
export function blockedOption(name: string): string {
  return `${name} (${TO_REPAIR})`;
}

/** Why « Courir » is disabled (track selection): « Roues à 18 % : répare-la au garage, ou cours avec le kart de location. ». */
export function blockedRaceTip(block: string): string {
  return `${capFirst(block)} : répare-la au garage, ou cours avec le kart de location.`;
}

/** Under a blocked car (track selection): « Roues à 18 % : Kart Oopi n°1 ne prend plus le départ. Répare-la… ». */
export function blockedRaceLine(name: string, block: string): string {
  return `${capFirst(block)} : ${name} ne prend plus le départ. Répare-la au garage, ou cours avec le kart de location.`;
}

/**
 * Alert of a car past the limit (garage): in this garage's bay, what the limit means; elsewhere, where to repair it.
 * Both say it still drives in the factory.
 */
export function blockAlert(block: string, here: boolean): string {
  return here
    ? `À réparer : ${block}. Sous ${pct(WEAR.BLOCK_ABOVE)}, une voiture ne prend plus le départ d’une course ; dans l’usine, elle roule encore.`
    : `À réparer : ${block}. Amène-la dans la place d’un garage pour la réparer ; dans l’usine, elle roule encore.`;
}

/** Why the garage's « Courir » is disabled: « À réparer : roues à 18 %. Répare-la ici, ou cours avec le kart de location. ». */
export function garageRaceTip(block: string, here: boolean): string {
  return `À réparer : ${block}. ${here ? 'Répare-la ici' : 'Amène-la dans la place d’un garage pour la réparer'}, ou cours avec le kart de location.`;
}

/** Enter in the driver's seat of a car past the limit (toast): « À réparer au garage : roues à 18 % ». */
export function seatRefusedText(block: string): string {
  return `${TO_REPAIR_AT_GARAGE} : ${block}`;
}

/** Getting into a car past the limit (toast): « Kart Oopi n°1 est à réparer : roues à 18 %. Elle roule encore jusqu’au garage. ». */
export function boardedBlockedText(name: string, block: string): string {
  return `${name} est à réparer : ${block}. Elle roule encore jusqu’au garage.`;
}

/**
 * The driven car's state in the factory's bottom hint: « roues 46 % », « roues 18 % : à réparer au garage » past
 * the limit; null when new. Allocates its string only (the hint is rebuilt every frame).
 */
export function driveState(car: WearCar): string | null {
  const s = worstSlotOf(car);
  if (!s) return null;
  const w = slotWear(car, s.id);
  return `${SLOT_WORD[s.id]} ${pct(w)}${w > WEAR.BLOCK_ABOVE ? ' : à réparer au garage' : ''}`;
}

/** Aiming at a parked car past the limit (factory hint): « à réparer (roues 18 %) »; null when it races. */
export function aimBlockedText(car: WearCar): string | null {
  return isBlocked(car) ? `${TO_REPAIR} (${stateText(car)})` : null;
}

/** The race limit crossed during a race (toast, once): « Roues à 19 % : dernier essai avant réparation au garage ». */
export function lastAttemptText(block: string): string {
  return `${capFirst(block)} : dernier essai avant réparation au garage`;
}

/** The race limit crossed while driving in the factory (toast, once): « Roues à 19 % : à réparer au garage avant la prochaine course ». */
export function repairBeforeRaceText(block: string): string {
  return `${capFirst(block)} : à réparer au garage avant la prochaine course`;
}

// ------------------------------------------------------------------ driving (race pill, damage flash, finish)

/** What wore the car last (WearMeter.last.cause): a shock, or the cause of a put-back. */
export type HitCause = 'shock' | keyof typeof WEAR.RESET;

/** Head of a damage flash by its cause (« Coincée » and « Replacée » stay under WEAR.FLASH_MIN: never shown). */
export const HIT_CAUSE: Record<HitCause, string> = {
  shock: 'Choc',
  flip: 'Tonneau',
  fall: 'Chute',
  water: 'Dans l’eau',
  stuck: 'Coincée',
  key: 'Replacée',
};

/**
 * Damage flash of the most hit part: « Choc : carrosserie −3 % » (its ‰ in whole percent, at least 1); null under
 * WEAR.FLASH_MIN (« Retour arrière », stuck: nothing shows).
 */
export function hitText(last: { readonly cause: HitCause; readonly slot: SlotId; readonly permille: number }): string | null {
  if (!(last.permille >= WEAR.FLASH_MIN)) return null;
  return `${HIT_CAUSE[last.cause]} : ${SLOT_WORD[last.slot]} −${Math.max(1, Math.round(last.permille / 10))} %`;
}

/** The race pill (under the speedometer): « Roues 46 % » by the most worn part, « Neuve » when new. */
export function pillText(car: WearCar): string {
  const s = worstSlotOf(car);
  return s ? `${capFirst(SLOT_WORD[s.id])} ${pct(slotWear(car, s.id))}` : 'Neuve';
}

/**
 * What one attempt wore (finish panel), from the car's wear at its start (`before`) to now (`after`): the slots whose
 * state shown dropped, the most first (blueprint order on a tie), « Usure de cet essai : roues −3 % · moteur −1 % »;
 * « Usure de cet essai : moins de 1 % » when it wore without a percentage dropping; null when it did not wear.
 */
export function attemptText(blueprint: string, before: Readonly<CarWear> | undefined, after: Readonly<CarWear> | undefined): string | null {
  const drops: [SlotId, number][] = [];
  let wore = false;
  for (const s of blueprintById(blueprint)?.slots ?? []) {
    const b = before?.[s.id] ?? 0;
    const a = after?.[s.id] ?? 0;
    if (a > b) wore = true;
    const d = condition(b) - condition(a);
    if (d > 0) drops.push([s.id, d]);
  }
  if (!drops.length) return wore ? 'Usure de cet essai : moins de 1 %' : null;
  drops.sort((x, y) => y[1] - x[1]);
  return `Usure de cet essai : ${drops.map(([s, d]) => `${SLOT_WORD[s]} −${d} %`).join(' · ')}`;
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
