import { FactorySim } from '../factory/sim/FactorySim';
import { isTerrainId } from '../factory/sim/terrain';
import type { FactorySave } from '../factory/sim/types';
import { sanitizePose, type CarInstance } from '../garage/assembly';
import { parkUnplaced, type BayBlocker } from '../garage/parking';
import { refundBuild, sanitizeBuild, type CarBuild } from '../garage/build';
import type { TrackRecord } from '../race/records';
import { Inventory, Wallet, type Stack } from './Inventory';
import { LEGACY_MAP_OFFSET } from '../data/factoryMap';
import { FACTORY_CELL } from '../config/constants';
import { TIERS, isUnlocked } from '../data/tiers';
import { GRASS_QUALITIES, TERRAIN_RULES, type GrassQuality } from '../data/factoryTerrain';
import type { BuildingType } from '../data/buildings';
import type { Inventory as ItemCounts } from '../data/items';
import { sanitizeWear, sanitizeWornSet, type WornSet } from '../data/wear';
import { DEFAULT_LOOK, sanitizeLook, type CharacterLook } from '../data/character';
import { sanitizeFuel } from '../data/fuel';
import { TRACKDAY, type ActiveTrackday, type TrackdayForecast, type TrackdayPlan, type TrackdayResult } from '../data/trackday';
import { WEAR, FUEL } from '../data/balance';
import { challengeKey, sanitizeChallenge, type Challenge } from '../race/challenge';

/** Challenges kept (« Défis reçus »), most recent first. */
const CHALLENGES_MAX = 10;

export interface Settings {
  mouseSensitivity: number;
  /** Camera speed of the pad's right stick (multiplier). */
  padSensitivity: number;
  invertY: boolean;
  shadows: boolean;
  /** « Herbe »: density of the animated grass on the relief map. */
  grass: GrassQuality;
}

export const DEFAULT_SETTINGS: Settings = { mouseSensitivity: 1, padSensitivity: 1, invertY: false, shadows: true, grass: 'medium' };

export interface PlayerSave {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface SaveData {
  version: 1;
  savedAt: number;
  factory: FactorySave;
  player?: PlayerSave | null;
  cars?: CarInstance[];
  selectedCarId?: string | null;
  records?: Record<string, TrackRecord>;
  settings?: Partial<Settings>;
  objectives?: Record<string, boolean>;
  carCounter?: number;
  /** Player backpack slots. */
  inventory?: (Stack | null)[];
  /** Hub tiers unlocked. Missing in saves older than the tiers: everything stays unlocked. */
  tier?: number;
  /** Number of tiers that existed when saving (absent before the garage tier: 4). */
  tierMax?: number;
  /** Cars under construction in garage bays. */
  builds?: CarBuild[];
  /** Reserve of worn parts (garage « Pièces usées »); absent before the wear: empty. */
  worn?: WornSet[];
  /** The player's character (name, colors, hat); absent before the customization: the default look. */
  look?: CharacterLook;
  /** A trackday running (its cars are away), the reputation, the last results. */
  trackday?: ActiveTrackday | null;
  trackdayRep?: number;
  trackdayLog?: TrackdayResult[];
  /** Challenges received from friends. */
  challenges?: Challenge[];
}

/** Persistent game state shared by all modes (the factory keeps running in every mode). */
export class GameState {
  sim: FactorySim;
  player: PlayerSave | null = null;
  cars: CarInstance[] = [];
  /** Cars under construction, one per garage bay at most (garage/build.ts). */
  builds: CarBuild[] = [];
  /**
   * Reserve of worn parts, shared by every garage: whole slots taken off a car with their wear (data/wear.ts). Not
   * in the backpack nor the hub: a worn part becomes a plain item again only once its repair is paid.
   */
  worn: WornSet[] = [];
  selectedCarId: string | null = null;
  records: Record<string, TrackRecord> = {};
  settings: Settings = { ...DEFAULT_SETTINGS };
  /** The player's character: name, colors, hat (kept by « Nouvelle partie », like the settings). */
  look: CharacterLook = { ...DEFAULT_LOOK };
  /** The trackday running (data/trackday.ts): its cars are away until its end. */
  trackday: ActiveTrackday | null = null;
  /** Trackday reputation, 0..100. */
  trackdayRep: number = TRACKDAY.REP_START;
  /** Last trackdays, most recent first. */
  trackdayLog: TrackdayResult[] = [];
  /** Called when a trackday ends (the HUD says how it went). */
  onTrackdayDone: ((r: TrackdayResult) => void) | null = null;
  /** Challenges received from friends (race/challenge.ts), most recent first. */
  challenges: Challenge[] = [];
  /**
   * Visiting a friend's world (share/world.ts): who they are and where their character stands. Such a state is
   * `ephemeral` (never saved); null for the player's own game. Not part of the save.
   */
  visit: { from: string; look: CharacterLook; player: PlayerSave | null; at: number } | null = null;
  /** Leaves a visit (main.ts: the player's own game back), and shares the player's world (« Partager mon monde »). */
  leaveVisit: (() => void) | null = null;
  shareWorld: (() => void) | null = null;

