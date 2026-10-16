import { describe, expect, it } from 'vitest';
import { FactorySim } from '../factory/sim/FactorySim';
import type { GarageB } from '../factory/sim/types';
import type { Rot } from '../factory/sim/dirs';
import { garageGroup, openSides, sideAnchor } from './groups';
import { BUILDINGS } from '../data/buildings';
import { DEFAULT_SIGN, cleanSign, sanitizeGarageLook } from '../data/garageStyle';
import { parkUnplaced } from './parking';
import type { CarInstance } from './assembly';

const rich = { plate: 10_000, iron_rod: 10_000, bolt: 10_000 };
const sim = () => new FactorySim({ width: 40, height: 40, storage: rich, hub: null, terrain: 'flat' });
const place = (s: FactorySim, x: number, z: number, rot: Rot = 0) => {
  const r = s.place('garage', x, z, rot);
  if (!r.ok) throw new Error(r.check.error);
  return r.building as GarageB;
};

describe('garages of several places', () => {
  it('modules side by side along their width form one garage, in every rotation', () => {
    for (const rot of [0, 1, 2, 3] as Rot[]) {
      const s = sim();
      const a = place(s, 10, 10, rot);
      const [x, z] = sideAnchor(a, 1);
      const b = place(s, x, z, rot);
      expect(garageGroup(s, a).map((g) => g.id)).toEqual([a.id, b.id]);
      expect(garageGroup(s, b).map((g) => g.id)).toEqual([a.id, b.id]);
      expect(openSides(s, a)).toEqual({ minus: false, plus: true });
      expect(openSides(s, b)).toEqual({ minus: true, plus: false });
    }
  });

  it('a garage turned differently, or behind it, is not part of it', () => {
    const s = sim();
    const a = place(s, 10, 10, 0);
    const [x, z] = sideAnchor(a, 1);
    place(s, x, z, 2); // same cells, door the other way
    expect(garageGroup(s, a)).toHaveLength(1);
    place(s, 10, 10 + BUILDINGS.garage.footprint[1], 0); // behind: not along the width
    expect(openSides(s, a)).toEqual({ minus: false, plus: false });
  });

  it('« Agrandir » adds a module on either side, paid like a garage, with the garage’s look', () => {
    const s = sim();
    const a = place(s, 10, 10);
    s.styleGarage(a.id, { paint: 'red', sign: 'Chez Max' });
    const plates = s.count('plate');
    const r = s.extendGarage(a.id, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(s.count('plate')).toBe(plates - (BUILDINGS.garage.cost.plate ?? 0));
    expect(r.building.paint).toBe('red');
    expect(r.building.sign).toBe('CHEZ MAX');
    expect(s.extendGarage(a.id, -1).ok).toBe(true);
    expect(garageGroup(s, a)).toHaveLength(3);
    // Blocked cells: refused, nothing paid.
    s.place('conveyor', ...sideAnchor(garageGroup(s, a)[2]!, 1), 0);
    const before = s.count('plate');
    const no = s.extendGarage(garageGroup(s, a)[2]!.id, 1);
    expect(no.ok).toBe(false);
    expect(s.count('plate')).toBe(before);
  });

  it('the look is the whole garage’s; defaults clear their keys; saves keep it, sanitized', () => {
    const s = sim();
    const a = place(s, 10, 10);
    const b = s.extendGarage(a.id, 1);
    if (!b.ok) throw new Error();
    s.styleGarage(b.building.id, { paint: 'blue', sign: '  le   garage  du coin  ' });
    expect(a.paint).toBe('blue');
    expect(a.sign).toBe('LE GARAGE DU C'); // SIGN_MAX = 14
    const back = FactorySim.fromSave(JSON.parse(JSON.stringify(s.serialize())), { width: 40, height: 40, terrain: 'flat' });
    expect((back.buildings.get(a.id) as GarageB).paint).toBe('blue');
    s.styleGarage(a.id, { paint: 'lavender', sign: '' });
    expect('paint' in a).toBe(false);
    expect('sign' in b.building).toBe(false);
    expect(sanitizeGarageLook({ paint: 'nope', sign: 3 })).toEqual({});
    expect(cleanSign('')).toBe(DEFAULT_SIGN);
  });

  it('every place of a bigger garage takes a car', () => {
    const s = sim();
    const a = place(s, 10, 10);
    s.extendGarage(a.id, 1);
    s.extendGarage(a.id, -1);
    const garages = garageGroup(s, a);
    const cars: CarInstance[] = [1, 2, 3, 4].map((i) => ({ id: `c${i}`, name: `Kart ${i}`, blueprint: 'kart', parts: {}, pose: null }));
    const parked = parkUnplaced(cars, garages);
    expect(parked).toHaveLength(3);
    expect(new Set(parked.map((c) => `${c.pose!.x},${c.pose!.z}`)).size).toBe(3);
    expect(cars[3]!.pose).toBeNull();
  });
});
