import { raceBlocker, type RaceBlock } from '../data/wear';
import { LOANER_SPEC, specOf, type CarInstance } from '../garage/assembly';
import type { CarSpec } from '../car/stats';
import type { WearMeter } from '../car/wearMeter';

/*
 * Which car a race drives, and whether it may start (pure: no three, no Rapier). A car with a part worn above
 * WEAR.BLOCK_ABOVE does not start a race: the loaner, which never wears, takes its place. The editor's test drive
 * and a forced spec (?car=) drive the car as new: they never wear it, and are never blocked.
 */

/** What raceCarFor reads of the game state. */
export interface RaceGarage {
  readonly cars: readonly CarInstance[];
  readonly selectedCar: CarInstance | null;
}

/** RaceParams' car choice (race/RaceMode.ts). */
export interface RaceCarParams {
  /** Assembled car (null = the loaner); defaults to the selected car, or to none when `spec` is forced. */
  carId?: string | null;
  /** Forced car (dev presets): drives as new, never wears. */
  spec?: CarSpec;
  /** Test drive from the editor: the chosen car as new, never worn nor blocked (the author time must not suffer). */
  test?: boolean;
}

export interface RaceCar {
  /** The car the run is for (records, the « race » objective); null for the loaner. */
  car: CarInstance | null;
  /** What drives. */
  spec: CarSpec;
  /** The car wears in this race (and drives worn: car/wornTuning.ts). */
  wears: boolean;
  /** The car asked for was blocked: the loaner drives instead (RaceMode tells the player). */
  fallback: RaceBlock<CarInstance> | null;
}

/**
 * The car of a race: `carId` when given (a car gone is the loaner), else the selected car unless `spec` is forced.
 * The test drive is checked before the block: a car to repair still sets an author time, as new.
 */
export function raceCarFor(state: RaceGarage, p: RaceCarParams): RaceCar {
  const car = p.carId !== undefined ? (state.cars.find((c) => c.id === p.carId) ?? null) : p.spec ? null : state.selectedCar;
  const spec = p.spec ?? specOf(car);
  if (p.test || p.spec || !car) return { car, spec, wears: false, fallback: null };
  const block = raceBlocker(car);
  if (block) return { car: null, spec: LOANER_SPEC, wears: false, fallback: block };
  return { car, spec, wears: true, fallback: null };
}

/**
 * Whether another attempt may start with the raced car (« Recommencer », « Réessayer »): it wore past the limit during
 * the session. Never for a car that does not wear (the loaner, a test drive, a forced spec).
 */
export function attemptGate(raced: Pick<RaceCar, 'car' | 'wears'>): RaceBlock<CarInstance> | null {
  return raced.wears ? raceBlocker(raced.car) : null;
}

/**
 * An attempt ends (the finish line, « Recommencer »): its last shock may still be open (the meter sums one over up to
 * WEAR.SHOCK_WINDOW steps and charges it at the close), so it is charged first; then attemptGate. `meter`: the raced
 * car's, null when it does not wear.
 */
export function endAttempt(raced: Pick<RaceCar, 'car' | 'wears'>, meter: Pick<WearMeter, 'closeShock'> | null): RaceBlock<CarInstance> | null {
  meter?.closeShock();
  return attemptGate(raced);
}
