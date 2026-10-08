import { describe, expect, it } from 'vitest';
import { FactorySim } from './FactorySim';
import { DX, DZ, type Rot } from './dirs';
import { dirTo, endCell, planConveyorPath, planDrag, snapConveyorRot, snapToPort, startCell, type DragEnd } from './planning';
import { BUILDINGS, type BuildingType } from '../../data/buildings';
import { mulberry32 } from '../../core/rng';
import type { Placement } from './types';
import { Terrain } from './terrain';

const rich = { plate: 10_000, iron_rod: 10_000, bolt: 10_000 };

function sim(opts: ConstructorParameters<typeof FactorySim>[0] = {}) {
  return new FactorySim({ width: 32, height: 32, storage: rich, hub: null, nodes: [{ resource: 'iron', x: 0, z: 0, w: 32, h: 32 }], ...opts });
}

function place(s: FactorySim, type: BuildingType, x: number, z: number, rot: Rot) {
  const r = s.place(type, x, z, rot);
  if (!r.ok) throw new Error(`cannot place ${type} at ${x},${z}: ${r.check.error}`);
  return r.building;
}

describe('ports', () => {
  it('lists a drill’s outputs as free, then linked once a belt takes them', () => {
    const s = sim();
    const d = place(s, 'drill', 4, 4, 0); // cells (4..5, 4), outputs toward +Z
    expect(s.portsOf(d.id).map((p) => [p.cx, p.cz, p.side, p.dir, p.state])).toEqual([
      [4, 4, 0, 'out', 'free'],
      [5, 4, 0, 'out', 'free'],
    ]);
    const c = place(s, 'conveyor', 5, 5, 1); // in front of the second port, takes it from its right side
    const ports = s.portsOf(d.id);
    // A building outputs through one port only: the other one is unused, not free.
    expect(ports.map((p) => p.state)).toEqual(['unused', 'linked']);
    expect(ports[1]!.neighbor).toBe(c.id);
    expect(s.inboundOf(c.id).map((f) => f.id)).toEqual([d.id]);
  });

  it('never offers the unused output of a linked drill (a belt there gets nothing or steals the output)', () => {
    for (const taken of [4, 5]) {
      const s = sim();
      const d = place(s, 'drill', 4, 4, 0);
      const c = place(s, 'conveyor', taken, 5, 0);
      const other = taken === 4 ? 5 : 4;
      expect(s.portsOf(d.id).find((p) => p.cx === other)!.state).toBe('unused');
      // Aimed at the drill, the conveyor goes nowhere near the unused port.
      expect(snapToPort(s, [other, 4])).toBeNull();
      expect(startCell(s, [other, 4]).cell).toEqual([other, 4]);
      expect(s.linkOf(d.id)!.target).toBe(c.id);
    }
  });

  it('marks a port blocked (and the belt a dead end) when a belt points into it', () => {
    const s = sim();
    const d = place(s, 'drill', 4, 4, 0);
    const c = place(s, 'conveyor', 4, 5, 2); // faces the drill: refuses the output and runs into it
    const ports = s.portsOf(d.id);
    expect(ports[0]!.state).toBe('blocked');
    expect(ports[0]!.neighbor).toBe(c.id);
    expect(s.isDeadEnd(c.id)).toBe(true);
    // Turned the other way, it takes the output and leads onto empty ground: not a dead end.
    s.remove(c.id);
    const ok = place(s, 'conveyor', 4, 5, 0);
    expect(s.portsOf(d.id)[0]!.state).toBe('linked');
    expect(s.isDeadEnd(ok.id)).toBe(false);
  });

  it('sees a machine input fed by a belt, and ports facing off the map as blocked', () => {
    const s = sim();
    const m = place(s, 'smelter', 4, 4, 0); // inputs on the -Z side (z = 3), outputs on +Z
    place(s, 'conveyor', 5, 3, 0); // points into the second input
    const ports = s.portsOf(m.id);
    expect(ports.filter((p) => p.dir === 'in').map((p) => p.state)).toEqual(['free', 'linked']);
    expect(ports.filter((p) => p.dir === 'out').map((p) => p.state)).toEqual(['free', 'free']);
    const edge = place(s, 'smelter', 10, 0, 0); // inputs face z = -1: off the map
    expect(s.portsOf(edge.id).filter((p) => p.dir === 'in').every((p) => p.state === 'blocked')).toBe(true);
  });

  it('flags belts running into a machine wall or head-on into another belt', () => {
    const s = sim();
    place(s, 'smelter', 4, 4, 0); // short sides at x = 3 and x = 6 are walls
    const wall = place(s, 'conveyor', 3, 4, 1);
    const a = place(s, 'conveyor', 10, 10, 1);
    const b = place(s, 'conveyor', 11, 10, 3);
    const open = place(s, 'conveyor', 20, 20, 0);
    expect(s.isDeadEnd(wall.id)).toBe(true);
    expect(s.isDeadEnd(a.id)).toBe(true);
    expect(s.isDeadEnd(b.id)).toBe(true);
    expect(s.isDeadEnd(open.id)).toBe(false);
  });

  it('lists the dealer’s three inputs on its back side, and a belt behind it turns to feed it', () => {
    const s = sim();
    const d = place(s, 'dealer', 10, 10, 0); // cells (10..12, 10..11), back side -Z
    expect(s.portsOf(d.id).map((p) => [p.cx, p.cz, p.side, p.dir, p.state])).toEqual([
      [10, 10, 2, 'in', 'free'],
      [11, 10, 2, 'in', 'free'],
      [12, 10, 2, 'in', 'free'],
    ]);
    expect(snapConveyorRot(s, 11, 9, 1)).toEqual({ rot: 0, linked: true });
    // Turned a half turn, its inputs face +Z.
    const t = place(s, 'dealer', 20, 20, 2);
    expect(s.portsOf(t.id).map((p) => [p.cz, p.side])).toEqual([[21, 0], [21, 0], [21, 0]]);
  });

  it('lists no ports for the hub and the garage', () => {
    const s = sim({ hub: { x: 10, z: 10, rot: 0 } });
    const hub = [...s.buildings.values()].find((b) => b.type === 'hub')!;
    const g = place(s, 'garage', 20, 20, 0);
    expect(s.portsOf(hub.id)).toEqual([]);
    expect(s.portsOf(g.id)).toEqual([]);
  });
});

