import { describe, expect, it } from 'vitest';
import { FactorySim, type TerrainRect } from './FactorySim';
import { Terrain } from './terrain';
import { TERRAIN_RULES as R } from '../../data/factoryTerrain';
import { FACTORY_MAP } from '../../data/factoryMap';
import { mulberry32 } from '../../core/rng';
import type { FactorySave } from './types';
import type { Rot } from './dirs';

const W = 24;
const M = 4;
const N = W + 2 * M + 1;

/** A 24×24 fixture: heights (cm) of corner (gi, gj) from `f`, optional water level. */
function fixture(f: (gi: number, gj: number) => number, water: number | null = null): FactorySim {
  const cm: number[] = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) cm.push(Math.round(f(i - M, j - M)));
  return new FactorySim({ width: W, height: W, terrain: Terrain.fromHeights(W, W, M, cm, water) });
}

const tan = (deg: number) => Math.tan((deg * Math.PI) / 180) * 200;
/** Flat west of x = 8, then rising `deg` degrees along +x. */
const ramp = (deg: number) => fixture((gi) => Math.max(0, gi - 8) * tan(deg));

describe('placement on the relief', () => {
  it('refuses water, then slopes, after bounds and occupancy; force does not bypass the relief', () => {
    const pond = fixture((gi, gj) => (gi >= 2 && gi <= 6 && gj >= 2 && gj <= 6 ? -100 : 0), -40);
    expect(pond.check('conveyor', 3, 3, 0, { free: true }).error).toBe('water');
    expect(pond.check('smelter', 3, 3, 0, { free: true }).error).toBe('water');
    expect(pond.check('smelter', 10, 10, 0, { free: true }).ok).toBe(true);
    expect(pond.place('smelter', 10, 10, 0, { free: true }).ok).toBe(true);
    expect(pond.check('conveyor', 10, 10, 0, { free: true }).error).toBe('occupied');
    expect(pond.check('conveyor', 30, 3, 0, { free: true }).error).toBe('outOfBounds');

    const steep = ramp(30);
    expect(steep.check('smelter', 12, 5, 0, { free: true })).toMatchObject({ ok: false, error: 'steep', detail: 'slope' });
    expect(steep.check('conveyor', 12, 5, 1, { free: true })).toMatchObject({ ok: false, error: 'steep', detail: 'belt' });
    expect(steep.check('hub', 12, 5, 0, { free: true, force: true }).error).toBe('steep');
  });

  it('builds on gentle slopes: a pad at the mean height, reported with its fill', () => {
    const gentle = ramp(10);
    const c = gentle.check('smelter', 12, 5, 0, { free: true });
    expect(c.ok).toBe(true);
    // Corners at x = 12, 13, 14: 4, 5 and 6 rises of 35 cm.
    expect(c.py).toBe(Math.round((5 * tan(10)) / 10) * 10);
    expect(c.grad).toBeLessThanOrEqual(R.PAD_GRAD);
    expect(gentle.check('conveyor', 12, 5, 1, { free: true }).ok).toBe(true);
    const r = gentle.place('smelter', 12, 5, 0, { free: true });
    expect(r.ok && r.building.py).toBe(c.py);
    for (let gi = 12; gi <= 14; gi++) for (let gj = 5; gj <= 6; gj++) expect(gentle.terrain.effAt(gi, gj)).toBe(c.py);
  });

  it('refuses too much relief or digging under a big footprint, and a garage door facing a slope', () => {
    const r13 = ramp(13); // 46 cm per cell: under 14° per cell, but a 3×4 garage spans 1,8 m
    expect(r13.check('garage', 12, 5, 1, { free: true })).toMatchObject({ ok: false, error: 'steep', detail: 'relief' });
    // Flat garage whose door (local +Z) faces a 25° rise starting right in front of it.
    const wall = fixture((_gi, gj) => Math.max(0, gj - 10) * tan(25));
    expect(wall.check('garage', 5, 6, 0, { free: true })).toMatchObject({ ok: false, error: 'steep', detail: 'door' });
    expect(wall.check('garage', 5, 6, 2, { free: true }).ok).toBe(true); // door toward the flat side
  });

  it('levels the shared corners of two pads to the lower one, banks around them, and gives the ground back', () => {
    const sim = ramp(12);
    const events: TerrainRect[] = [];
    sim.events.on('terrain', (r) => events.push(r));
    const a = sim.place('smelter', 10, 5, 0, { free: true });
    const b = sim.place('smelter', 12, 5, 0, { free: true });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ i0: 10 - R.BANK_STEPS, j0: 5 - R.BANK_STEPS, i1: 12 + R.BANK_STEPS, j1: 6 + R.BANK_STEPS });
    const lo = Math.min(a.building.py!, b.building.py!);
    expect(sim.terrain.effAt(12, 5)).toBe(lo);
    // Bank one step outside the pair (west): 75 % of the fill toward the pad.
    const pa = a.building.py!;
    expect(sim.terrain.effAt(9, 5)).toBe(sim.terrain.baseAt(9, 5) + Math.round((pa - sim.terrain.baseAt(10, 5)) * 0.75));
    sim.remove(a.building.id);
    sim.remove(b.building.id);
    expect([...sim.terrain.eff]).toEqual([...sim.terrain.base]);
  });

  it('snaps a row of machines along a slope into terraces', () => {
    const sim = ramp(6); // 21 cm per cell
    const pys: number[] = [];
    for (let x = 9; x <= 17; x += 2) {
      const r = sim.place('smelter', x, 5, 0, { free: true });
      expect(r.ok).toBe(true);
      if (r.ok) pys.push(r.building.py!);
    }
    // Each one within 40 cm of its natural mean takes its neighbor's pad: fewer distinct levels than machines.
    expect(new Set(pys).size).toBeLessThan(pys.length);
  });

  it('incremental re-leveling equals a full recompute after random places and removals', () => {
    const sim = fixture((gi, gj) => 40 * Math.sin(gi * 0.4) + 30 * Math.cos(gj * 0.3) + 8 * gi);
    const rng = mulberry32(17);
    const types = ['smelter', 'press', 'drill', 'conveyor', 'splitter'] as const;
    for (let k = 0; k < 300; k++) {
      const ids = [...sim.buildings.keys()];
      if (ids.length && rng() < 0.35) sim.remove(ids[Math.floor(rng() * ids.length)]!);
      else {
        const type = types[Math.floor(rng() * (types.length - 1))]!;
        if (type === 'drill') continue;
        sim.place(type, Math.floor(rng() * W), Math.floor(rng() * W), Math.floor(rng() * 4) as Rot, { free: true });
      }
    }
    expect(sim.buildings.size).toBeGreaterThan(5);
    const incremental = [...sim.terrain.eff];
    sim.terrain.recomputeAll(sim);
    expect(incremental).toEqual([...sim.terrain.eff]);
  });
});

