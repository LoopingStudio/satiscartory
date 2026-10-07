import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GameState } from '../state/GameState';
import { BLUEPRINTS } from '../data/blueprints';
import { defaultChoices } from './assembly';
import { bayPose, type GarageSpot } from './parking';
import { applyChange, assembleCar, carLocation, checkAssembleIn, disassembleCar, partStock, selectRaceCar, swapCarPart } from './actions';

const KART = defaultChoices(BLUEPRINTS.kart);
const g1: GarageSpot = { id: 50, x: 40, z: 40, rot: 0 };
const g2: GarageSpot = { id: 51, x: 50, z: 40, rot: 1 };

/** A new game with kart parts split between the backpack and the hub. */
function stocked(): GameState {
  const s = new GameState();
  s.inventory.add('wheel', 2);
  s.sim.hub.add('chassis', 2);
  s.sim.hub.add('engine', 2);
  s.sim.hub.add('wheel', 6);
  return s;
}

describe('garage actions', () => {
  it('assembling pays the backpack first, numbers the car, parks it in the bay and makes it the race car', () => {
    const s = stocked();
    const car = assembleCar(s, 'kart', KART, g1)!;
    expect(car).not.toBeNull();
    expect(car.id).toBe('car-1');
    expect(s.carCounter).toBe(1);
    expect(s.inventory.count('wheel')).toBe(0);
    expect(s.sim.count('wheel')).toBe(4);
    expect(s.sim.count('chassis')).toBe(1);
    expect(car.pose).toEqual(bayPose(g1));
    expect(s.cars).toEqual([car]);
    expect(s.selectedCarId).toBe('car-1');
    expect(s.objectives.assembled).toBe(true);
  });

  it('refuses an occupied bay or missing parts without paying or numbering anything', () => {
    const s = stocked();
    assembleCar(s, 'kart', KART, g1);
    const before = partStock(s);
    expect(checkAssembleIn(s, 'kart', KART, g1)).toMatchObject({ ok: false, occupant: { id: 'car-1' } });
    expect(assembleCar(s, 'kart', KART, g1)).toBeNull();
    expect(partStock(s)).toEqual(before);
    expect(s.carCounter).toBe(1);
    // Another garage is free: the second car parks there.
    const second = assembleCar(s, 'kart', KART, g2)!;
    expect(second.id).toBe('car-2');
    expect(second.pose).toEqual(bayPose(g2));
    // Out of chassis and engines now.
    const empty = { ...g1, id: 52, x: 60 };
    expect(checkAssembleIn(s, 'kart', KART, empty)).toMatchObject({ ok: false, occupant: null, missing: { chassis: 1, engine: 1 } });
    expect(assembleCar(s, 'kart', KART, empty)).toBeNull();
    expect(s.carCounter).toBe(2);
    expect(s.cars).toHaveLength(2);
  });

  it('dismantling refunds every part to the backpack, overflowing to the hub', () => {
    const s = stocked();
    const a = assembleCar(s, 'kart', KART, g1)!;
    const b = assembleCar(s, 'kart', KART, g2)!;
    expect(s.selectedCarId).toBe(b.id);
    const res = disassembleCar(s, b.id)!;
    expect(res).toMatchObject({ refund: { chassis: 1, engine: 1, wheel: 4 }, toHub: 0 });
    expect(s.inventory.totals()).toEqual({ chassis: 1, engine: 1, wheel: 4 });
    expect(s.cars).toEqual([a]);
    expect(s.selectedCarId).toBe(a.id);
    // Full backpack: everything goes to the hub.
    s.inventory.slots.forEach((_, i) => s.inventory.takeSlot(i));
    s.inventory.add('iron_ore', 1e6);
    expect(disassembleCar(s, a.id)).toMatchObject({ toHub: 6 });
    expect(s.sim.count('wheel')).toBe(4);
    expect(s.selectedCarId).toBeNull();
    expect(disassembleCar(s, a.id)).toBeNull();
  });

  it('swapping a part trades with the wallet; the same part again is a no-op', () => {
    const s = stocked();
    const car = assembleCar(s, 'kart', KART, g1)!;
    const before = partStock(s);
    expect(swapCarPart(s, car.id, 'wheels', 'wheel')).toBe(false);
    expect(partStock(s)).toEqual(before);
    expect(swapCarPart(s, car.id, 'wheels', 'wheel_racing')).toBe(false); // none in stock
    s.inventory.add('wheel_racing', 2);
    s.sim.hub.add('wheel_racing', 4);
    expect(swapCarPart(s, car.id, 'wheels', 'wheel_racing')).toBe(true);
    expect(car.parts.wheels).toBe('wheel_racing');
    expect(s.sim.count('wheel_racing')).toBe(2); // backpack paid first…
    expect(s.inventory.count('wheel_racing')).toBe(0);
    expect(s.inventory.count('wheel')).toBe(4); // …and the old wheels came back to it
    expect(swapCarPart(s, car.id, 'wheels', null)).toBe(false); // required slot
    expect(swapCarPart(s, 'car-9', 'wheels', 'wheel')).toBe(false);
  });

  it('applyChange spends the backpack then the hub and reports the overflow', () => {
    const s = new GameState();
    s.inventory.add('bolt', 3);
    s.sim.hub.add('bolt', 10);
    expect(applyChange(s.wallet(), { bolt: 13 }, { bolt: 8 })).toBe(0);
    expect(s.inventory.count('bolt')).toBe(0);
    expect(s.sim.count('bolt')).toBe(8);
    s.inventory.add('iron_ore', 1e6);
    expect(applyChange(s.wallet(), {}, { plate: 5 })).toBe(5);
    expect(s.sim.count('plate')).toBe(5);
  });

  it('picks the race car (null = loaner) and tells where each car is', () => {
    const s = stocked();
    const car = assembleCar(s, 'kart', KART, g1)!;
    expect(selectRaceCar(s, car.id)).toBe(false); // already picked
    expect(selectRaceCar(s, null)).toBe(true);
    expect(s.selectedCarId).toBeNull();
    expect(selectRaceCar(s, 'car-9')).toBe(false);
    expect(s.selectedCarId).toBeNull();
    expect(carLocation(car, g1)).toBe('here');
    expect(carLocation(car, g2)).toBe('elsewhere');
    expect(carLocation(car, g1, car.id)).toBe('driving');
    expect(carLocation({ ...car, pose: null }, g1)).toBe('unplaced');
  });

  it('stays free of three and Rapier (Node-testable)', () => {
    for (const f of ['src/garage/actions.ts', 'src/garage/parking.ts']) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/from\s+['"](three|three\/.*|@dimforge\/.*)['"]/);
    }
  });
});

