import { FUEL, SALE } from './balance';
import { PART_VALUES } from './sales';

/*
 * Fuel of the assembled cars (pure): integer thousandths of the tank USED, 0 = full (no `fuel` key: a new car, an old
 * save), FUEL.MAX = dry. A dry car's engine gives nothing (it still rolls and brakes); one in the reserve (above
 * FUEL.BLOCK_ABOVE) does not start a race. Filling up takes fuel cans (« Bidon d'essence », FUEL.CAN_L liters each) or
 * credits. The loaner has no tank: it never burns anything.
 */

/** What fuel reads of a car (a CarInstance). */
export interface FuelCar {
  blueprint: string;
  /** ‰ of the tank used (1..FUEL.MAX); absent = full. */
  fuel?: number;
}

/** Tank of a blueprint in liters (0: no tank, the loaner or an unknown blueprint). */
export function tankLiters(blueprint: string): number {
  return Object.hasOwn(FUEL.TANK_L, blueprint) ? FUEL.TANK_L[blueprint]! : 0;
}

/** ‰ of the tank used, clamped (garbage reads full). */
export function fuelUsed(car: FuelCar): number {
  const f = car.fuel;
  return typeof f === 'number' && Number.isFinite(f) ? Math.min(FUEL.MAX, Math.max(0, f)) : 0;
}

/** Fuel shown (%): 100 only when full, 0 dry. */
export function fuelPct(used: number): number {
  return Math.floor((FUEL.MAX - Math.min(FUEL.MAX, Math.max(0, used))) / 10);
}

/** Liters left in the tank, to the tenth. */
export function litersLeft(car: FuelCar): number {
  return Math.round((tankLiters(car.blueprint) * (FUEL.MAX - fuelUsed(car))) / (FUEL.MAX / 10)) / 10;
}

/** Dry: the engine gives nothing. Never for a car without a tank. */
export function isDry(car: FuelCar): boolean {
  return tankLiters(car.blueprint) > 0 && fuelUsed(car) >= FUEL.MAX;
}

/** In the reserve: the car does not start a race. Never for a car without a tank. */
export function fuelBlocked(car: FuelCar): boolean {
  return tankLiters(car.blueprint) > 0 && fuelUsed(car) > FUEL.BLOCK_ABOVE;
}

export type FuelTone = 'good' | 'warn' | 'bad';

/** Colour of a fuel level: orange above FUEL.WARN_ABOVE used, red in the reserve. */
export function fuelTone(used: number): FuelTone {
  return used > FUEL.BLOCK_ABOVE ? 'bad' : used > FUEL.WARN_ABOVE ? 'warn' : 'good';
}

/** Liters missing to fill the tank up. */
function missingLiters(car: FuelCar): number {
  return (tankLiters(car.blueprint) * fuelUsed(car)) / FUEL.MAX;
}

/** Fuel cans that fill the tank up (the last one may not be poured whole); 0 when full. */
export function fillCans(car: FuelCar): number {
  return fuelUsed(car) > 0 ? Math.ceil(missingLiters(car) / FUEL.CAN_L - 1e-9) : 0;
}

/**
 * Credits that fill the tank up: the liters missing at the value of a can (PART_VALUES) with the dealer's margin, rounded
 * up to SALE.ROUND, so at least 10 cr from 1 ‰ on; 0 when full.
 */
export function fillCredits(car: FuelCar): number {
  const used = fuelUsed(car);
  if (used <= 0) return 0;
  const value = (missingLiters(car) / FUEL.CAN_L) * PART_VALUES.fuel_can * (SALE.MARGIN_NUM / SALE.MARGIN_DEN);
  return Math.max(SALE.ROUND, Math.ceil(value / SALE.ROUND - 1e-9) * SALE.ROUND);
}

/** Pours `cans` fuel cans into the tank (capped at full): the `fuel` key goes when full. Returns the ‰ added. */
export function pourCans(car: FuelCar, cans: number): number {
  const tank = tankLiters(car.blueprint);
  const used = fuelUsed(car);
  if (!(tank > 0) || !(cans > 0) || used <= 0) return 0;
  const add = Math.min(used, Math.round((cans * FUEL.CAN_L * FUEL.MAX) / tank));
  setUsed(car, used - add);
  return add;
}

/** Fills the tank up (paid in credits elsewhere). */
export function fillUp(car: FuelCar): void {
  setUsed(car, 0);
}

function setUsed(car: FuelCar, used: number): void {
  if (used > 0) car.fuel = Math.min(FUEL.MAX, Math.round(used));
  else delete car.fuel;
}

/** A car's fuel from untrusted save data: an integer 1..FUEL.MAX for a car with a tank, else undefined (full). */
export function sanitizeFuel(blueprint: unknown, raw: unknown): number | undefined {
  if (typeof blueprint !== 'string' || tankLiters(blueprint) <= 0) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  const v = Math.min(FUEL.MAX, Math.max(0, Math.round(raw)));
  return v > 0 ? v : undefined;
}

/**
 * Fuel burned by a car being driven (pure). One step() per fixed physics step: FUEL.PER_KM ‰ of the tank per km at full
 * throttle, FUEL.IDLE_SHARE of it rolling without throttle. Whole thousandths are written in place at once (a save may
 * happen at any time); the fractions wait here, end() rounds them (half a thousandth or more counts as one).
 */
export class FuelMeter {
  private rest = 0;
  private readonly burns: boolean;

  constructor(private readonly car: FuelCar) {
    this.burns = tankLiters(car.blueprint) > 0;
  }

  /** The tank is dry: the engine gives nothing. */
  get dry(): boolean {
    return isDry(this.car);
  }

  /** One fixed step of driving: `speed` m/s (either way), `throttle` 0..1. Garbage readings are ignored. */
  step(dt: number, speed: number, throttle: number): void {
    if (!this.burns || !(dt > 0) || !Number.isFinite(speed + throttle) || this.dry) return;
    const km = (Math.abs(speed) * dt) / 1000;
    const t = Math.min(1, Math.max(0, throttle));
    this.add(km * FUEL.PER_KM * (FUEL.IDLE_SHARE + (1 - FUEL.IDLE_SHARE) * t));
  }

  /** The drive is over: rounds the fraction. */
  end(): void {
    const r = this.rest;
    this.rest = 0;
    if (r >= 0.5) this.write(1);
  }

  /** ‰ used with the fraction not written yet (tests, calibration). */
  exact(): number {
    return fuelUsed(this.car) + this.rest;
  }

  private add(permille: number): void {
    if (!(permille > 0)) return;
    const r = this.rest + permille;
    const whole = Math.floor(r);
    this.rest = r - whole;
    if (whole > 0) this.write(whole);
  }

  private write(n: number): void {
    const next = Math.min(FUEL.MAX, fuelUsed(this.car) + n);
    setUsed(this.car, next);
    // Dry: nothing left to burn, no fraction either.
    if (next >= FUEL.MAX) this.rest = 0;
  }
}