describe('ports and belts facing the relief', () => {
  it('a port facing ground no belt can stand on is blocked by the terrain; off the map, by the edge', () => {
    // Flat strip z < 10, a 35° rise beyond.
    const sim = fixture((_gi, gj) => Math.max(0, gj - 10) * tan(35));
    const r = sim.place('smelter', 5, 9, 0, { free: true }); // outputs face +Z, onto the rise
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const outs = sim.portsOf(r.building.id).filter((p) => p.dir === 'out');
    expect(outs.every((p) => p.state === 'blocked' && p.blockedBy === 'terrain')).toBe(true);
    const edge = sim.place('smelter', 5, 0, 2, { free: true }); // outputs face -Z, off the map
    expect(edge.ok).toBe(true);
    if (edge.ok) expect(sim.portsOf(edge.building.id).filter((p) => p.dir === 'out').every((p) => p.blockedBy === 'edge')).toBe(true);
    // A belt pointing up the rise is a dead end; one pointing along the flat strip is not.
    const up = sim.place('conveyor', 12, 9, 0, { free: true });
    const along = sim.place('conveyor', 14, 5, 1, { free: true });
    expect(up.ok && sim.isDeadEnd(up.building.id)).toBe(true);
    expect(along.ok && sim.isDeadEnd(along.building.id)).toBe(false);
  });

  it('on ground of 14° or less, the cell in front of every placed machine port takes a belt', () => {
    for (const deg of [8, 14]) {
      for (const rot of [0, 1, 2, 3] as Rot[]) {
        const sim = fixture((gi, gj) => (gi + 0.6 * gj) * tan(deg) * 0.85);
        const r = sim.place('press', 10, 10, rot, { free: true });
        expect(r.ok, `${deg}° rot ${rot}`).toBe(true);
        if (!r.ok) continue;
        for (const p of sim.portsOf(r.building.id)) expect(p.blockedBy, `${deg}° rot ${rot}`).toBeUndefined();
      }
    }
  });
});

