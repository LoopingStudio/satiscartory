import { WEAR } from '../data/balance';
import { blueprintById, type SlotId } from '../data/blueprints';
import type { WearCar } from '../data/wear';

/*
 * Wear meter of a car being driven (pure: no three, no Rapier). One step() per fixed physics step (60 Hz), right after
 * Vehicle.step(): the wheels and the engine wear with the distance, the body parts with the shocks, and putBack()
 * charges a respawn by its cause. The car's wear is written in place as soon as a slot gets a whole thousandth (like
 * the live pose of a driven car): a save may happen at any time. The fractions wait here; end() rounds them.
 */

/** Why the car was put back on the road: the respawn key, stuck, on its side or roof, a fall (or off the map), the water. */
export type ResetCause = keyof typeof WEAR.RESET;
export type WearCause = 'shock' | ResetCause;

/**
 * Cause of an automatic put-back: a fall (or off the map), else on its side or roof (its rotation `q` tilts the up
 * axis to y < 0.5, like Vehicle's flip timer), else stuck.
 */
export function autoResetCause(fell: boolean, q: { readonly x: number; readonly z: number }): ResetCause {
  return fell ? 'fall' : 1 - 2 * (q.x * q.x + q.z * q.z) < 0.5 ? 'flip' : 'stuck';
}

/** What the meter reads of a vehicle after its step (a Vehicle). */
export interface WearSource {
  readonly speed: number;
  readonly lateralSpeed: number;
  readonly wheelsInContact: number;
  readonly impact: number;
  readonly impactX: number;
  readonly impactY: number;
  readonly impactZ: number;
}

/** The controls of that step (VehicleControls). */
export interface WearControls {
  readonly throttle: number;
  readonly handbrake: boolean;
}

/** The last damage (HUD flash, sparks), written in place: `seq` grows only when the most hit slot took 1 ‰ or more. */
export interface WearHit {
  seq: number;
  cause: WearCause;
  /** The most hit slot. */
  slot: SlotId;
  /** ‰ it took (not rounded). */
  permille: number;
  /** Direction (world, unit vector) of the speed change of a shock: away from what was hit. 0 for a put-back. */
  dx: number;
  dy: number;
  dz: number;
}

type BodySlot = keyof typeof WEAR.SHOCK_K;
/** The parts the shocks and the put-backs wear (when installed: a kart has no panels). */
const BODY: readonly BodySlot[] = ['chassis', 'panels', 'spoiler'];
const SLOTS: readonly SlotId[] = ['chassis', 'engine', 'wheels', 'panels', 'spoiler'];

export class WearMeter {
  readonly last: WearHit = { seq: 0, cause: 'shock', slot: 'chassis', permille: 0, dx: 0, dy: 0, dz: 0 };
  /** Fractions of a thousandth not written yet, per slot. */
  private readonly rest: Record<SlotId, number> = { chassis: 0, engine: 0, wheels: 0, panels: 0, spoiler: 0 };
  /** Slots of the car's blueprint (an unknown blueprint wears nothing). */
  private readonly slotted: Record<SlotId, boolean> = { chassis: false, engine: false, wheels: false, panels: false, spoiler: false };
  /** Open shock window: its steps (0 = closed), the summed speed changes and their summed vector. */
  private shockSteps = 0;
  private shockDv = 0;
  private shockX = 0;
  private shockY = 0;
  private shockZ = 0;

  constructor(private readonly car: WearCar) {
    for (const s of blueprintById(car.blueprint)?.slots ?? []) this.slotted[s.id] = true;
  }

