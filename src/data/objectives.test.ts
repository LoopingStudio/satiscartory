import { describe, expect, it } from 'vitest';
import { OBJECTIVES, type ObjectiveContext } from './objectives';
import { START_STORAGE } from './balance';
import { BUILDINGS } from './buildings';

const base: ObjectiveContext = { buildings: [{ type: 'hub' }], storage: {}, cars: 0, delivered: {}, blueprints: [], racesWithOwnCar: 0 };
const done = (c: ObjectiveContext) => OBJECTIVES.filter((o) => o.done(c)).map((o) => o.id);

describe('onboarding objectives', () => {
  it('start with nothing done and follow the loop in order', () => {
    expect(done(base)).toEqual([]);
    const loop: ObjectiveContext = {
      buildings: [
        { type: 'drill', resource: 'iron' },
        { type: 'press', recipe: 'plate' },
        { type: 'drill', resource: 'rubber' },
        { type: 'press', recipe: 'tire' },
        { type: 'assembler', recipe: 'wheel' },
      ],
      storage: { wheel: 4, chassis: 1, engine: 1 },
      cars: 0,
      delivered: { plate: 3 },
      blueprints: [],
      racesWithOwnCar: 0,
    };
    expect(done(loop)).toEqual(['iron', 'drill', 'tire', 'assembler', 'parts']);
    expect(done({ ...loop, cars: 1, blueprints: ['kart'], racesWithOwnCar: 1 })).toEqual(['iron', 'drill', 'tire', 'assembler', 'parts', 'assembled', 'race']);
  });

  it('the starting stock pays for both chains, an assembler, belts and the kart parts', () => {
    const c = (t: keyof typeof BUILDINGS) => BUILDINGS[t].cost;
    // The starting nodes are ~17 cells from the hub: ~15 belts per chain, plus links to the assembler.
    const plates = 2 * (c('drill').plate ?? 0) + 2 * (c('press').plate ?? 0) + (c('assembler').plate ?? 0) + 40 * (c('conveyor').plate ?? 0) + 9;
    const bolts = 2 * (c('drill').bolt ?? 0) + 2 * (c('press').bolt ?? 0) + (c('assembler').bolt ?? 0) + 8;
    expect(START_STORAGE.plate).toBeGreaterThanOrEqual(plates);
    expect(START_STORAGE.bolt).toBeGreaterThanOrEqual(bolts);
  });
});