describe('saves on the relief', () => {
  it('keeps the pad heights and the relief id; load → save → load is identical', () => {
    const sim = FactorySim.newGame({ terrain: 'vallonne-1' });
    // A smelter off the plateau, on a slope (its pad is not at 0), with a belt after it.
    let spot: [number, number] | null = null;
    for (let x = 90; x < 120 && !spot; x++) {
      for (let z = 20; z < 60 && !spot; z++) {
        const c = sim.check('smelter', x, z, 1, { free: true });
        if (c.ok && c.py && sim.check('conveyor', x + 1, z, 1, { free: true }).ok) spot = [x, z];
      }
    }
    expect(spot).not.toBeNull();
    expect(sim.place('smelter', spot![0], spot![1], 1, { free: true }).ok).toBe(true);
    expect(sim.place('conveyor', spot![0] + 1, spot![1], 1, { free: true }).ok).toBe(true);
    const save = sim.serialize();
    expect(save.version).toBe(4);
    expect(save.terrain).toBe('vallonne-1');
    expect(save.buildings.find((b) => b.type === 'smelter')?.py).toBeTypeOf('number');
    expect(save.buildings.find((b) => b.type === 'conveyor')?.py).toBeUndefined();
    const back = FactorySim.fromSave(save);
    expect(back.terrain.id).toBe('vallonne-1');
    expect(back.hash()).toBe(sim.hash());
    expect([...back.terrain.eff]).toEqual([...sim.terrain.eff]);
    expect(back.migration).toEqual({ padded: 0, inWater: 0 });
  });

  it('a flat save stays flat and writes no pad heights', () => {
    const sim = new FactorySim({ width: 16, height: 16 });
    sim.place('smelter', 4, 4, 0, { free: true });
    const save = sim.serialize();
    expect(save.terrain).toBe('flat');
    expect(save.buildings[0]!.py).toBeUndefined();
    expect(FactorySim.fromSave(save, { width: 16, height: 16 }).terrain.flat).toBe(true);
    // A save that names no relief (made before it) lands on the default map's.
    const old: FactorySave = { ...save };
    delete old.terrain;
    expect(FactorySim.fromSave(old).terrain.id).toBe('vallonne-1');
  });

  it('a save from before the relief keeps every building: pads computed, those in the lake on fill', () => {
    // Built on the flat map, including in what is now the lake and on a crest.
    const flat = FactorySim.newGame({ terrain: 'flat' });
    const lake = Terrain.create('vallonne-1', 128, 128, FACTORY_MAP.nodes);
    let wet: [number, number] | null = null;
    for (let cz = 0; cz < 128 && !wet; cz++) for (let cx = 0; cx < 126 && !wet; cx++) if (lake.isWetCell(cx, cz) && lake.isWetCell(cx + 1, cz)) wet = [cx, cz];
    expect(wet).not.toBeNull();
    expect(flat.place('smelter', wet![0], wet![1], 0, { free: true }).ok).toBe(true);
    expect(flat.place('conveyor', wet![0], wet![1] + 1, 0, { free: true }).ok).toBe(true);
    expect(flat.place('press', 20, 100, 1, { free: true }).ok).toBe(true);
    const v3: FactorySave = { ...flat.serialize(), version: 3 };
    delete v3.terrain;
    const sim = FactorySim.fromSave(v3, { terrain: 'vallonne-1' });
    expect(sim.buildings.size).toBe(flat.buildings.size);
    expect(sim.migration!.padded).toBe(3); // hub, smelter, press
    expect(sim.migration!.inWater).toBe(1);
    const smelter = [...sim.buildings.values()].find((b) => b.type === 'smelter')!;
    expect(smelter.py).toBeGreaterThanOrEqual(lake.lake!.level + 2 * R.WATER_FILL);
    // Idempotent: saving and loading again changes nothing.
    const again = FactorySim.fromSave(sim.serialize());
    expect(again.hash()).toBe(sim.hash());
    expect(again.migration!.padded).toBe(0);
  });
});
