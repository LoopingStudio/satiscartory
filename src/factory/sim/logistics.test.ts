import { describe, expect, it } from 'vitest';
import { FactorySim } from './FactorySim';
import { BELT } from '../../data/balance';
import type { Rot } from './dirs';
import type { ConveyorB, NodeB } from './types';
import { snapConveyorRot, startCell } from './planning';
import type { ItemId } from '../../data/items';

const rich = { plate: 10_000, iron_rod: 10_000, bolt: 10_000 };

function sim() {
  return new FactorySim({ width: 64, height: 64, storage: rich, hub: null });
}

/** A straight run of conveyors from (x, z) toward `rot`; returns them in order. */
function line(s: FactorySim, x: number, z: number, rot: Rot, n: number): ConveyorB[] {
  const dx = [0, 1, 0, -1][rot]!;
  const dz = [1, 0, -1, 0][rot]!;
  return Array.from({ length: n }, (_, i) => {
    const r = s.place('conveyor', x + dx * i, z + dz * i, rot);
    if (!r.ok) throw new Error(`conveyor ${x + dx * i},${z + dz * i}: ${r.check.error}`);
    return r.building as ConveyorB;
  });
}

function node(s: FactorySim, type: 'splitter' | 'merger', x: number, z: number, rot: Rot): NodeB {
  const r = s.place(type, x, z, rot);
  if (!r.ok) throw new Error(`${type}: ${r.check.error}`);
  return r.building as NodeB;
}

/** Fills a belt line with `item`, three per tile (back tiles first in the line's order). */
function fill(belts: ConveyorB[], item: ItemId): number {
  for (const c of belts) {
    for (let k = 0; k < 3; k++) {
      const pos = BELT.SEG - k * BELT.SPACING;
      c.items.push({ item, pos, prev: pos, from: 2 });
    }
  }
  return belts.length * 3;
}

const count = (belts: ConveyorB[]) => belts.reduce((n, c) => n + c.items.length, 0);

describe('splitter', () => {
  it('sends items to its three outputs in turn', () => {
    const s = sim();
    // Input from the west into (20, 20) facing +X: outputs east (front), north (left: -Z… see ports) and south.
    const input = line(s, 0, 20, 1, 20);
    node(s, 'splitter', 20, 20, 1);
    const front = line(s, 21, 20, 1, 30);
    const right = line(s, 20, 19, 2, 19); // a +X splitter's right (local side 1) faces -Z
    const left = line(s, 20, 21, 0, 30); // its left (local side 3) faces +Z
    const total = fill(input, 'plate');
    s.run(2000);
    const got = [count(front), count(left), count(right)];
    expect(got.reduce((a, b) => a + b, 0)).toBe(total);
    expect(Math.max(...got) - Math.min(...got)).toBeLessThanOrEqual(1);
  });

  it('skips outputs with nothing in front, and full ones, without stopping', () => {
    const s = sim();
    const input = line(s, 0, 20, 1, 20);
    const sp = node(s, 'splitter', 20, 20, 1);
    const front = line(s, 21, 20, 1, 30);
    const left = line(s, 20, 21, 0, 1); // one tile onto open ground: fills up after a few items
    const total = fill(input, 'plate');
    // Ports: input, front, left, right; nothing in front of the right one: free (not « unused »).
    expect(s.portsOf(sp.id).map((p) => `${p.dir}:${p.state}`)).toEqual(['in:linked', 'out:linked', 'out:linked', 'out:free']);
    s.run(3000);
    expect(count(left)).toBeGreaterThan(0);
    expect(count(front) + count(left) + s.itemsOn(sp.id) + count(input)).toBe(total);
    expect(count(input)).toBe(0); // the jammed right output never stopped the line
  });

  it('does not slow a full line down (steady state)', () => {
    // Items delivered per tick at the end of a long full line, measured between two ticks.
    const rate = (middle: 'conveyor' | 'splitter' | 'merger') => {
      const s = sim();
      const input = line(s, 0, 10, 1, 40);
      if (middle === 'conveyor') line(s, 40, 10, 1, 1);
      else node(s, middle, 40, 10, 1);
      const out = line(s, 41, 10, 1, 22);
      fill(input, 'bolt');
      s.run(150);
      const a = count(out);
      s.run(200);
      return (count(out) - a) / 200;
    };
    const plain = rate('conveyor');
    expect(plain).toBeGreaterThan(0.13); // ~ one item every 7 ticks
    expect(rate('splitter')).toBeCloseTo(plain, 2);
    expect(rate('merger')).toBeCloseTo(plain, 2);
  });
});