  /**
   * One fixed step of driving (controls applied, the car rolling). A step whose readings are not finite numbers (a
   * body gone wild) is ignored: no NaN ever reaches the save.
   */
  step(dt: number, v: WearSource, c: WearControls): void {
    if (!(dt > 0) || !Number.isFinite(dt + v.speed + v.lateralSpeed + v.wheelsInContact + v.impact + v.impactX + v.impactY + v.impactZ + c.throttle)) return;
    const ground = Math.min(1, v.wheelsInContact / 4);
    const km = (Math.abs(v.speed) * dt) / 1000;
    if (ground > 0) {
      const slid = (Math.max(0, v.lateralSpeed - WEAR.SLIP_FREE) * dt) / 1000;
      this.add('wheels', ground * (km * (WEAR.TIRE_PER_KM + (c.handbrake ? WEAR.TIRE_HANDBRAKE_PER_KM : 0)) + slid * WEAR.TIRE_SLIDE_PER_KM));
    }
    this.add('engine', km * (WEAR.ENGINE_PER_KM + WEAR.ENGINE_THROTTLE_PER_KM * Math.min(1, Math.max(0, c.throttle))));
    // A shock spread by the solver over a few steps costs what it would in one: summed first, charged at the close.
    if (v.impact > WEAR.SHOCK_FLOOR) {
      this.shockSteps++;
      this.shockDv += v.impact;
      this.shockX += v.impactX;
      this.shockY += v.impactY;
      this.shockZ += v.impactZ;
      if (this.shockSteps >= WEAR.SHOCK_WINDOW) this.closeShock();
    } else this.closeShock();
  }

  /** Charges the open shock window, if any (a step that is not counted: countdown, finish, pause). */
  closeShock(): void {
    if (this.shockSteps === 0) return;
    const over = Math.max(0, this.shockDv - WEAR.SHOCK_FREE);
    const len = Math.hypot(this.shockX, this.shockY, this.shockZ) || 1;
    const dx = this.shockX / len;
    const dy = this.shockY / len;
    const dz = this.shockZ / len;
    this.shockSteps = 0;
    this.shockDv = 0;
    this.shockX = 0;
    this.shockY = 0;
    this.shockZ = 0;
    if (over === 0) return;
    let slot: BodySlot | null = null;
    let most = 0;
    for (const s of BODY) {
      if (!this.installed(s)) continue;
      const cost = Math.min(WEAR.SHOCK_MAX, WEAR.SHOCK_K[s] * over * over);
      this.add(s, cost);
      if (cost > most) {
        most = cost;
        slot = s;
      }
    }
    if (slot) this.hit('shock', slot, most, dx, dy, dz);
  }

  /** The car is put back on the road (a respawn): closes the shock, then charges the cause's flat wear. */
  putBack(cause: ResetCause): void {
    this.closeShock();
    const cost = WEAR.RESET[cause];
    let slot: BodySlot | null = null;
    let most = 0;
    for (const s of BODY) {
      if (!this.installed(s)) continue;
      this.add(s, cost[s]);
      if (cost[s] > most) {
        most = cost[s];
        slot = s;
      }
    }
    if (slot) this.hit(cause, slot, most, 0, 0, 0);
  }

  /** The drive is over: closes the shock and rounds the fractions (half a thousandth or more counts as one). */
  end(): void {
    this.closeShock();
    for (const s of SLOTS) {
      const r = this.rest[s];
      this.rest[s] = 0;
      if (r >= 0.5) this.write(s, 1);
    }
  }

  /** Wear of a slot (‰) with the fractions not written yet (calibration, tests); an open shock is not in. */
  exact(slot: SlotId): number {
    return (this.car.wear?.[slot] ?? 0) + this.rest[slot];
  }

  private installed(slot: SlotId): boolean {
    return this.slotted[slot] && !!this.car.parts[slot];
  }

  private add(slot: SlotId, permille: number): void {
    if (!(permille > 0) || !this.installed(slot)) return;
    const r = this.rest[slot] + permille;
    const whole = Math.floor(r);
    this.rest[slot] = r - whole;
    if (whole > 0) this.write(slot, whole);
  }

  /** Adds whole thousandths to the car (the `wear` key comes with the first one), up to WEAR.MAX. */
  private write(slot: SlotId, n: number): void {
    if (!this.installed(slot)) return;
    const cur = this.car.wear?.[slot] ?? 0;
    const next = Math.min(WEAR.MAX, cur + n);
    if (next !== cur) (this.car.wear ??= {})[slot] = next;
  }

  private hit(cause: WearCause, slot: SlotId, permille: number, dx: number, dy: number, dz: number): void {
    if (permille < 1) return;
    const h = this.last;
    h.seq++;
    h.cause = cause;
    h.slot = slot;
    h.permille = permille;
    h.dx = dx;
    h.dy = dy;
    h.dz = dz;
  }
}