describe('bay occupancy (footprint, not just the center)', () => {
  it('a car centered in the doorway blocks the bay; a blocker sees cars that only overlap it', async () => {
    const { GameState } = await import('../state/GameState');
    const { bayPose, bayRect, bayOccupant, carInBay } = await import('./parking');
    const state = new GameState();
    const g = { id: 1, x: 10, z: 10, rot: 0 as const };
    const bay = bayPose(g);
    const [, , , maxZ] = bayRect(g);
    // Center just inside the open front: counted by the pure fallback.
    const doorway = { id: 'car-d', name: 'D', blueprint: 'sport', parts: {}, pose: { x: bay.x, y: 0, z: maxZ - 0.3, yaw: 0 } };
    expect(carInBay([doorway], g)?.id).toBe('car-d');
    // Center outside the garage, body still across the door: only a physical blocker sees it.
    const halfOut = { ...doorway, id: 'car-h', pose: { x: bay.x, y: 0, z: maxZ + 1, yaw: 0 } };
    state.cars = [halfOut];
    expect(bayOccupant(state.cars, g)).toBeNull();
    expect(bayOccupant(state.cars, g, () => halfOut)?.id).toBe('car-h');
    // Rotated garages keep the rectangle around the bay pose.
    for (const rot of [1, 2, 3] as const) {
      const r = bayRect({ x: 10, z: 10, rot });
      const p = bayPose({ x: 10, z: 10, rot });
      expect(p.x).toBeGreaterThan(r[0]);
      expect(p.x).toBeLessThan(r[2]);
      expect(p.z).toBeGreaterThan(r[1]);
      expect(p.z).toBeLessThan(r[3]);
    }
  });
});
