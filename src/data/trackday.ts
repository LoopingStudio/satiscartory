import { FUEL, WEAR } from './balance';
import { blueprintById, type SlotId } from './blueprints';
import { carPrice } from './sales';
import { fuelBlocked, fuelUsed, tankLiters } from './fuel';
import { worstWear, type CarWear } from './wear';
import { needOf } from './wearText';

/*
 * Trackdays (pure): the player lends the cars they built to paying guests for a day on a circuit, and provides the
 * meal, the drinks and the coaching. Everything is computed, no randomness: the forecast the planner shows is what
 * happens. Guests pay a ticket at the end; the catering and a hired coach are paid at the start. The cars come back
 * worn and with less fuel (each guest drives TRACKDAY.LAPS_PER_GUEST laps). How happy the guests were moves the
 * reputation (0..100), which brings more of them next time.
 */

export const TRACKDAY = {
  /** Guests per car (they take turns at the wheel). */
  GUESTS_PER_CAR: 4,
  /** Laps each guest drives (an Ovale lap is 0.58 km). */
  LAPS_PER_GUEST: 3,
  LAP_KM: 0.58,
  /** Duration in factory ticks (20 per second): two minutes. The cars are away meanwhile. */
  TICKS: 20 * 120,
  /** What a guest would pay for a new Kart Oopi with nothing else (credits). */
  BASE_TICKET: 300,
  /** Ticket the player may ask. */
  PRICE_MIN: 100,
  PRICE_MAX: 2000,
  PRICE_STEP: 50,
  /** Reputation of a new game. */
  REP_START: 20,
  /** Results kept (« Derniers trackdays »). */
  LOG: 5,
} as const;

export interface CateringOption<Id extends string> {
  id: Id;
  name: string;
  /** Credits per guest, paid at the start. */
  cost: number;
  /** What it adds to the guests' day (0..3). */
  score: number;
}

export type MealId = 'none' | 'sandwich' | 'buffet' | 'gourmet';
export type DrinkId = 'none' | 'water' | 'softs' | 'bar';
export type CoachingId = 'none' | 'self' | 'pro';

export const MEALS: CateringOption<MealId>[] = [
  { id: 'none', name: 'Pas de repas', cost: 0, score: 0 },
  { id: 'sandwich', name: 'Sandwichs', cost: 30, score: 1 },
  { id: 'buffet', name: 'Buffet', cost: 70, score: 2 },
  { id: 'gourmet', name: 'Repas gastronomique', cost: 150, score: 3 },
];

export const DRINKS: CateringOption<DrinkId>[] = [
  { id: 'none', name: 'Pas de boissons', cost: 0, score: 0 },
  { id: 'water', name: 'Eau', cost: 5, score: 1 },
  { id: 'softs', name: 'Café et sodas', cost: 20, score: 2 },
  { id: 'bar', name: 'Bar complet', cost: 45, score: 3 },
];

/** Coaching: none, the player (as good as their medal on the circuit), or a hired instructor. */
export const COACHING: CateringOption<CoachingId>[] = [
  { id: 'none', name: 'Pas de coaching', cost: 0, score: 0 },
  { id: 'self', name: 'Coaching par toi', cost: 0, score: 0 },
  { id: 'pro', name: 'Moniteur professionnel', cost: 90, score: 3 },
];

/** Medal → how good a coach the player is on that circuit (0: no medal, cannot coach it). */
export const MEDAL_COACH: Record<string, number> = { bronze: 1, silver: 2, gold: 3, author: 4 };

export interface TrackdayPlan {
  trackId: string;
  carIds: string[];
  meal: MealId;
  drink: DrinkId;
  coaching: CoachingId;
  price: number;
}

/** What the trackday reads of a car (a CarInstance). */
export interface TrackdayCar {
  id: string;
  name: string;
  blueprint: string;
  parts: Readonly<Record<string, unknown>>;
  wear?: CarWear;
  fuel?: number;
}

