import { describe, expect, it } from 'vitest';
import { FactorySim } from './FactorySim';
import { DEALER, DRILL, STATS } from '../../data/balance';
import { RECIPES_BY_ID } from '../../data/recipes';
import { perMinLabel, perMinute, rateNumber, recipeRates } from '../../data/rates';
import type { DealerB, DrillB, FactorySave, MachineB } from './types';

/** Iron drill → 3 belts → smelter (ingots) → 3 belts → hub, in a 32×32 test map. */
function chain() {
  const s = new FactorySim({ width: 32, height: 32, storage: { plate: 1000, iron_rod: 1000, bolt: 1000 }, hub: { x: 20, z: 4, rot: 0 }, nodes: [{ resource: 'iron', x: 4, z: 4, w: 2, h: 1 }] });
  const d = s.place('drill', 4, 4, 1, { free: true }); // cells (4, 4..5), out +X → (5, 4)
  for (let x = 5; x < 8; x++) s.place('conveyor', x, 4, 1, { free: true });
  const f = s.place('smelter', 8, 4, 1, { free: true }); // (8, 4..5), out → (9, 4)
  for (let x = 9; x < 20; x++) s.place('conveyor', x, 4, 1, { free: true });
  if (!d.ok || !f.ok) throw new Error('layout');
  s.setRecipe(f.building.id, 'iron_ingot');
  return { s, drill: d.building as DrillB, smelter: f.building as MachineB };
}

describe('rate helpers', () => {
  it('turn recipe times into rates per minute and show them in French', () => {
    expect(perMinute(40)).toBe(30);
    expect(recipeRates(RECIPES_BY_ID.iron_plate!)).toEqual({ inputs: [{ item: 'iron_ingot', perMin: 30 }], outputs: [{ item: 'plate', perMin: 20 }] });
    expect(recipeRates(RECIPES_BY_ID.chassis!).inputs.map((i) => i.perMin)).toEqual([20, 20, 40]);
    expect([rateNumber(7.5), rateNumber(0.44), rateNumber(10), rateNumber(12.6), rateNumber(3)]).toEqual(['7,5', '0,4', '10', '13', '3']);
    expect(perMinLabel(7.5)).toBe('7,5/min');
  });
});

