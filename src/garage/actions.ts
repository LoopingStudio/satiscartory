import { CAR_PARTS, type BlueprintId } from '../data/blueprints';
import { ITEM_IDS, type Inventory as ItemCounts, type ItemId } from '../data/items';
import { clearSlotWear } from '../data/wear';
import type { GameState } from '../state/GameState';
import type { Wallet } from '../state/Inventory';
import { assemble, checkAssembly, disassemble, swapPart, type AssemblyCheck, type CarInstance, type PartChoices } from './assembly';
import { bayOccupant, bayPose, carInBay, type BayBlocker, type GarageSpot } from './parking';

/*
 * Garage actions on the game state (no DOM, no three). Parts are paid from the wallet (backpack first,
 * then the hub) and refunds go to the backpack first, the overflow to the hub.
 * Callers persist (SaveManager.save) and re-sync the physical cars after a change.
 */

export { CAR_PARTS };

/** Car parts in stock (backpack + hub). */
export function partStock(state: GameState): ItemCounts {
  return state.wallet().totals(CAR_PARTS);
}

/**
 * Applies the difference between two count snapshots to the wallet: removals drain the backpack then the hub,
 * additions fill the backpack and overflow to the hub. Returns how many items overflowed to the hub.
 */
export function applyChange(wallet: Wallet, before: ItemCounts, after: ItemCounts): number {
  let toHub = 0;
  for (const id of ITEM_IDS) {
    const d = (after[id] ?? 0) - (before[id] ?? 0);
    if (d < 0) wallet.remove(id, -d);
    else if (d > 0) {
      const inBag = wallet.primary.add(id, d);
      if (inBag < d) wallet.fallback.add(id, d - inBag);
      toHub += d - inBag;
    }
  }
  return toHub;
}

export function findCar(state: GameState, id: string | null): CarInstance | null {
  return id ? (state.cars.find((c) => c.id === id) ?? null) : null;
}

/** Where a car is, seen from a garage. */
export type CarLocation = 'here' | 'elsewhere' | 'driving' | 'unplaced';

export function carLocation(car: CarInstance, garage: GarageSpot, drivenId: string | null = null): CarLocation {
  if (car.id === drivenId) return 'driving';
  if (!car.pose) return 'unplaced';
  return carInBay([car], garage) ? 'here' : 'elsewhere';
}

export interface AssembleCheck extends AssemblyCheck {
  /** Car already standing in the bay (assembling is refused). */
  occupant: CarInstance | null;
  /** A car under construction in the bay (assembling is refused too). */
  build: boolean;
}

/** Can this draft be assembled in this garage? (parts in stock and a free bay). */
export function checkAssembleIn(state: GameState, bpId: BlueprintId, choices: PartChoices, garage: GarageSpot, blocker?: BayBlocker): AssembleCheck {
  const check = checkAssembly(partStock(state), bpId, choices);
  const occupant = bayOccupant(state.cars, garage, blocker);
  const build = state.builds.some((b) => b.garage === garage.id);
  return { ...check, ok: check.ok && !occupant && !build, occupant, build };
}

/**
 * Assembles a car in the garage's bay: pays the parts, numbers it, parks it in the bay, makes it the race car
 * and completes the « assembled » objective. Null (nothing changed) if parts are missing or the bay is taken.
 */
export function assembleCar(state: GameState, bpId: BlueprintId, choices: PartChoices, garage: GarageSpot, blocker?: BayBlocker): CarInstance | null {
  if (bayOccupant(state.cars, garage, blocker) || state.builds.some((b) => b.garage === garage.id)) return null;
  const before = partStock(state);
  const after = { ...before };
  const car = assemble(after, bpId, choices, state.carCounter + 1);
  if (!car) return null;
  state.carCounter++;
  applyChange(state.wallet(), before, after);
  // On the garage's pad (the sim's, should the spot not carry it).
  car.pose = bayPose({ ...garage, py: garage.py ?? state.sim.buildings.get(garage.id)?.py });
  state.cars.push(car);
  state.selectedCarId = car.id;
  state.objectives.assembled = true;
  return car;
}

/**
 * Dismantles a car: its parts go to the backpack (overflow: hub) and it leaves the garage.
 * The race car falls back to the first remaining car (or the loaner). Null if there is no such car.
 */
export function disassembleCar(state: GameState, carId: string): { car: CarInstance; refund: ItemCounts; toHub: number } | null {
  const car = findCar(state, carId);
  if (!car) return null;
  const refund: ItemCounts = {};
  disassemble(refund, car);
  const toHub = applyChange(state.wallet(), {}, refund);
  state.cars = state.cars.filter((c) => c !== car);
  if (state.selectedCarId === car.id) state.selectedCarId = state.cars[0]?.id ?? null;
  return { car, refund, toHub };
}

/**
 * Sells a car: it leaves the game with its parts, its price (the dealer's: data/sales.ts carPrice) is credited
 * and counted by the sim. The race car falls back to the first remaining car (or the loaner); car numbers are
 * never reused. Null if there is no such car. Callers only offer it for a car standing in the bay, like « Démonter ».
 */
export function sellCar(state: GameState, carId: string): { car: CarInstance; price: number } | null {
  const car = findCar(state, carId);
  if (!car) return null;
  const price = state.sim.sell(car.blueprint, car.parts);
  state.cars = state.cars.filter((c) => c !== car);
  if (state.selectedCarId === car.id) state.selectedCarId = state.cars[0]?.id ?? null;
  return { car, price };
}

/**
 * Installs `item` in a slot (null empties an optional slot): the new parts are paid from the wallet,
 * the old ones go back to it. False when nothing changed (same part, not enough in stock, invalid slot).
 * For now the slot's wear goes with the old parts (the reserve of worn parts will keep it).
 */
export function swapCarPart(state: GameState, carId: string, slotId: string, item: ItemId | null): boolean {
  const car = findCar(state, carId);
  if (!car || (car.parts[slotId] ?? null) === item) return false;
  const before = partStock(state);
  const after = { ...before };
  if (!swapPart(after, car, slotId, item)) return false;
  applyChange(state.wallet(), before, after);
  clearSlotWear(car, slotId);
  return true;
}

/** Picks the car to race (null = the loaner kart). False if the car does not exist or is already picked. */
export function selectRaceCar(state: GameState, carId: string | null): boolean {
  if (carId !== null && !findCar(state, carId)) return false;
  if (state.selectedCarId === carId) return false;
  state.selectedCarId = carId;
  return true;
}