/** What a car would take from a full trackday (all its guests). */
export function carDayCost(blueprint: string): { fuel: number; laps: number } {
  const laps = TRACKDAY.GUESTS_PER_CAR * TRACKDAY.LAPS_PER_GUEST;
  return { laps, fuel: tankLiters(blueprint) > 0 ? Math.ceil(laps * TRACKDAY.LAP_KM * FUEL.PER_KM) : 0 };
}

/** Why a car cannot go to a trackday (null: it can): unbuilt, to repair or refuel, or not enough fuel for the day. */
export function carRefusal(car: TrackdayCar): string | null {
  const bp = blueprintById(car.blueprint);
  if (!bp?.buildable) return 'pas une voiture construite';
  const need = needOf(car);
  if (need === 'repair' || need === 'both') return 'à réparer';
  if (fuelBlocked(car)) return 'à ravitailler';
  const { fuel } = carDayCost(car.blueprint);
  if (fuelUsed(car) + fuel > FUEL.MAX) return `pas assez d’essence (il en faut ${Math.ceil(fuel / 10)} %)`;
  return null;
}

/** How much a guest likes a car (1 for a new Kart Oopi): its price, and less when worn. */
export function carAppeal(car: TrackdayCar): number {
  const base = carPrice('kart', { chassis: 'chassis', engine: 'engine', wheels: 'wheel' }) || 1;
  const price = carPrice(car.blueprint, car.parts) / base;
  const condition = 1 - (0.6 * Math.min(WEAR.MAX, worstWear(car))) / WEAR.MAX;
  return price * condition;
}

/** Coaching level (0..4) and its cost per guest. `medal`: the player's best medal on the circuit (null: none). */
export function coachingOf(id: CoachingId, medal: string | null): { level: number; cost: number } {
  if (id === 'self') return { level: medal ? (MEDAL_COACH[medal] ?? 0) : 0, cost: 0 };
  if (id === 'pro') return { level: 3, cost: COACHING[2]!.cost };
  return { level: 0, cost: 0 };
}

export interface TrackdayCarResult {
  id: string;
  guests: number;
  /** Wear and fuel the day costs this car (‰). */
  wear: Partial<Record<SlotId, number>>;
  fuel: number;
}

export interface TrackdayForecast {
  /** Guests who come (all cars). */
  guests: number;
  /** Places (cars × GUESTS_PER_CAR). */
  places: number;
  /** What the guests think the day is worth, per head. */
  fairPrice: number;
  revenue: number;
  /** Catering and hired coaching, paid at the start. */
  costs: number;
  net: number;
  /** 0..100. */
  satisfaction: number;
  /** New reputation after the day. */
  reputation: number;
  cars: TrackdayCarResult[];
  /** The plan cannot start (no car, coaching without a medal…): why. */
  problem: string | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The trackday of `plan` with these cars: who comes, what it brings in and costs, how happy the guests are, what each
 * car takes. `medal`: the player's best medal on the circuit; `official`: a circuit of the game (a little more
 * appealing than one of the editor); `reputation`: 0..100.
 */