describe('production rates', () => {
  it('a fed chain runs at full speed: 30 ore and 30 ingots a minute', () => {
    const { s, drill, smelter } = chain();
    expect(s.rateOf(drill)).toMatchObject({ perMin: 0, nominal: 30, measuring: true });
    s.run(2 * STATS.WINDOW);
    expect(s.rateOf(drill)).toEqual({ perMin: 30, nominal: 30, measuring: false });
    expect(s.rateOf(smelter)).toEqual({ perMin: 30, nominal: 30, measuring: false });
    // Only the last minute is kept.
    expect(drill.done.length).toBeLessThanOrEqual(30);
    const { produced, consumed } = s.flows();
    expect(produced).toEqual({ iron_ore: 30, iron_ingot: 30 });
    expect(consumed).toEqual({ iron_ore: 30 });
  });

  it('a starved machine shows its real rate; a new recipe starts measuring again', () => {
    const s = new FactorySim({ width: 32, height: 32, storage: { iron_ore: 10 }, hub: null });
    const r = s.place('smelter', 4, 4, 0, { free: true });
    if (!r.ok) throw new Error();
    const m = r.building as MachineB;
    expect(s.rateOf(m)).toBeNull(); // no recipe, nothing to make
    s.setRecipe(m.id, 'iron_ingot');
    s.loadFrom(m.id, s.hub); // 10 ore: 10 crafts of 2 s, then nothing
    s.run(STATS.WINDOW);
    expect(s.rateOf(m)).toMatchObject({ perMin: 10, nominal: 30 });
    s.run(STATS.WINDOW);
    expect(s.rateOf(m)!.perMin).toBe(0);
    s.setRecipe(m.id, null);
    expect(s.rateOf(m)).toBeNull();
    s.setRecipe(m.id, 'iron_ingot');
    expect(s.rateOf(m)).toMatchObject({ perMin: 0, measuring: true });
    expect(m.done).toEqual([]);
  });

  it('a dealer counts its cars, and the parts they took in the factory’s use', () => {
    const s = new FactorySim({ width: 32, height: 32, hub: null });
    const r = s.place('dealer', 4, 4, 0, { free: true });
    if (!r.ok) throw new Error();
    const d = r.building as DealerB;
    d.stock = { chassis: 20, engine: 20, wheel: 80 };
    s.run(STATS.WINDOW + 1);
    expect(s.rateOf(d)).toEqual({ perMin: 6, nominal: perMinute(DEALER.SELL_TICKS), measuring: false });
    expect(s.flows().consumed).toEqual({ chassis: 6, engine: 6, wheel: 24 });
  });

  it('a drill blocked by a full output slows down to nothing', () => {
    const s = new FactorySim({ width: 32, height: 32, hub: null, nodes: [{ resource: 'rubber', x: 4, z: 4, w: 2, h: 1 }] });
    const r = s.place('drill', 4, 4, 0, { free: true });
    if (!r.ok) throw new Error();
    s.run(STATS.WINDOW);
    // Its 5 slots filled in 10 s, then it stopped: 5 in the last minute.
    expect(s.rateOf(r.building)!.perMin).toBe(5);
    expect(s.rateOf(r.building)!.nominal).toBe(perMinute(DRILL.PERIOD));
  });

  it('at full speed a machine reads exactly full speed at every tick, even when its time does not divide a minute', () => {
    const s = new FactorySim({ width: 32, height: 32, hub: null });
    const r = s.place('assembler', 4, 4, 0, { free: true });
    if (!r.ok) throw new Error();
    const m = r.building as MachineB;
    s.setRecipe(m.id, 'engine'); // 160 ticks: 7.5 engines a minute
    const feed = () => {
      m.inBuf = { plate: 6, iron_rod: 4, bolt: 8 };
      m.outBuf = [];
    };
    const first: number[] = [];
    const later = new Set<number>();
    for (let t = 1; t <= 2 * STATS.WINDOW; t++) {
      feed();
      s.tick();
      const rate = s.rateOf(m)!;
      if (rate.measuring) continue;
      if (t <= STATS.WINDOW) first.push(rate.perMin);
      else later.add(Math.round(rate.perMin * 1000) / 1000);
    }
    // No sawtooth: the job in progress counts for its part. In the first minute only the tick the first job waited
    // for (it starts the tick after the recipe) shows, 2 % at most; after a minute, exactly full speed.
    expect(Math.min(...first)).toBeGreaterThan(7.5 * 0.98);
    expect(Math.max(...first)).toBeLessThanOrEqual(7.5);
    expect([...later]).toEqual([7.5]);
    expect(s.flows().produced.engine).toBeCloseTo(7.5, 9);
  });

  it('the balance shows a starved chain: the tire constructor needs 40 latex a minute, one drill gives 30', () => {
    const s = new FactorySim({ width: 32, height: 32, storage: { plate: 1000, iron_rod: 1000, bolt: 1000 }, hub: { x: 20, z: 4, rot: 0 }, nodes: [{ resource: 'rubber', x: 4, z: 4, w: 2, h: 1 }] });
    s.place('drill', 4, 4, 1, { free: true });
    for (let x = 5; x < 8; x++) s.place('conveyor', x, 4, 1, { free: true });
    const p = s.place('press', 8, 4, 1, { free: true });
    for (let x = 9; x < 20; x++) s.place('conveyor', x, 4, 1, { free: true });
    if (!p.ok) throw new Error();
    s.setRecipe(p.building.id, 'tire');
    s.run(3 * STATS.WINDOW);
    expect(s.rateOf(p.building)!.perMin).toBeCloseTo(15, 0); // 15 crafts of 20: 75 %
    const { produced, consumed, demand } = s.flows();
    expect(produced.latex).toBeCloseTo(30, 0);
    expect(consumed.latex).toBeCloseTo(30, 0);
    expect(demand.latex).toBe(40);
    expect((produced.latex ?? 0) - (demand.latex ?? 0)).toBeLessThan(-9);
  });

  it('a machine stopped for over a minute saves and reloads to the same state (old stamps are dropped as they age)', () => {
    const s = new FactorySim({ width: 32, height: 32, storage: { iron_ore: 10 }, hub: null });
    const r = s.place('smelter', 4, 4, 0, { free: true });
    if (!r.ok) throw new Error();
    s.setRecipe(r.building.id, 'iron_ingot');
    s.loadFrom(r.building.id, s.hub);
    s.run(2 * STATS.WINDOW);
    expect((r.building as MachineB).done).toEqual([]);
    const c = FactorySim.fromSave(JSON.parse(JSON.stringify(s.serialize())) as FactorySave, { width: 32, height: 32, nodes: [] });
    expect(c.hash()).toBe(s.hash());
  });

  it('rates are saved: a reload has the same state and the same rates; an old save starts measuring', () => {
    const { s, drill, smelter } = chain();
    s.run(STATS.WINDOW + 333);
    const save = JSON.parse(JSON.stringify(s.serialize())) as FactorySave;
    const c = FactorySim.fromSave(save, { width: 32, height: 32, nodes: [{ resource: 'iron', x: 4, z: 4, w: 2, h: 1 }] });
    expect(c.hash()).toBe(s.hash());
    expect(c.rateOf(c.buildings.get(smelter.id)!)).toEqual(s.rateOf(smelter));
    s.run(500);
    c.run(500);
    expect(c.hash()).toBe(s.hash());
    // Without the fields (a save from before), or with garbage, measuring starts at the load.
    for (const b of save.buildings) {
      if (b.id === drill.id) Object.assign(b, { done: ['x', -5, 1e12, 3.5], since: 'soon' });
      if (b.id === smelter.id) {
        delete (b as Partial<MachineB>).done;
        delete (b as Partial<MachineB>).since;
      }
    }
    const old = FactorySim.fromSave(save, { width: 32, height: 32, nodes: [] });
    const od = old.buildings.get(drill.id) as DrillB;
    expect([od.done, od.since]).toEqual([[], save.tick]);
    expect(old.rateOf(od)).toMatchObject({ measuring: true });
    expect((old.buildings.get(smelter.id) as MachineB).since).toBe(save.tick);
  });
});