  /** Keeps a challenge received (the same one again replaces it at the top); returns its key. */
  addChallenge(c: Challenge): string {
    const key = challengeKey(c);
    this.challenges = [c, ...this.challenges.filter((x) => challengeKey(x) !== key)].slice(0, CHALLENGES_MAX);
    return key;
  }

  removeChallenge(key: string): void {
    this.challenges = this.challenges.filter((x) => challengeKey(x) !== key);
  }
  /**
   * Onboarding objectives done (data/objectives.ts ids), and what the actions record for them (assembled, race,
   * repair), plus creditsSpent: a repair was paid in credits (the HUD keeps the balance shown).
   */
  objectives: Record<string, boolean> = {};
  carCounter = 0;
  /** Dev/test states (stress layout) are never saved. */
  ephemeral = false;
  /** Player backpack. */
  inventory = new Inventory();
  /** Number of hub tiers unlocked (TIERS); a new game starts at 0. */
  tier = 0;

  constructor(sim?: FactorySim) {
    this.sim = sim ?? FactorySim.newGame();
  }

  /** Backpack first, then the hub (pays costs, receives refunds and pickups). */
  wallet(): Wallet {
    return new Wallet(this.inventory, this.sim.hub);
  }

  /** Parks the cars that have no place yet in free garage bays (not those with a car under construction); returns them. */
  parkCars(blocker?: BayBlocker): CarInstance[] {
    const garages = [...this.sim.buildings.values()].filter((b) => b.type === 'garage' && !this.builds.some((w) => w.garage === b.id));
    return parkUnplaced(this.cars, garages, blocker);
  }

  isUnlocked(type: BuildingType): boolean {
    return isUnlocked(type, this.tier);
  }

  /**
   * Pays the next tier from the wallet (backpack first, then hub) and unlocks it.
   * `ok: false` with `missing` when it cannot be paid, without `missing` when every tier is unlocked.
   */
  unlockNextTier(): { ok: boolean; missing?: ItemCounts } {
    const next = TIERS[this.tier];
    if (!next) return { ok: false };
    const wallet = this.wallet();
    const missing = wallet.missingFor(next.cost);
    if (missing) return { ok: false, missing };
    for (const [item, n] of Object.entries(next.cost) as [keyof ItemCounts, number][]) wallet.remove(item, n);
    this.tier++;
    return { ok: true };
  }

  /** The car is at the trackday (hidden from the factory, cannot drive, race, be sold or taken apart). */
  isAway(carId: string): boolean {
    return !!this.trackday?.plan.carIds.includes(carId);
  }

  /**
   * Starts a trackday: pays the catering and coaching (credits), sends the cars away until `ticks` from now. The
   * forecast is what will happen. Null when done, else why not.
   */
  startTrackday(plan: TrackdayPlan, forecast: TrackdayForecast, trackName: string): string | null {
    if (this.trackday) return 'Un trackday est déjà en cours';
    if (forecast.problem) return forecast.problem;
    if (forecast.guests <= 0) return 'Personne ne viendrait à ce prix';
    if (forecast.costs > 0 && !this.sim.spend(forecast.costs, 'trackday')) return 'Pas assez de crédits pour le repas, les boissons et le coaching';
    if (forecast.costs > 0) this.objectives.creditsSpent = true;
    this.trackday = { plan: { ...plan, carIds: [...plan.carIds] }, trackName, forecast, endTick: this.sim.tickCount + TRACKDAY.TICKS };
    return null;
  }

  /** Per factory tick: ends the trackday when its time is up (tickets credited, cars back worn and lighter in fuel). */
  tickTrackday(): void {
    const t = this.trackday;
    if (!t || this.sim.tickCount < t.endTick) return;
    this.trackday = null;
    const f = t.forecast;
    for (const r of f.cars) {
      const car = this.cars.find((c) => c.id === r.id);
      if (!car) continue;
      for (const [slot, w] of Object.entries(r.wear) as [keyof NonNullable<CarInstance['wear']>, number][]) {
        if (!car.parts[slot] || !(w > 0)) continue;
        (car.wear ??= {})[slot] = Math.min(WEAR.MAX, (car.wear[slot] ?? 0) + w);
      }
      if (r.fuel > 0) car.fuel = Math.min(FUEL.MAX, (car.fuel ?? 0) + r.fuel);
    }
    this.sim.earnTrackday(f.revenue);
    this.trackdayRep = f.reputation;
    const result: TrackdayResult = { trackName: t.trackName, guests: f.guests, revenue: f.revenue, costs: f.costs, satisfaction: f.satisfaction, reputation: f.reputation };
    this.trackdayLog = [result, ...this.trackdayLog].slice(0, TRACKDAY.LOG);
    this.objectives.trackday = true;
    this.onTrackdayDone?.(result);
  }