describe('planLinks', () => {
  it('predicts exactly the links that placing the plan makes (random layouts)', () => {
    const types: BuildingType[] = ['conveyor', 'conveyor', 'conveyor', 'splitter', 'merger', 'drill', 'smelter', 'press', 'assembler', 'dealer'];
    const rnd = mulberry32(7);
    const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
    let checked = 0;
    for (let round = 0; round < 60; round++) {
      const s = sim({ width: 12, height: 12, hub: rnd() < 0.5 ? { x: 4, z: 4, rot: 0 } : null });
      for (let i = 0; i < 40; i++) s.place(pick(types), Math.floor(rnd() * 12), Math.floor(rnd() * 12), pick([0, 1, 2, 3] as Rot[]));
      // A plan of 1 to 3 buildings on free cells, possibly next to each other.
      const plan: Placement[] = [];
      const taken = new Set<string>();
      for (let k = 0, n = 1 + Math.floor(rnd() * 3); k < 40 && plan.length < n; k++) {
        const p: Placement = { type: pick(types), x: Math.floor(rnd() * 12), z: Math.floor(rnd() * 12), rot: pick([0, 1, 2, 3] as Rot[]) };
        const cells = s.cellsFor(p.type, p.x, p.z, p.rot);
        if (!s.check(p.type, p.x, p.z, p.rot).ok || cells.some(([x, z]) => taken.has(`${x},${z}`))) continue;
        cells.forEach(([x, z]) => taken.add(`${x},${z}`));
        plan.push(p);
      }
      if (!plan.length) continue;
      const predicted = s.planLinks(plan);
      const ids = plan.map((p) => place(s, p.type, p.x, p.z, p.rot).id);
      const real = (id: number) => (id < 0 ? ids[-1 - id]! : id);
      plan.forEach((_, i) => {
        const want = s.linkOf(ids[i]!);
        const got = predicted[i]!.out;
        expect(got ? { ...got, target: real(got.target) } : null).toEqual(want);
        const inWant = s.inboundOf(ids[i]!).map((f) => [f.id, f.link.cx, f.link.cz, f.link.entry]).sort();
        const inGot = predicted[i]!.in.map((f) => [real(f.id), f.link.cx, f.link.cz, f.link.entry]).sort();
        expect(inGot).toEqual(inWant);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(60);
  });
});

describe('snapConveyorRot', () => {
  it('turns a belt in front of a drill so that it takes the output', () => {
    const s = sim();
    place(s, 'drill', 4, 4, 0);
    // Facing the drill (the trap): snapped away from it, straight.
    expect(snapConveyorRot(s, 4, 5, 2)).toEqual({ rot: 0, linked: true });
    // Sideways would take it too, but in line with the output wins (R on the cell turns it by hand).
    expect(snapConveyorRot(s, 4, 5, 1)).toEqual({ rot: 0, linked: true });
    expect(snapConveyorRot(s, 4, 5, 3)).toEqual({ rot: 0, linked: true });
  });

  it('points a belt into a machine input, even between an output and an input', () => {
    const s = sim();
    place(s, 'smelter', 4, 4, 1); // cells (4, 4..5); inputs from x = 3, outputs to x = 5
    for (const r of [0, 1, 2, 3] as Rot[]) expect(snapConveyorRot(s, 3, 4, r).rot).toBe(1);
    place(s, 'drill', 1, 4, 1); // cells (1, 4..5); outputs to x = 2
    // (2, 4): drill output behind, smelter input one cell ahead is not adjacent: just take the output.
    expect(snapConveyorRot(s, 2, 4, 3)).toEqual({ rot: 1, linked: true });
    s.remove(s.at(1, 4)!.id);
    place(s, 'drill', 2, 4, 1); // outputs straight into (3, 4..5)
    expect(snapConveyorRot(s, 3, 5, 3)).toEqual({ rot: 1, linked: true });
  });

  it('continues a belt line, and leaves a lone belt or a parallel line alone', () => {
    const s = sim();
    place(s, 'conveyor', 4, 4, 1); // ends toward (5, 4)
    expect(snapConveyorRot(s, 5, 4, 3)).toEqual({ rot: 1, linked: true }); // pointing back: continued instead
    expect(snapConveyorRot(s, 5, 4, 0)).toEqual({ rot: 1, linked: true }); // in line first, a turn is for R
    expect(snapConveyorRot(s, 20, 20, 2)).toEqual({ rot: 2, linked: false });
    // Next to a belt running alongside: no merge forced on it.
    expect(snapConveyorRot(s, 4, 5, 1)).toEqual({ rot: 1, linked: false });
  });

  it('does not take a machine’s output away from the line it feeds', () => {
    const s = sim();
    const d = place(s, 'drill', 4, 4, 0); // ports (4,4) and (5,4) facing +Z
    const line = place(s, 'conveyor', 5, 5, 0); // takes the second port
    place(s, 'conveyor', 5, 6, 0);
    expect(s.portsOf(d.id).map((p) => p.state)).toEqual(['unused', 'linked']);
    // On the unused port's cell every orientation either takes the drill's output (counted against) or
    // faces the drill (a dead end): no connection is offered, R decides.
    expect(snapConveyorRot(s, 4, 5, 2).linked).toBe(false);
    expect(snapConveyorRot(s, 4, 5, 1)).toEqual({ rot: 1, linked: false });
    expect(s.linkOf(d.id)!.target).toBe(line.id);
  });

  it('feeds the hub from any edge', () => {
    const s = sim({ hub: { x: 10, z: 10, rot: 0 } });
    expect(snapConveyorRot(s, 9, 11, 3).rot).toBe(1);
    expect(snapConveyorRot(s, 11, 13, 0).rot).toBe(2);
  });
});

describe('snapToPort', () => {
  it('moves an aim on a building to the front of its nearest free port', () => {
    const s = sim();
    place(s, 'drill', 4, 4, 0);
    expect(snapToPort(s, [4, 4])).toMatchObject({ cell: [4, 5], port: 'out' });
    expect(snapToPort(s, [5, 4])).toMatchObject({ cell: [5, 5], port: 'out' });
    // The aimed point decides between the ports.
    expect(snapToPort(s, [4, 4], [5.9, 4.5])!.cell).toEqual([5, 5]);
    place(s, 'conveyor', 5, 5, 2); // faces the drill: blocks that port
    expect(snapToPort(s, [5, 4])!.cell).toEqual([4, 5]);
    place(s, 'conveyor', 4, 5, 2);
    expect(snapToPort(s, [5, 4])).toBeNull();
  });

  it('keeps free cells and belts, and snaps to the nearest free edge cell of the hub', () => {
    const s = sim({ hub: { x: 10, z: 10, rot: 0 } });
    expect(snapToPort(s, [3, 3])).toBeNull();
    place(s, 'conveyor', 3, 3, 0);
    expect(snapToPort(s, [3, 3])).toBeNull();
    expect(snapToPort(s, [10, 11], [10.1, 11.5])).toMatchObject({ cell: [9, 11], port: 'in' });
    expect(snapToPort(s, [11, 12], [11.5, 12.9])).toMatchObject({ cell: [11, 13], port: 'in' });
    expect(snapToPort(s, [11, 12], undefined, ['out'])).toBeNull();
  });

  it('tries the kinds of port in order', () => {
    const s = sim();
    place(s, 'press', 4, 4, 0); // inputs at z = 3, outputs at z = 5
    expect(snapToPort(s, [4, 4], [4.5, 4.1], ['in'])).toMatchObject({ cell: [4, 3], port: 'in' });
    expect(snapToPort(s, [4, 4], [4.5, 4.1], ['out', 'in'])).toMatchObject({ cell: [4, 5], port: 'out' });
  });
});

describe('drag ends', () => {
  const plain = (x: number, z: number): DragEnd => ({ cell: [x, z], port: null });

  it('starts at a machine output, else at an input; continues a belt from its end', () => {
    const s = sim();
    place(s, 'press', 4, 4, 0); // inputs at z = 3, outputs at z = 5
    // Aimed on the input side half, a start still goes to an output.
    expect(startCell(s, [4, 4], [4.5, 4.1])).toMatchObject({ cell: [4, 5], port: 'out' });
    place(s, 'conveyor', 4, 5, 0); // takes the output: the other one is unused
    expect(startCell(s, [4, 4], [4.5, 4.1])).toMatchObject({ cell: [4, 3], port: 'in' });
    place(s, 'conveyor', 10, 10, 1);
    place(s, 'conveyor', 11, 10, 1);
    expect(startCell(s, [11, 10])).toMatchObject({ cell: [12, 10], port: 'out' }); // its end
    expect(startCell(s, [10, 10])).toEqual(plain(10, 10)); // in the middle of the line: nothing to continue
    expect(startCell(s, [20, 20])).toEqual(plain(20, 20));
  });

  it('ends at the input that completes the belt, nearest the start', () => {
    const s = sim();
    const m = place(s, 'press', 10, 10, 0); // cells (10..11, 10): inputs at z = 9, outputs at z = 11
    // From an output (or a plain cell): an input, the one nearest the start whatever the aimed point.
    expect(endCell(s, [10, 10], { cell: [14, 6], port: 'out' }, [10.2, 10.9])).toMatchObject({ cell: [11, 9], port: 'in' });
    expect(endCell(s, [11, 10], plain(6, 6), [11.8, 10.5])).toMatchObject({ cell: [10, 9], port: 'in' });
    // From an input: an output (the belt will run from it).
    expect(endCell(s, [10, 10], { cell: [3, 3], port: 'in' })).toMatchObject({ cell: [10, 11], port: 'out' });
    // No input left: stays on the machine (no snapping onto its output face).
    place(s, 'conveyor', 10, 9, 1);
    place(s, 'conveyor', 11, 9, 3);
    expect(s.portsOf(m.id).filter((p) => p.dir === 'in').every((p) => p.state === 'blocked')).toBe(true);
    expect(endCell(s, [10, 10], { cell: [14, 6], port: 'out' })).toEqual(plain(10, 10));
  });

  it('keeps a belt aimed at as the end (merge), or continues it toward a start at an input', () => {
    const s = sim();
    place(s, 'conveyor', 5, 4, 1);
    expect(endCell(s, [5, 4], plain(5, 8))).toEqual(plain(5, 4));
    expect(endCell(s, [5, 4], { cell: [9, 9], port: 'in' })).toMatchObject({ cell: [6, 4], port: 'out' });
  });

  it('reads the cell in front of a port as that port (where its marker is)', () => {
    const s = sim();
    const m = place(s, 'smelter', 10, 10, 0); // inputs in front at z = 9, outputs at z = 11
    expect(startCell(s, [10, 9])).toEqual({ cell: [10, 9], port: 'in', target: m.id });
    expect(startCell(s, [11, 11])).toEqual({ cell: [11, 11], port: 'out', target: m.id });
    // Pressed on the blue marker, dragged away: the belt flows into the smelter.
    const fromIn = planDrag(s, startCell(s, [10, 9]), endCell(s, [10, 4], startCell(s, [10, 9])), 2);
    expect(fromIn.map((t) => [t.x, t.z, t.rot])).toEqual([[10, 4, 0], [10, 5, 0], [10, 6, 0], [10, 7, 0], [10, 8, 0], [10, 9, 0]]);
    // From a plain cell, released on the orange marker: the belt flows from the smelter.
    const plainStart = startCell(s, [10, 16]);
    const end = endCell(s, [10, 11], plainStart);
    expect(end).toEqual({ cell: [10, 11], port: 'out', target: m.id });
    const fromOut = planDrag(s, plainStart, end, 0);
    expect(fromOut[0]).toMatchObject({ x: 10, z: 11, rot: 0 });
    for (const t of fromOut) place(s, 'conveyor', t.x, t.z, t.rot);
    expect(s.linkOf(m.id)).not.toBeNull();
    // The cell past a belt end is that belt's output.
    expect(startCell(s, [10, 17])).toMatchObject({ port: 'out' });
  });

  it('continues a belt when the drag comes from ahead of its end, merges from beside or behind', () => {
    const s = sim();
    place(s, 'conveyor', 4, 4, 1);
    const end = place(s, 'conveyor', 5, 4, 1); // free end at (6, 4)
    const ahead = endCell(s, [5, 4], startCell(s, [9, 4]));
    expect(ahead).toMatchObject({ cell: [6, 4], port: 'out' });
    const path = planDrag(s, startCell(s, [9, 4]), ahead, 0);
    for (const t of path) place(s, 'conveyor', t.x, t.z, t.rot);
    expect(s.linkOf(end.id)).not.toBeNull();
    for (const b of s.buildings.values()) expect(s.isDeadEnd(b.id)).toBe(false);
    // From beside: stays the end, merged into.
    const s2 = sim();
    place(s2, 'conveyor', 5, 4, 1);
    expect(endCell(s2, [5, 4], startCell(s2, [5, 8]))).toEqual({ cell: [5, 4], port: null });
  });

  it('turns the last tile into the input aimed at, not another machine beside the same cell', () => {
    const s = sim();
    const a = place(s, 'smelter', 5, 11, 3);
    const b = place(s, 'smelter', 6, 22, 0);
    place(s, 'press', 7, 20, 1);
    const start = startCell(s, [5, 11]);
    expect(start).toMatchObject({ port: 'out', target: a.id });
    const end = endCell(s, [6, 22], start);
    expect(end).toMatchObject({ port: 'in', target: b.id });
    const path = planDrag(s, start, end, 0);
    const last = path[path.length - 1]!;
    expect(s.planLinks([last])[0]!.out!.target).toBe(b.id);
  });

  it('keeps the pressed end of a drag longer than the cap, both ways', () => {
    const s = sim({ width: 128, height: 128 });
    const m = place(s, 'smelter', 10, 100, 0); // inputs at z = 99
    place(s, 'conveyor', 10, 101, 0);
    const fromIn = startCell(s, [10, 100]);
    expect(fromIn).toMatchObject({ cell: [10, 99], port: 'in' });
    const path = planDrag(s, fromIn, { cell: [10, 10], port: null }, 0);
    expect(path).toHaveLength(64);
    expect(path.at(-1)).toMatchObject({ x: 10, z: 99, rot: 0 });
    expect(s.planLinks([path.at(-1)!])[0]!.out!.target).toBe(m.id);
    const forward = planDrag(s, { cell: [20, 0], port: null }, { cell: [20, 120], port: null }, 0);
    expect(forward[0]).toMatchObject({ x: 20, z: 0 });
  });

  it('runs a belt toward the start when it starts at an input or ends at an output', () => {
    const s = sim();
    place(s, 'smelter', 10, 10, 0); // inputs at z = 9
    const start = startCell(s, [10, 10], [10.5, 10.1]);
    expect(start.port).toBe('out'); // outputs are free: still an output first
    // Pressed in front of an input (outputs taken), dragged away: the belt flows into the machine.
    place(s, 'conveyor', 10, 11, 0);
    const fromIn = startCell(s, [10, 10], [10.5, 10.1]);
    expect(fromIn).toMatchObject({ cell: [10, 9], port: 'in' });
    const path = planDrag(s, fromIn, plain(10, 5), 0);
    expect(path.map((t) => [t.x, t.z, t.rot])).toEqual([[10, 5, 0], [10, 6, 0], [10, 7, 0], [10, 8, 0], [10, 9, 0]]);
    // Pressed on a plain cell, released on a drill: the belt runs from the drill's output.
    place(s, 'drill', 20, 20, 2); // outputs at z = 19
    const end = endCell(s, [20, 20], plain(20, 14));
    expect(end).toMatchObject({ cell: [20, 19], port: 'out' });
    const fromDrill = planDrag(s, plain(20, 14), end, 0);
    expect(fromDrill[0]).toMatchObject({ x: 20, z: 19, rot: 2 });
    expect(fromDrill.at(-1)).toMatchObject({ x: 20, z: 14 });
  });
});

describe('planConveyorPath', () => {
  const rots = (p: Placement[]) => p.map((t) => t.rot);
  const cells = (p: Placement[]) => p.map((t) => [t.x, t.z]);

  it('runs from a drill output to a machine input and turns into it', () => {
    const s = sim();
    place(s, 'drill', 4, 4, 0); // outputs to (4..5, 5)
    place(s, 'smelter', 8, 8, 3); // cells (8, 8..9) facing -X: inputs from x = 9
    const path = planConveyorPath(s, [5, 5], [9, 9], 0);
    expect(cells(path)[0]).toEqual([5, 5]);
    expect(cells(path).at(-1)).toEqual([9, 9]);
    expect(path.at(-1)!.rot).toBe(3); // turned into the smelter
    // Placing it carries ore from the drill into the smelter.
    for (const t of path) place(s, 'conveyor', t.x, t.z, t.rot);
    const smelter = s.at(8, 8)!;
    s.setRecipe(smelter.id, 'iron_ingot');
    s.run(400);
    expect(s.crafted.iron_ingot ?? 0).toBeGreaterThan(0);
  });

  it('goes straight on when the end does not touch an input', () => {
    const s = sim();
    const path = planConveyorPath(s, [2, 2], [6, 2], 0);
    expect(rots(path)).toEqual([1, 1, 1, 1, 1]);
    const back = planConveyorPath(s, [6, 2], [2, 2], 0);
    expect(rots(back)).toEqual([3, 3, 3, 3, 3]);
  });

  it('takes the L order that goes around buildings', () => {
    const s = sim();
    place(s, 'smelter', 5, 2, 0); // (5..6, 2): in the way of an X-first L from (2, 2) to (8, 5)
    const path = planConveyorPath(s, [2, 2], [8, 5], 0);
    expect(path.every((t) => !s.at(t.x, t.z))).toBe(true);
    expect(cells(path).slice(0, 4)).toEqual([[2, 2], [2, 3], [2, 4], [2, 5]]);
    // Nothing in the way: the longer leg first, as before.
    const free = planConveyorPath(sim(), [2, 2], [8, 5], 0);
    expect(cells(free).slice(0, 3)).toEqual([[2, 2], [3, 2], [4, 2]]);
  });

  it('merges into a belt aimed at from the side rather than head-on', () => {
    const s = sim();
    const belt = place(s, 'conveyor', 8, 5, 3); // flows toward (7, 5)
    const path = planConveyorPath(s, [6, 0], [8, 5], 0);
    for (const t of path) if (!s.at(t.x, t.z)) place(s, 'conveyor', t.x, t.z, t.rot);
    expect(s.inboundOf(belt.id)).toHaveLength(1);
    for (const b of s.buildings.values()) expect(s.isDeadEnd(b.id)).toBe(false);
  });

  it('snaps a single tile and caps the length', () => {
    const s = sim();
    place(s, 'drill', 4, 4, 0);
    expect(rots(planConveyorPath(s, [4, 5], [4, 5], 2))).toEqual([0]);
    expect(planConveyorPath(s, [0, 20], [31, 20], 0, 10)).toHaveLength(10);
  });

  it('keeps every tile flowing into the next one', () => {
    const s = sim();
    const rnd = mulberry32(3);
    for (let k = 0; k < 50; k++) {
      const a: [number, number] = [Math.floor(rnd() * 32), Math.floor(rnd() * 32)];
      const b: [number, number] = [Math.floor(rnd() * 32), Math.floor(rnd() * 32)];
      const path = planConveyorPath(s, a, b, 0);
      for (let i = 0; i + 1 < path.length; i++) {
        const t = path[i]!;
        const n = path[i + 1]!;
        expect([t.x + DX[t.rot], t.z + DZ[t.rot]]).toEqual([n.x, n.z]);
        expect(dirTo([t.x, t.z], [n.x, n.z])).toBe(t.rot);
      }
    }
  });
});

describe('port definitions', () => {
  it('give every non-hollow building but the hub at least one port', () => {
    for (const def of Object.values(BUILDINGS)) {
      if (def.hollow || def.acceptsAllEdges) continue;
      expect(def.ports.length).toBeGreaterThan(0);
    }
  });
});

describe('planning on the relief', () => {
  /** 32×32 with margin 2: a steep 3×3 knoll (corners 6..9) and a pond (corners 20..24), flat elsewhere. */
  function hilly(): FactorySim {
    const M = 2;
    const n = 32 + 2 * M + 1;
    const cm: number[] = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const gi = i - M;
        const gj = j - M;
        cm.push(gi >= 6 && gi <= 9 && gj >= 6 && gj <= 9 ? 300 : gi >= 20 && gi <= 24 && gj >= 20 && gj <= 24 ? -150 : 0);
      }
    }
    return sim({ terrain: Terrain.fromHeights(32, 32, M, cm, -50) });
  }

  it('the L-shaped drag goes around a steep knoll instead of over it', () => {
    const s = hilly();
    // From (2, 7) to (14, 3): x first crosses the knoll's flanks at z = 7, z first stays clear.
    const path = planConveyorPath(s, [2, 7], [14, 3], 0);
    expect(path.every((t) => s.check('conveyor', t.x, t.z, t.rot).ok)).toBe(true);
    expect(path.some((t) => t.x >= 5 && t.x <= 9 && t.z >= 5 && t.z <= 9)).toBe(false);
  });

  it('never starts or ends a belt in the water, and ports facing it are blocked', () => {
    const s = hilly();
    const d = place(s, 'press', 18, 22, 1); // a 1×2 press beside the pond, outputs toward +X (into it)
    const outs = s.portsOf(d.id).filter((p) => p.dir === 'out');
    expect(outs.every((p) => p.state === 'blocked' && p.blockedBy === 'terrain')).toBe(true);
    // Aiming at the press starts a belt at its input (west), not at its outputs in the water.
    const start = startCell(s, [18, 22], [18.95, 22.5]).cell;
    expect(s.terrain.isWetCell(start[0], start[1])).toBe(false);
    expect(start[0]).toBeLessThan(18);
  });
});
