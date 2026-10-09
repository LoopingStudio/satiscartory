import type { BlueprintId } from '../data/blueprints';
import type { Inventory as ItemCounts, ItemId } from '../data/items';
import type { GameState } from '../state/GameState';
import type { CarInstance } from './assembly';
import { applyChange, partStock } from './actions';
import { buildComplete, buildEmpty, carFromBuild, installPart, leftovers, newBuild, refundBuild, removePart, type CarBuild } from './build';
import { bayOccupant, bayPose, type BayBlocker, type GarageSpot } from './parking';

/*
 * Car builds (« chantiers ») on the game state: parts are paid from the wallet (backpack first, then the hub),
 * given back to the backpack first (overflow: hub); a worn set (garage/wearActions.ts) goes back to the reserve.
 * Callers persist and re-sync the physical cars after a change.
 */

/** The build standing in this garage's bay, if any. */
export function buildIn(state: GameState, garageId: number): CarBuild | null {
  return state.builds.find((b) => b.garage === garageId) ?? null;
}

/**
 * Rolls a complete build out as a car in the bay: numbered, made the race car, « assembled » objective. Null (nothing
 * changed) while the build is not complete.
 */
export function rollOut(state: GameState, build: CarBuild, garage: GarageSpot): CarInstance | null {
  const car = carFromBuild(build, state.carCounter + 1);
  if (!car) return null;
  state.carCounter++;
  applyChange(state.wallet(), {}, leftovers(build));
  state.builds = state.builds.filter((b) => b !== build);
  // On the garage's pad (the sim's, should the spot not carry it).
  car.pose = bayPose({ ...garage, py: garage.py ?? state.sim.buildings.get(garage.id)?.py });
  state.cars.push(car);
  state.selectedCarId = car.id;
  state.objectives.assembled = true;
  return car;
}

/**
 * Installs `item` in a slot of the build in this garage (as many as the slot still takes and the stock has),
 * starting a build of `blueprint` when the bay is empty. When every required slot is full the car rolls out.
 * `n` = 0 when nothing changed: no such part in stock, a car in the bay, a build of another blueprint there,
 * or another kind of item already in that slot.
 */
export function installBuildPart(
  state: GameState,
  garage: GarageSpot,
  blueprint: BlueprintId,
  slotId: string,
  item: ItemId,
  blocker?: BayBlocker,
): { n: number; car: CarInstance | null } {
  let build = buildIn(state, garage.id);
  const fresh = !build;
  if (!build) {
    if (bayOccupant(state.cars, garage, blocker)) return { n: 0, car: null };
    build = newBuild(garage.id, blueprint);
  } else if (build.blueprint !== blueprint) return { n: 0, car: null };
  const before = partStock(state);
  const after = { ...before };
  const n = installPart(after, build, slotId, item);
  if (!n) return { n: 0, car: null };
  applyChange(state.wallet(), before, after);
  if (fresh) state.builds.push(build);
  return { n, car: buildComplete(build) ? rollOut(state, build, garage) : null };
}

/**
 * Takes a slot's parts off the build (to the backpack, overflow: hub; a worn set to the reserve, with its wear). An
 * emptied build frees the bay.
 */
export function removeBuildPart(state: GameState, garageId: number, slotId: string): { n: number; toHub: number } {
  const build = buildIn(state, garageId);
  if (!build) return { n: 0, toHub: 0 };
  const refund: ItemCounts = {};
  const n = removePart(refund, build, slotId, state.worn);
  const toHub = applyChange(state.wallet(), {}, refund);
  if (buildEmpty(build)) state.builds = state.builds.filter((b) => b !== build);
  return { n, toHub };
}

/**
 * Gives up the build in this garage: every new part back (backpack first, overflow: hub), every worn set to the
 * reserve. Null if there is none.
 */
export function abandonBuild(state: GameState, garageId: number): { refund: ItemCounts; toHub: number } | null {
  const build = buildIn(state, garageId);
  if (!build) return null;
  const refund: ItemCounts = {};
  refundBuild(refund, build, state.worn);
  state.builds = state.builds.filter((b) => b !== build);
  return { refund, toHub: applyChange(state.wallet(), {}, refund) };
}
