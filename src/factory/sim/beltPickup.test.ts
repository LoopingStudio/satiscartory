import { describe, expect, it } from 'vitest';
import { FactorySim } from './FactorySim';
import { BELT } from '../../data/balance';
import type { Rot } from './dirs';
import type { ConveyorB } from './types';
import { Inventory } from '../../state/Inventory';
import type { ItemId } from '../../data/items';

const rich = { plate: 10_000, iron_rod: 10_000, bolt: 10_000 };

function sim() {
  return new FactorySim({ width: 32, height: 32, storage: rich, hub: null, nodes: [{ resource: 'iron', x: 0, z: 0, w: 32, h: 32 }] });
}

function belt(s: FactorySim, x: number, z: number, rot: Rot): ConveyorB {
  const r = s.place('conveyor', x, z, rot);
  if (!r.ok) throw new Error(r.check.error);
  return r.building as ConveyorB;
}

/** Puts items on a belt tile, front first, at the usual spacing. */
function load(c: ConveyorB, items: ItemId[]): void {
  items.forEach((item, k) => {
    const pos = BELT.SEG - k * BELT.SPACING;
    c.items.push({ item, pos, prev: pos, from: 2 });
  });
}

function onBelts(s: FactorySim): number {
  let n = 0;
  for (const b of s.buildings.values()) if (b.type === 'conveyor') n += b.items.length;
  return n;
}

describe('takeFromBelts', () => {
  it('moves the items of the given tiles into the sink', () => {
    const s = sim();
    const a = belt(s, 4, 4, 1);
    const b = belt(s, 5, 4, 1);
    load(a, ['iron_ore', 'iron_ore', 'plate']);
    load(b, ['bolt']);
    const bag = new Inventory();
    expect(s.takeFromBelts([a.id], bag)).toEqual({ iron_ore: 2, plate: 1 });
    expect(a.items).toEqual([]);
    expect(b.items).toHaveLength(1);
    expect(bag.count('iron_ore')).toBe(2);
    expect(s.takeFromBelts([a.id], bag)).toEqual({});
  });

  it('leaves on the belt what a full backpack refuses, and keeps the rest of the belt moving', () => {
    const s = sim();
    const c = belt(s, 4, 4, 1);
    belt(s, 5, 4, 1);
    load(c, ['iron_ore', 'bolt', 'iron_ore']);
    // One slot: ore fills it, the bolt does not fit anymore.
    const bag = new Inventory(1);
    bag.add('iron_ore', 98);
    const taken = s.takeFromBelts([c.id], bag);
    expect(taken).toEqual({ iron_ore: 2 });
    expect(c.items.map((i) => i.item)).toEqual(['bolt']);
    const before = onBelts(s);
    s.run(200);
    expect(onBelts(s)).toBe(before); // nothing lost or duplicated afterwards
  });

  it('ignores ids that are not conveyors', () => {
    const s = sim();
    const d = s.place('drill', 10, 10, 0);
    expect(d.ok && s.takeFromBelts([d.building.id, 999], new Inventory())).toEqual({});
  });
});

describe('beltLine', () => {
  it('follows belts both ways through merges and stops at machines', () => {
    const s = sim();
    // Main line (2..6, 4) → smelter at (7, 4..5) facing +X; a branch (4, 1..3) merges into (4, 4).
    const main = [2, 3, 4, 5, 6].map((x) => belt(s, x, 4, 1).id);
    const branch = [1, 2, 3].map((z) => belt(s, 4, z, 0).id);
    s.place('smelter', 7, 4, 1);
    belt(s, 8, 4, 1); // after the smelter: another line
    const lone = belt(s, 20, 20, 0).id;
    const all = [...main, ...branch].sort((a, b) => a - b);
    expect(s.beltLine(main[0]!)).toEqual(all);
    expect(s.beltLine(branch[0]!)).toEqual(all);
    expect(s.beltLine(lone)).toEqual([lone]);
    expect(s.beltLine(s.at(7, 4)!.id)).toEqual([]);
  });

  it('does not join belts that only run side by side or head-on', () => {
    const s = sim();
    const a = belt(s, 4, 4, 1);
    const b = belt(s, 4, 5, 1); // parallel
    const c = belt(s, 5, 4, 3); // head-on with a
    expect(s.beltLine(a.id)).toEqual([a.id]);
    expect(s.beltLine(b.id)).toEqual([b.id]);
    expect(s.beltLine(c.id)).toEqual([c.id]);
  });

  it('picks up a whole jammed line and frees it', () => {
    const s = sim();
    const d = s.place('drill', 4, 4, 0); // outputs to (4..5, 5)
    const line = [5, 6, 7, 8].map((z) => belt(s, 4, z, 0));
    expect(d.ok).toBe(true);
    s.run(2000); // the line ends on open ground: it fills up
    const jammed = onBelts(s);
    expect(jammed).toBeGreaterThan(8);
    const bag = new Inventory();
    const taken = s.takeFromBelts(s.beltLine(line[0]!.id), bag);
    expect(taken.iron_ore).toBe(jammed);
    expect(onBelts(s)).toBe(0);
    s.run(100);
    expect(onBelts(s)).toBeGreaterThan(0); // the drill feeds it again
  });

  it('bumps the topology version when links are rebuilt', () => {
    const s = sim();
    s.syncTopology();
    const v = s.topologyVersion;
    belt(s, 4, 4, 0);
    expect(s.topologyVersion).toBe(v);
    s.syncTopology();
    expect(s.topologyVersion).toBe(v + 1);
  });
});
