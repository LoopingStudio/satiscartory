import { describe, expect, it } from 'vitest';
import { GameState } from '../state/GameState';
import { FactorySim } from '../factory/sim/FactorySim';
import { BLUEPRINTS } from '../data/blueprints';
import { defaultChoices } from './assembly';
import { bayPose, type GarageSpot } from './parking';
import { assembleCar, checkAssembleIn, partStock } from './actions';
import { abandonBuild, buildIn, installBuildPart, removeBuildPart } from './buildActions';
import type { Inventory as ItemCounts } from '../data/items';

const g1: GarageSpot = { id: 50, x: 40, z: 40, rot: 0 };
const total = (c: ItemCounts) => Object.values(c).reduce((a, n) => a + (n ?? 0), 0);

/** A new game with two wheels in the backpack and a chassis in the hub. */
function started(): GameState {
  // Flat ground: the garage at (40, 40) is about build actions, not about the relief.
  const s = new GameState(FactorySim.newGame({ terrain: 'flat' }));
  s.inventory.add('wheel', 2);
  s.sim.hub.add('chassis', 1);
  return s;
}

describe('car builds in a garage', () => {
  it('starts a build with the wheels at hand and keeps the bay for it', () => {
    const s = started();
    const placed = s.sim.place('garage', 40, 40, 0, { free: true, force: true });
    const g: GarageSpot = { id: placed.ok ? placed.building.id : -1, x: 40, z: 40, rot: 0 };
    const r = installBuildPart(s, g, 'kart', 'wheels', 'wheel');
    expect(r).toEqual({ n: 2, car: null });
    expect(s.inventory.count('wheel')).toBe(0);
    expect(buildIn(s, g.id)).toEqual({ garage: g.id, blueprint: 'kart', parts: { wheels: { item: 'wheel', n: 2 } } });
    // The bay is taken: no one-shot assembly, no other blueprint, and a waiting car does not park there.
    expect(checkAssembleIn(s, 'kart', defaultChoices(BLUEPRINTS.kart), g)).toMatchObject({ ok: false, build: true });
    s.sim.hub.add('chassis', 1);
    expect(installBuildPart(s, g, 'sport', 'chassis', 'chassis').n).toBe(0);
    s.cars.push({ id: 'old', name: 'Old', blueprint: 'kart', parts: {}, pose: null });
    expect(s.parkCars()).toEqual([]);
  });

  it('rolls the car out when the last part goes in, numbered and made the race car', () => {
    const s = started();
    installBuildPart(s, g1, 'kart', 'wheels', 'wheel');
    installBuildPart(s, g1, 'kart', 'chassis', 'chassis');
    s.sim.hub.add('engine', 1);
    expect(installBuildPart(s, g1, 'kart', 'engine', 'engine').car).toBeNull(); // still two wheels missing
    s.sim.hub.add('wheel', 3);
    const r = installBuildPart(s, g1, 'kart', 'wheels', 'wheel');
    expect(r.n).toBe(2);
    expect(r.car).toMatchObject({ id: 'car-1', blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } });
    expect(r.car!.pose).toEqual(bayPose(g1));
    expect(s.builds).toEqual([]);
    expect(s.selectedCarId).toBe('car-1');
    expect(s.objectives.assembled).toBe(true);
    expect(s.sim.count('wheel')).toBe(1);
  });

  it('gives parts back to the backpack and frees the bay once empty', () => {
    const s = started();
    installBuildPart(s, g1, 'kart', 'wheels', 'wheel');
    installBuildPart(s, g1, 'kart', 'chassis', 'chassis');
    expect(removeBuildPart(s, g1.id, 'wheels')).toEqual({ n: 2, toHub: 0 });
    expect(s.inventory.count('wheel')).toBe(2);
    expect(buildIn(s, g1.id)).not.toBeNull();
    removeBuildPart(s, g1.id, 'chassis');
    expect(buildIn(s, g1.id)).toBeNull();
    expect(s.inventory.count('chassis')).toBe(1);
  });

  it('abandoning gives everything back; nothing is created or lost', () => {
    const s = started();
    s.sim.hub.add('engine', 1);
    const before = total(partStock(s));
    installBuildPart(s, g1, 'kart', 'wheels', 'wheel');
    installBuildPart(s, g1, 'kart', 'engine', 'engine');
    expect(abandonBuild(s, g1.id)!.refund).toEqual({ wheel: 2, engine: 1 });
    expect(total(partStock(s))).toBe(before);
    expect(s.builds).toEqual([]);
    expect(abandonBuild(s, g1.id)).toBeNull();
  });

  it('cannot start in a bay where a car stands, nor install what is not in stock', () => {
    const s = started();
    s.sim.hub.add('chassis', 1);
    s.sim.hub.add('engine', 1);
    s.sim.hub.add('wheel', 2);
    expect(assembleCar(s, 'kart', defaultChoices(BLUEPRINTS.kart), g1)).not.toBeNull();
    s.sim.hub.add('wheel', 4);
    expect(installBuildPart(s, g1, 'kart', 'wheels', 'wheel')).toEqual({ n: 0, car: null });
    const g2 = { ...g1, id: 51, x: 60 };
    expect(installBuildPart(s, g2, 'kart', 'engine', 'engine')).toEqual({ n: 0, car: null });
    expect(s.builds).toEqual([]);
  });

  it('saves and restores builds; a build whose garage is gone gives its parts to the hub', () => {
    const s = started();
    const g = s.sim.place('garage', 40, 40, 0, { free: true, force: true });
    expect(g.ok).toBe(true);
    const spot = { id: g.ok ? g.building.id : 0, x: 40, z: 40, rot: 0 as const };
    installBuildPart(s, spot, 'kart', 'wheels', 'wheel');
    const save = s.serialize();
    const back = GameState.fromSave(JSON.parse(JSON.stringify(save)));
    expect(back.builds).toEqual(s.builds);
    // The same save with the build moved to a garage that does not exist.
    const orphan = JSON.parse(JSON.stringify(save));
    orphan.builds[0].garage = 9999;
    const lost = GameState.fromSave(orphan);
    expect(lost.builds).toEqual([]);
    expect(lost.sim.count('wheel')).toBe(s.sim.count('wheel') + 2);
  });
});