export function forecastTrackday(plan: TrackdayPlan, cars: readonly TrackdayCar[], ctx: { medal: string | null; official: boolean; reputation: number }): TrackdayForecast {
  const chosen = plan.carIds.map((id) => cars.find((c) => c.id === id)).filter((c): c is TrackdayCar => !!c);
  const meal = MEALS.find((m) => m.id === plan.meal) ?? MEALS[0]!;
  const drink = DRINKS.find((d) => d.id === plan.drink) ?? DRINKS[0]!;
  const coach = coachingOf(plan.coaching, ctx.medal);
  const services = meal.score + drink.score + coach.level;
  const rep = clamp(ctx.reputation, 0, 100);
  const price = clamp(Math.round(plan.price), TRACKDAY.PRICE_MIN, TRACKDAY.PRICE_MAX);
  let problem: string | null = null;
  if (!chosen.length) problem = 'Choisis au moins une voiture';
  else if (plan.coaching === 'self' && coach.level === 0) problem = 'Il te faut une médaille sur ce circuit pour coacher';
  else {
    const bad = chosen.map((c) => [c, carRefusal(c)] as const).find(([, why]) => why);
    if (bad) problem = `${bad[0].name} : ${bad[1]}`;
  }
  // Each car fills its places from what guests think a seat in it is worth against the ticket.
  const trackK = ctx.official ? 1 : 0.9;
  const serviceK = 1 + services / 10;
  const repK = 1 + (rep - 50) / 200;
  let guests = 0;
  let fairSum = 0;
  let appealSum = 0;
  const results: TrackdayCarResult[] = [];
  for (const car of chosen) {
    const appeal = carAppeal(car);
    const fair = TRACKDAY.BASE_TICKET * appeal * serviceK * repK * trackK;
    const share = clamp(1.6 - price / fair, 0, 1);
    const n = Math.floor(TRACKDAY.GUESTS_PER_CAR * share + 1e-9);
    guests += n;
    fairSum += fair;
    appealSum += appeal;
    // Coached guests drive cleaner: less wear on the tires and the body.
    const laps = n * TRACKDAY.LAPS_PER_GUEST;
    const km = laps * TRACKDAY.LAP_KM;
    const clean = 1 - 0.1 * coach.level;
    const bp = blueprintById(car.blueprint);
    const wear: Partial<Record<SlotId, number>> = {};
    for (const s of bp?.slots ?? []) {
      if (!car.parts[s.id]) continue;
      const k = s.id === 'wheels' ? WEAR.TIRE_PER_KM * 1.3 * clean : s.id === 'engine' ? WEAR.ENGINE_PER_KM + WEAR.ENGINE_THROTTLE_PER_KM * 0.8 : 2 * clean;
      const w = Math.round(km * k);
      if (w > 0) wear[s.id] = w;
    }
    const fuel = tankLiters(car.blueprint) > 0 ? Math.round(km * FUEL.PER_KM * (FUEL.IDLE_SHARE + (1 - FUEL.IDLE_SHARE) * 0.85)) : 0;
    results.push({ id: car.id, guests: n, wear, fuel });
  }
  const places = chosen.length * TRACKDAY.GUESTS_PER_CAR;
  const fairPrice = chosen.length ? Math.round(fairSum / chosen.length) : 0;
  const revenue = guests * price;
  const costs = guests * (meal.cost + drink.cost + coach.cost);
  // Happiness: the services, the cars, and the ticket against what the day was worth.
  const avgAppeal = chosen.length ? appealSum / chosen.length : 0;
  const value = fairPrice > 0 ? price / fairPrice : 2;
  const satisfaction = guests
    ? Math.round(clamp(35 + 6 * meal.score + 5 * drink.score + 6 * coach.level + 12 * (avgAppeal - 1) - 40 * Math.max(0, value - 0.8), 0, 100))
    : 0;
  const reputation = guests ? Math.round(clamp(rep + (satisfaction - 50) / 4, 0, 100)) : rep;
  return { guests, places, fairPrice, revenue, costs, net: revenue - costs, satisfaction, reputation, cars: results, problem };
}

/** A trackday running: its plan, its forecast (what happens), when it ends (factory tick). */
export interface ActiveTrackday {
  plan: TrackdayPlan;
  trackName: string;
  forecast: TrackdayForecast;
  endTick: number;
}

/** A finished trackday (« Derniers trackdays »). */
export interface TrackdayResult {
  trackName: string;
  guests: number;
  revenue: number;
  costs: number;
  satisfaction: number;
  reputation: number;
}

/** A satisfaction in words. */
export function satisfactionText(s: number): string {
  return s >= 85 ? 'ravis' : s >= 65 ? 'contents' : s >= 45 ? 'mitigés' : s >= 25 ? 'déçus' : 'furieux';
}