describe('merger', () => {
  it('takes its three inputs in turn', () => {
    const s = sim();
    node(s, 'merger', 20, 20, 1); // output toward +X
    const back = line(s, 0, 20, 1, 20);
    const left = line(s, 20, 0, 0, 20); // from -Z into its side 3 (local left)
    const right = line(s, 20, 40, 2, 20); // from +Z
    const out = line(s, 21, 20, 1, 40);
    fill(back, 'plate');
    fill(left, 'bolt');
    fill(right, 'iron_rod');
    s.run(400);
    // The first items out alternate between the three inputs.
    const order = [...out].reverse().flatMap((c) => c.items.map((i) => i.item));
    const firstNine = order.slice(0, 9);
    for (const item of ['plate', 'bolt', 'iron_rod'] as ItemId[]) expect(firstNine.filter((i) => i === item)).toHaveLength(3);
  });

  it('accepts a machine output directly', () => {
    const s = new FactorySim({ width: 32, height: 32, storage: rich, hub: null, nodes: [{ resource: 'iron', x: 4, z: 4, w: 2, h: 1 }] });
    const d = s.place('drill', 4, 4, 0); // outputs to (4..5, 5)
    const m = node(s, 'merger', 4, 5, 0); // its back takes the drill's output
    const out = line(s, 4, 6, 0, 4);
    expect(d.ok && s.linkOf(d.building.id)?.target).toBe(m.id);
    s.run(400);
    expect(count(out)).toBeGreaterThan(0);
  });
});

describe('splitter against a merge', () => {
  /** A splitter whose front output goes straight into the side of `target`, fed by a full belt of plates; the target's back gets a full belt of bolts. */
  function setup(target: 'conveyor' | 'merger') {
    const s = new FactorySim({ width: 128, height: 128, storage: rich, hub: null });
    const main = line(s, 40, 0, 0, 40); // into (40, 40) from -Z
    if (target === 'conveyor') line(s, 40, 40, 0, 1);
    else node(s, 'merger', 40, 40, 0);
    const out = line(s, 40, 41, 0, 80);
    node(s, 'splitter', 41, 40, 3); // front faces -X: the target's side
    const feed = line(s, 81, 40, 3, 40); // into the splitter from +X
    const others = [line(s, 41, 39, 2, 30), line(s, 41, 41, 0, 30)]; // its other outputs flow freely
    fill(main, 'bolt');
    fill(feed, 'plate');
    s.run(1500);
    const items = out.flatMap((c) => c.items.map((i) => i.item));
    return { plates: items.filter((i) => i === 'plate').length, bolts: items.filter((i) => i === 'bolt').length, others: others.map(count) };
  }

  // The splitter sends a third of its plates each way; the busy merge must not starve its share.
  it('gets its share through a merger', () => {
    const { plates, bolts, others } = setup('merger');
    expect(bolts).toBeGreaterThan(30);
    for (const o of others) expect(Math.abs(plates - o)).toBeLessThanOrEqual(3);
  });

  it('gets its share through the side of a conveyor', () => {
    const { plates, bolts, others } = setup('conveyor');
    expect(bolts).toBeGreaterThan(30);
    for (const o of others) expect(Math.abs(plates - o)).toBeLessThanOrEqual(3);
  });
});

describe('splitters and mergers in the factory', () => {
  it('belong to the belt line picked up by hand, items included', () => {
    const s = sim();
    const a = line(s, 0, 20, 1, 12);
    const sp = node(s, 'splitter', 12, 20, 1);
    const b = line(s, 13, 20, 1, 3);
    const m = node(s, 'merger', 16, 20, 1);
    line(s, 17, 20, 1, 2);
    expect(s.beltLine(a[0]!.id)).toEqual(expect.arrayContaining([sp.id, m.id, b[0]!.id]));
    fill(a, 'plate');
    s.run(3000); // the line ends on open ground: everything jams, the splitter holds items
    const onLine = s.beltLine(a[0]!.id).reduce((n, id) => n + s.itemsOn(id), 0);
    expect(s.itemsOn(sp.id)).toBeGreaterThan(0);
    const taken = s.takeFromBelts(s.beltLine(sp.id), { add: () => 1 });
    expect(taken.plate).toBe(onLine);
    expect(s.itemsOn(sp.id)).toBe(0);
  });

  it('refund their buffered items, save and load with the same future', () => {
    const s = sim();
    const input = line(s, 0, 20, 1, 20);
    const sp = node(s, 'splitter', 20, 20, 1);
    line(s, 21, 20, 1, 3);
    line(s, 20, 21, 0, 2);
    fill(input, 'plate');
    s.run(500);
    const saved = FactorySim.fromSave(JSON.parse(JSON.stringify(s.serialize())), { nodes: [] });
    s.run(300);
    saved.run(300);
    expect(saved.hash()).toBe(s.hash());
    // Dismantling gives its cost and the items it holds back.
    const before = s.count('plate');
    const held = s.itemsOn(sp.id);
    expect(held).toBeGreaterThan(0);
    s.remove(sp.id);
    expect(s.count('plate')).toBe(before + 2 + held);
  });

  it('connect conveyors laid against them', () => {
    const s = sim();
    node(s, 'splitter', 20, 20, 1); // input from x = 19, outputs to x = 21, z = 19, z = 21
    expect(snapConveyorRot(s, 19, 20, 3).rot).toBe(1); // turned into its input
    expect(snapConveyorRot(s, 21, 20, 3).rot).toBe(1); // taking its front output, straight on
    expect(startCell(s, [20, 20])).toMatchObject({ port: 'out' });
  });
});