  get selectedCar(): CarInstance | null {
    return this.cars.find((c) => c.id === this.selectedCarId) ?? null;
  }

  serialize(): SaveData {
    return {
      version: 1,
      savedAt: Date.now(),
      factory: this.sim.serialize(),
      player: this.player,
      cars: this.cars,
      builds: this.builds,
      worn: this.worn,
      selectedCarId: this.selectedCarId,
      records: this.records,
      settings: this.settings,
      look: this.look,
      trackday: this.trackday,
      trackdayRep: this.trackdayRep,
      trackdayLog: this.trackdayLog,
      challenges: this.challenges,
      objectives: this.objectives,
      carCounter: this.carCounter,
      inventory: this.inventory.serialize(),
      tier: this.tier,
      tierMax: TIERS.length,
    };
  }

  static fromSave(data: SaveData): GameState {
    const s = new GameState(FactorySim.fromSave(data.factory));
    s.player = data.player ?? null;
    // Saves from the 64×64 map: the factory is shifted on load, the player follows.
    if (s.player && (data.factory.version ?? 1) < 3) {
      s.player = { ...s.player, x: s.player.x + LEGACY_MAP_OFFSET * FACTORY_CELL, z: s.player.z + LEGACY_MAP_OFFSET * FACTORY_CELL };
    }
    s.cars = Array.isArray(data.cars)
      ? data.cars.filter((c) => c && typeof c.id === 'string' && typeof c.blueprint === 'string').map((c) => {
        // A name from a save (maybe a friend's shared world) is shown in HTML hints: no markup, a sane length.
        const car: CarInstance = { ...c, name: cleanCarName(c.name, c.blueprint), parts: c.parts ?? {}, pose: sanitizePose(c.pose) };
        // Wear: only the installed parts, integers 1..1000; absent = new (no `wear` key at all).
        const wear = sanitizeWear(car.blueprint, car.parts, c.wear);
        if (wear) car.wear = wear;
        else delete car.wear;
        // Fuel: an integer 1..1000 ‰ used; absent (a save from before the fuel, a full tank) = full.
        const fuel = sanitizeFuel(car.blueprint, c.fuel);
        if (fuel) car.fuel = fuel;
        else delete car.fuel;
        return car;
      })
      : [];
    // On the relief, a car off the map or in the lake waits for a garage bay instead (« À ranger »); a
    // player deep in the lake starts at the spawn. A save made before the relief (built flat: no relief id)
    // also sends a car on a steep slope to a bay, and puts the others on the ground (they stood at 0 m:
    // on a hill, or in a garage now on its pad); a relief save keeps where the player left its cars.
    const relief = s.sim.terrain;
    if (!relief.flat) {
      const t = relief;
      const builtFlat = !isTerrainId(data.factory.terrain);
      const g = { gx: 0, gz: 0, twist: 0 };
      for (const c of s.cars) {
        const p = c.pose;
        if (!p) continue;
        const cx = Math.floor(p.x / FACTORY_CELL);
        const cz = Math.floor(p.z / FACTORY_CELL);
        const steep = builtFlat && s.sim.inBounds(cx, cz) && Math.max(Math.abs(t.cellGrad(cx, cz, g).gx), Math.abs(g.gz)) > TERRAIN_RULES.BELT_GRAD;
        if (!s.sim.inBounds(cx, cz) || steep || t.waterDepthAt(p.x, p.z) > 0.5) c.pose = null;
        else if (builtFlat) c.pose = { ...p, y: t.heightAt(p.x, p.z) };
      }
      if (s.player) {
        const edge = 20;
        const x = Math.max(-edge, Math.min(s.sim.width * FACTORY_CELL + edge, s.player.x));
        const z = Math.max(-edge, Math.min(s.sim.height * FACTORY_CELL + edge, s.player.z));
        s.player = t.waterDepthAt(x, z) > 1.2 ? null : { ...s.player, x, z };
      }
    }
    // The reserve of worn parts: whole slots of car parts only (an invalid entry is dropped, never made new).
    s.worn = Array.isArray(data.worn) ? data.worn.map(sanitizeWornSet).filter((w): w is WornSet => w !== null) : [];
    // Builds: one per existing garage; the parts of any other one go back to the hub, its worn sets to the reserve
    // (never to the hub as new parts).
    for (const raw of Array.isArray(data.builds) ? data.builds : []) {
      const b = sanitizeBuild(raw);
      if (!b) continue;
      if (s.sim.buildings.get(b.garage)?.type === 'garage' && !s.builds.some((w) => w.garage === b.garage)) s.builds.push(b);
      else {
        const refund: ItemCounts = {};
        refundBuild(refund, b, s.worn);
        s.sim.give(refund);
      }
    }
    // null = the loaner kart (a valid choice); fall back only when missing or dangling.
    const sel = data.selectedCarId;
    s.selectedCarId = sel === undefined ? (s.cars[0]?.id ?? null) : sel !== null && !s.cars.some((c) => c.id === sel) ? (s.cars[0]?.id ?? null) : sel;
    s.records = data.records ?? {};
    s.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
    if (!GRASS_QUALITIES.includes(s.settings.grass)) s.settings.grass = DEFAULT_SETTINGS.grass;
    s.look = sanitizeLook(data.look);
    s.trackdayRep = typeof data.trackdayRep === 'number' && Number.isFinite(data.trackdayRep) ? Math.max(0, Math.min(100, Math.round(data.trackdayRep))) : TRACKDAY.REP_START;
    s.trackdayLog = Array.isArray(data.trackdayLog) ? data.trackdayLog.filter(validResult).slice(0, TRACKDAY.LOG) : [];
    s.trackday = validTrackday(data.trackday, s) ? data.trackday : null;
    s.challenges = [];
    for (const raw of Array.isArray(data.challenges) ? data.challenges.slice(0, CHALLENGES_MAX) : []) {
      try {
        s.challenges.push(sanitizeChallenge(raw));
      } catch {
        // A broken challenge is dropped.
      }
    }
    s.objectives = data.objectives ?? {};
    s.carCounter = data.carCounter ?? s.cars.length;
    s.inventory = Inventory.fromSave(data.inventory);
    // Saves from before the tiers keep every building available, and so does a save that had every
    // tier of its version (tiers added later, like the garage, come unlocked).
    const t = data.tier;
    const savedMax = typeof data.tierMax === 'number' ? data.tierMax : 4;
    s.tier = typeof t === 'number' && Number.isFinite(t) ? (t >= savedMax ? TIERS.length : Math.max(0, Math.min(TIERS.length, Math.floor(t)))) : TIERS.length;
    return s;
  }

