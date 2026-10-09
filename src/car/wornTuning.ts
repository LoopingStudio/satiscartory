import { WEAR } from '../data/balance';
import { blueprintById, type SlotId } from '../data/blueprints';
import { isItemId } from '../data/items';
import { PART_MODIFIERS } from '../data/parts';
import { slotCountFor, type CarWear } from '../data/wear';
import { computeCarStats, type CarSpec } from './stats';
import { tuningFromStats, type VehicleTuning } from './tuning';

/*
 * What wear does to the driving (pure: no three, no Rapier). It acts on the final tuning, never on the mass, the
 * center of mass or the suspensions (baked into the body when it is created), nor on topSpeedMs (it scales the
 * steering): the top speed comes from the engine against the drag. Without wear the very same tuning object comes
 * back: a new car drives bit for bit like before.
 */

/** Effect level of a wear (‰): L(u) = u(1 + 3u)/4 with u = w / WEAR.MAX, 0 when new, 0.68 at the race limit, 1 worn out. */
export function wearCurve(w: number): number {
  const u = Number.isFinite(w) ? Math.min(1, Math.max(0, w / WEAR.MAX)) : 0;
  return (u * (1 + 3 * u)) / 4;
}

/** Effect level of an installed slot (0: new, empty, or not a finite number). */
function levelOf(wear: Readonly<CarWear>, parts: Readonly<Record<string, unknown>>, slot: SlotId): number {
  return parts[slot] ? wearCurve(wear[slot] ?? 0) : 0;
}

/**
 * The tuning of a car worn as `wear` (its installed `parts` only): the same object `t` when nothing is worn, else a
 * worn copy (WEAR.EFFECT). Wheels: the three frictions; engine: its forward and reverse force; chassis: steering and
 * brakes; panels: more drag; spoiler: its own share of the downforce only (its part's downforce × count × mass).
 */
export function wornTuning(t: VehicleTuning, wear: Readonly<CarWear> | undefined, parts: Readonly<Record<string, unknown>>): VehicleTuning {
  if (!wear) return t;
  const wheels = levelOf(wear, parts, 'wheels');
  const engine = levelOf(wear, parts, 'engine');
  const chassis = levelOf(wear, parts, 'chassis');
  const panels = levelOf(wear, parts, 'panels');
  const spoiler = levelOf(wear, parts, 'spoiler');
  if (wheels === 0 && engine === 0 && chassis === 0 && panels === 0 && spoiler === 0) return t;
  const e = WEAR.EFFECT;
  const out: VehicleTuning = { ...t };
  if (wheels > 0) {
    const k = 1 - e.grip * wheels;
    out.frictionSlip = t.frictionSlip * k;
    out.sideFrictionStiffness = t.sideFrictionStiffness * k;
    out.driftSideFriction = t.driftSideFriction * k;
  }
  if (engine > 0) {
    const k = 1 - e.engine * engine;
    out.engineN = t.engineN * k;
    out.reverseN = t.reverseN * k;
  }
  if (chassis > 0) {
    out.steerMaxRad = t.steerMaxRad * (1 - e.steer * chassis);
    out.brakeN = t.brakeN * (1 - e.brake * chassis);
  }
  if (panels > 0) out.dragK = t.dragK * (1 + e.drag * panels);
  if (spoiler > 0) {
    const item = parts.spoiler;
    const share = isItemId(item) ? ((PART_MODIFIERS[item]?.downforce ?? 0) * (slotCountFor(item) ?? 1) * t.massKg) / 1000 : 0;
    out.downforceK = t.downforceK - e.spoiler * spoiler * share;
  }
  return out;
}

/** Relative change of each feel of a worn car (−0.04 = −4 %), for the UI; all 0 when new. */
export interface WearEffects {
  /** Tire friction (the three frictions change alike). */
  grip: number;
  /** Engine force. */
  power: number;
  /** Top speed (√(engine / drag)). */
  topSpeed: number;
  steer: number;
  brake: number;
  downforce: number;
}

/** What the wear changes on a car of `spec` (its tuning compared with a new one's). */
export function wearEffects(spec: CarSpec, wear: Readonly<CarWear> | undefined): WearEffects {
  const none: WearEffects = { grip: 0, power: 0, topSpeed: 0, steer: 0, brake: 0, downforce: 0 };
  if (!blueprintById(spec.blueprint)) return none;
  const t = tuningFromStats(computeCarStats(spec));
  const w = wornTuning(t, wear, spec.parts);
  if (w === t) return none;
  const ratio = (a: number, b: number) => (b > 0 ? a / b - 1 : 0);
  return {
    grip: ratio(w.frictionSlip, t.frictionSlip),
    power: ratio(w.engineN, t.engineN),
    topSpeed: Math.sqrt(w.engineN / w.dragK / (t.engineN / t.dragK)) - 1,
    steer: ratio(w.steerMaxRad, t.steerMaxRad),
    brake: ratio(w.brakeN, t.brakeN),
    downforce: ratio(w.downforceK, t.downforceK),
  };
}