  /** Replaces this state's content in place (keeps references held by modes valid). */
  replaceWith(other: GameState): void {
    this.sim = other.sim;
    this.player = other.player;
    this.cars = other.cars;
    this.builds = other.builds;
    this.worn = other.worn;
    this.selectedCarId = other.selectedCarId;
    this.records = other.records;
    this.settings = other.settings;
    this.look = other.look;
    this.trackday = other.trackday;
    this.trackdayRep = other.trackdayRep;
    this.trackdayLog = other.trackdayLog;
    this.challenges = other.challenges;
    this.visit = other.visit;
    this.objectives = other.objectives;
    this.carCounter = other.carCounter;
    this.ephemeral = other.ephemeral;
    this.inventory = other.inventory;
    this.tier = other.tier;
  }
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validResult(r: unknown): r is TrackdayResult {
  if (!r || typeof r !== 'object') return false;
  const x = r as Record<string, unknown>;
  return typeof x.trackName === 'string' && num(x.guests) && num(x.revenue) && num(x.costs) && num(x.satisfaction) && num(x.reputation);
}

/** A running trackday from a save: its plan and forecast well formed, its cars still there (else it is dropped: the cars come back). */
function validTrackday(raw: unknown, s: GameState): raw is ActiveTrackday {
  if (!raw || typeof raw !== 'object') return false;
  const t = raw as ActiveTrackday;
  const p = t.plan;
  const f = t.forecast;
  if (!p || !Array.isArray(p.carIds) || !p.carIds.every((id) => typeof id === 'string' && s.cars.some((c) => c.id === id))) return false;
  if (typeof t.trackName !== 'string' || !num(t.endTick) || !f || !Array.isArray(f.cars)) return false;
  if (![f.guests, f.revenue, f.costs, f.satisfaction, f.reputation].every(num) || f.revenue < 0 || !Number.isSafeInteger(f.revenue)) return false;
  return f.cars.every((c) => c && typeof c.id === 'string' && num(c.fuel) && c.wear && typeof c.wear === 'object' && Object.values(c.wear).every(num));
}


/** A car's name from untrusted save data: no markup characters nor control characters, 40 at most, never empty. */
export function cleanCarName(raw: unknown, blueprint: string): string {
  const s = typeof raw === 'string' ? [...raw.replace(/[<>&"\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim()].slice(0, 40).join('').trim() : '';
  return s || (blueprint === 'sport' ? 'Sportive' : 'Kart Oopi');
}
