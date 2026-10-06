import { describe, expect, it } from 'vitest';
import { FactorySim } from './FactorySim';
import { rotateCell, rotatedSize, type Rot } from './dirs';
import { BELT, DRILL, MACHINE } from '../../data/balance';
import { RECIPES, RECIPES_BY_ID } from '../../data/recipes';
import { ITEMS } from '../../data/items';
import { BUILDINGS } from '../../data/buildings';
import type { ConveyorB, DrillB, FactorySave, MachineB } from './types';
import { FACTORY_MAP, LEGACY_MAP_OFFSET } from '../../data/factoryMap';
import { Inventory, Wallet } from '../../state/Inventory';

const rich = { plate: 10_000, iron_rod: 10_000, bolt: 10_000 };
const TICKS_PER_TILE = BELT.SEG / BELT.SPEED;

function sim(opts: ConstructorParameters<typeof FactorySim>[0] = {}) {
  return new FactorySim({ width: 32, height: 32, storage: rich, hub: null, ...opts });
}

/** Places a straight line of conveyors from (x, z) going toward `rot`. */
function line(s: FactorySim, x: number, z: number, rot: Rot, n: number) {
  const dx = [0, 1, 0, -1][rot]!;
  const dz = [1, 0, -1, 0][rot]!;
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = s.place('conveyor', x + dx * i, z + dz * i, rot);
    if (!r.ok) throw new Error(`cannot place conveyor: ${r.check.error}`);
    ids.push(r.building.id);
  }
  return ids;
}

function conveyor(s: FactorySim, id: number) {
  return s.buildings.get(id) as ConveyorB;
}

describe('dirs', () => {
  it('rotateCell keeps footprints anchored at (0,0) and matches side rotation', () => {
    // 1×2 footprint, front cell (0,1) facing +Z. After one turn the front must face +X at the max-X cell.
    expect(rotatedSize(1, 2, 1)).toEqual([2, 1]);
    expect(rotateCell(0, 1, 1, 1, 2)).toEqual([1, 0]);
    expect(rotateCell(0, 0, 1, 1, 2)).toEqual([0, 0]);
    expect(rotateCell(0, 1, 2, 1, 2)).toEqual([0, 0]);
    expect(rotateCell(0, 1, 3, 1, 2)).toEqual([0, 0]);
    expect(rotateCell(0, 0, 3, 1, 2)).toEqual([1, 0]);
    for (const r of [0, 1, 2, 3] as Rot[]) {
      const [rw, rh] = rotatedSize(3, 2, r);
      const seen = new Set<string>();
      for (let x = 0; x < 3; x++) for (let z = 0; z < 2; z++) {
        const [a, b] = rotateCell(x, z, r, 3, 2);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(rw);
        expect(b).toBeLessThan(rh);
        seen.add(`${a},${b}`);
      }
      expect(seen.size).toBe(6);
    }
  });
});

describe('placement', () => {
  it('rejects occupied cells, out of bounds, and unaffordable buildings', () => {
    const s = sim({ storage: { plate: 1 } });
    expect(s.place('conveyor', 0, 0, 0).ok).toBe(true);
    const occ = s.place('conveyor', 0, 0, 0);
    expect(occ.ok).toBe(false);
    expect(!occ.ok && occ.check.error).toBe('occupied');
    const cost = s.check('conveyor', 1, 0, 0);
    expect(cost.error).toBe('cost');
    expect(s.check('press', 31, 31, 0, { free: true }).error).toBe('outOfBounds');
  });

  it('drills need a resource node and mine its resource', () => {
    const s = sim({ nodes: [{ resource: 'iron', x: 5, z: 5, w: 1, h: 1 }] });
    expect(s.check('drill', 10, 10, 0).error).toBe('needsNode');
    const r = s.place('drill', 4, 5, 0); // second footprint cell (5,5) is on the node
    expect(r.ok && r.building.type === 'drill' && r.building.resource).toBe('iron');
  });

  it('dismantling refunds cost and contents', () => {
    const s = sim({ storage: { plate: 5 } });
    const r = s.place('conveyor', 2, 2, 0);
    expect(s.count('plate')).toBe(4);
    if (!r.ok) throw new Error();
    (r.building as ConveyorB).items.push({ item: 'bolt', pos: 10, prev: 10, from: 2 });
    s.remove(r.building.id);
    expect(s.count('plate')).toBe(5);
    expect(s.count('bolt')).toBe(1);
    expect(s.at(2, 2)).toBeUndefined();
  });

  it('the hub cannot be dismantled', () => {
    const s = sim({ hub: { x: 10, z: 10, rot: 0 } });
    const hub = s.at(11, 11)!;
    expect(hub.type).toBe('hub');
    expect(s.remove(hub.id)).toBe(false);
  });
});

describe('conveyors', () => {
  it('move items at exactly one tile per second (20 ticks)', () => {
    const s = sim({ hub: { x: 0, z: 10, rot: 0 } });
    // line from (1,0) to (1,9) going +Z, ending into the hub at z=10..12
    const ids = line(s, 1, 0, 0, 10);
    conveyor(s, ids[0]!).items.push({ item: 'plate', pos: 0, prev: 0, from: 2 });
    s.run(TICKS_PER_TILE * 10 - 1);
    expect(s.count('plate')).toBe(rich.plate - 10);
    s.tick();
    expect(s.delivered.plate).toBe(1);
  });

  it('keeps spacing and loses nothing when blocked', () => {
    const s = sim();
    const ids = line(s, 3, 3, 1, 4); // dead end
    const first = conveyor(s, ids[0]!);
    let inserted = 0;
    for (let t = 0; t < 400; t++) {
      const last = first.items[first.items.length - 1];
      if (!last || last.pos >= BELT.SPACING) {
        first.items.push({ item: 'bolt', pos: 0, prev: 0, from: 2 });
        inserted++;
      }
      s.tick();
    }
    let total = 0;
    for (const id of ids) {
      const c = conveyor(s, id);
      total += c.items.length;
      for (let i = 1; i < c.items.length; i++) expect(c.items[i - 1]!.pos - c.items[i]!.pos).toBeGreaterThanOrEqual(BELT.SPACING);
      expect(c.items.length).toBeLessThanOrEqual(Math.floor(BELT.SEG / BELT.SPACING) + 1);
    }
    expect(total).toBe(inserted);
    expect(conveyor(s, ids[3]!).items[0]!.pos).toBe(BELT.SEG);
  });

  it('merges two side feeds round-robin', () => {
    const s = sim({ hub: { x: 10, z: 20, rot: 0 } });
    // trunk going +Z at x=11 from z=10 to z=19 into hub
    line(s, 11, 10, 0, 10);
    // left feeder: going +X into (11,12) from x=8..10
    const left = line(s, 8, 12, 1, 3);
    // right feeder: going -X into (11,14) from x=14..12
    const right = line(s, 14, 14, 3, 3);
    for (let t = 0; t < 2000; t++) {
      for (const [ids, item] of [[left, 'plate'], [right, 'bolt']] as const) {
        const c = conveyor(s, ids[0]!);
        const last = c.items[c.items.length - 1];
        if (!last || last.pos >= BELT.SPACING) c.items.push({ item, pos: 0, prev: 0, from: 2 });
      }
      s.tick();
    }
    const p = s.delivered.plate ?? 0;
    const b = s.delivered.bolt ?? 0;
    expect(p + b).toBeGreaterThan(100);
    expect(Math.abs(p - b)).toBeLessThanOrEqual(Math.ceil((p + b) * 0.1));
    // trunk tiles fed from the back and a side are junctions
    expect(s.conveyorShape(s.at(11, 12)!.id)).toBe('junction');
    expect(s.conveyorShape(s.at(11, 14)!.id)).toBe('junction');
  });

  it('a tile fed only from a side is a corner', () => {
    const s = sim();
    line(s, 5, 5, 0, 2); // (5,5),(5,6) facing +Z
    line(s, 2, 5, 1, 3); // (2..4,5) facing +X into (5,5) from its left (-X)
    expect(s.conveyorShape(s.at(5, 5)!.id)).toBe('left');
    const t = sim();
    line(t, 5, 5, 0, 1);
    line(t, 8, 5, 3, 3); // facing -X into (5,5) from its right (+X)
    expect(t.conveyorShape(t.at(5, 5)!.id)).toBe('right');
    expect(t.conveyorShape(t.at(8, 5)!.id)).toBe('straight');
  });

  it('two side feeders into one tile alternate fairly', () => {
    const s = sim({ hub: { x: 4, z: 12, rot: 0 } });
    line(s, 5, 5, 0, 7); // (5,5..11) → hub
    const left = line(s, 2, 5, 1, 3); // into (5,5) from -X
    const right = line(s, 8, 5, 3, 3); // into (5,5) from +X
    for (let t = 0; t < 3000; t++) {
      for (const [ids, item] of [[left, 'plate'], [right, 'bolt']] as const) {
        const c = conveyor(s, ids[0]!);
        const last = c.items[c.items.length - 1];
        if (!last || last.pos >= BELT.SPACING) c.items.push({ item, pos: 0, prev: 0, from: 2 });
      }
      s.tick();
    }
    const p = s.delivered.plate ?? 0;
    const b = s.delivered.bolt ?? 0;
    expect(p + b).toBeGreaterThan(200);
    expect(Math.abs(p - b)).toBeLessThanOrEqual(2);
  });

  it('conveyors never accept from their front', () => {
    const s = sim();
    const a = line(s, 5, 5, 0, 1)[0]!; // faces +Z
    const b = line(s, 5, 6, 2, 1)[0]!; // faces -Z, head-on
    expect(s.linkOf(a)).toBeNull();
    expect(s.linkOf(b)).toBeNull();
  });
});

describe('machines', () => {
  it('drill → smelter → hub produces ingots at the drill rate', () => {
    const s = sim({ nodes: [{ resource: 'iron', x: 5, z: 0, w: 1, h: 2 }], hub: { x: 4, z: 8, rot: 0 } });
    expect(s.place('drill', 5, 0, 0).ok).toBe(true); // cells (5,0),(6,0); out (5,0) +Z → (5,1)
    line(s, 5, 1, 0, 3); // (5,1..3)
    const smelter = s.place('smelter', 5, 4, 0); // cells (5,4),(6,4); in at (5,4) back; out (5,4) +Z → (5,5)
    if (!smelter.ok) throw new Error(smelter.check.error);
    s.setRecipe(smelter.building.id, 'iron_ingot');
    line(s, 5, 5, 0, 3); // (5,5..7) → hub at z=8
    s.run(20 * 60); // one minute
    const ingots = s.delivered.iron_ingot ?? 0;
    // 1 ore / 2 s → ~30 ingots/min minus pipeline latency
    expect(ingots).toBeGreaterThanOrEqual(25);
    expect(ingots).toBeLessThanOrEqual(30);
    expect((s.buildings.get(smelter.building.id) as MachineB).status).not.toBe('noRecipe');
  });

  it('respects recipe duration and input caps', () => {
    const s = sim();
    const r = s.place('assembler', 2, 2, 0);
    if (!r.ok) throw new Error();
    const m = r.building as MachineB;
    s.setRecipe(m.id, 'chassis');
    const recipe = RECIPES.find((x) => x.id === 'chassis')!;
    m.inBuf = { plate: 2, iron_rod: 2, bolt: 4 };
    s.tick(); // starts
    expect(m.status).toBe('working');
    s.run(recipe.ticks - 1);
    expect(m.outBuf.length).toBe(0);
    s.tick();
    expect(m.outBuf).toEqual(['chassis']);
    // input cap
    const feed = line(s, 2, 1, 0, 1)[0]!; // conveyor at (2,1) feeding back port at (2,2)
    for (let i = 0; i < 50; i++) {
      const c = conveyor(s, feed);
      const last = c.items[c.items.length - 1];
      if (!last || last.pos >= BELT.SPACING) c.items.push({ item: 'plate', pos: 0, prev: 0, from: 2 });
      s.tick();
    }
    expect(m.inBuf.plate ?? 0).toBeLessThanOrEqual(2 * MACHINE.IN_CAP_FACTOR);
  });

  it('blocks when the output buffer is full and resumes when drained', () => {
    const s = sim();
    const r = s.place('press', 2, 2, 0);
    if (!r.ok) throw new Error();
    const m = r.building as MachineB;
    s.setRecipe(m.id, 'bolts'); // 1 rod → 4 bolts: 9 waiting + 4 does not fit
    m.outBuf = Array(MACHINE.OUT_CAP - 1).fill('bolt');
    m.inBuf = { iron_rod: 2 };
    s.tick();
    expect(m.status).toBe('blocked');
    m.outBuf = [];
    s.tick();
    expect(m.status).toBe('working');
  });

  it('changing recipe refunds buffers', () => {
    const s = sim({ storage: {} });
    const r = s.place('press', 2, 2, 0, { free: true });
    if (!r.ok) throw new Error();
    s.setRecipe(r.building.id, 'iron_plate');
    (r.building as MachineB).inBuf = { iron_ingot: 2 };
    s.setRecipe(r.building.id, 'iron_rod');
    expect(s.count('iron_ingot')).toBe(2);
  });

  it('drills stop when their output is full', () => {
    const s = sim({ nodes: [{ resource: 'rubber', x: 1, z: 1, w: 1, h: 1 }] });
    const r = s.place('drill', 1, 1, 0);
    if (!r.ok) throw new Error();
    s.run(DRILL.PERIOD * (DRILL.OUT_CAP + 5));
    expect((r.building as { outBuf: string[] }).outBuf.length).toBe(DRILL.OUT_CAP);
    expect(s.crafted.latex).toBe(DRILL.OUT_CAP);
  });
});

describe('determinism & persistence', () => {
  function bigFactory() {
    const s = FactorySim.newGame();
    s.give({ plate: 500, iron_rod: 500, bolt: 500 });
    // an iron drill on the west node (44..47, 61..64) feeding a smelter, a constructor, then the hub (62..64, 62..64)
    s.place('drill', 46, 61, 1); // cells (46,61),(46,62), out +X → (47,62)
    line(s, 47, 62, 1, 4); // (47..50, 62)
    const f = s.place('smelter', 51, 62, 1); // cells (51,62),(51,63): in from -X; out +X → (52,62)
    if (!f.ok) throw new Error(f.check.error);
    s.setRecipe(f.building.id, 'iron_ingot');
    line(s, 52, 62, 1, 3); // (52..54, 62)
    const p = s.place('press', 55, 62, 1); // cells (55,62),(55,63); out → (56,62)
    if (!p.ok) throw new Error(p.check.error);
    s.setRecipe(p.building.id, 'iron_plate');
    line(s, 56, 62, 1, 6); // (56..61, 62) → hub at x=62
    return s;
  }

  it('save/load mid-run gives exactly the same state as a straight run', () => {
    const a = bigFactory();
    const b = bigFactory();
    a.run(2000);
    b.run(1000);
    const c = FactorySim.fromSave(b.serialize());
    c.run(1000);
    expect(c.hash()).toBe(a.hash());
    expect(a.delivered.plate ?? 0).toBeGreaterThan(20);
  });

  it('serialization round-trips', () => {
    const a = bigFactory();
    a.run(777);
    const b = FactorySim.fromSave(JSON.parse(JSON.stringify(a.serialize())));
    expect(b.hash()).toBe(a.hash());
  });
});

describe('data integrity', () => {
  it('every recipe item exists and every machine type has recipes', () => {
    for (const r of RECIPES) {
      for (const s of [...r.inputs, ...r.outputs]) expect(ITEMS[s.item], `${r.id}:${s.item}`).toBeDefined();
      expect(r.ticks).toBeGreaterThan(0);
      expect(Number.isInteger(r.ticks)).toBe(true);
    }
    for (const b of Object.values(BUILDINGS)) {
      if (b.machine) expect(RECIPES.some((r) => r.machine === b.machine)).toBe(true);
      for (const p of b.ports) {
        expect(p.cell[0]).toBeLessThan(b.footprint[0]);
        expect(p.cell[1]).toBeLessThan(b.footprint[1]);
      }
    }
  });
});

describe('test layouts', () => {
  it('the demo factory delivers plates, rods, bolts and tires to the hub', async () => {
    const { spawnDemoFactory } = await import('./testLayouts');
    const s = FactorySim.newGame();
    spawnDemoFactory(s);
    const machines = [...s.buildings.values()].filter((b): b is MachineB => b.type === 'smelter' || b.type === 'press');
    expect(machines.map((m) => m.recipe)).toEqual(['iron_ingot', 'iron_plate', 'iron_ingot', 'iron_rod', 'iron_ingot', 'iron_rod', 'bolts', 'tire']);
    s.run(20 * 90);
    expect(s.delivered.plate ?? 0).toBeGreaterThan(15);
    expect(s.delivered.iron_rod ?? 0).toBeGreaterThan(25);
    expect(s.delivered.bolt ?? 0).toBeGreaterThan(100);
    expect(s.delivered.tire ?? 0).toBeGreaterThan(15);
    // intermediates stay inside the chains
    expect(s.delivered.iron_ore ?? 0).toBe(0);
    expect(s.delivered.iron_ingot ?? 0).toBe(0);
    expect(machines.every((m) => m.status !== 'blocked')).toBe(true);
  });

  it('stress loops keep every item moving forever without loss', async () => {
    const { spawnStressLoops } = await import('./testLayouts');
    const s = new FactorySim({ hub: null, width: 64, height: 64 });
    const n = spawnStressLoops(s);
    expect(n).toBeGreaterThanOrEqual(2000);
    s.run(200);
    expect(s.beltItemCount()).toBe(n);
  });
});

describe('review regressions', () => {
  it('dismantling a building placed for free does not mint its cost', () => {
    const s = new FactorySim({ width: 16, height: 16, storage: {}, hub: null });
    const r = s.place('press', 2, 2, 0, { free: true });
    if (!r.ok) throw new Error(r.check.error);
    const saved = FactorySim.fromSave(s.serialize(), { width: 16, height: 16 });
    expect(s.remove(r.building.id)).toBe(true);
    expect(s.count('plate')).toBe(0);
    expect(saved.remove(r.building.id)).toBe(true);
    expect(saved.count('plate')).toBe(0);
  });

  it('a save referencing an unknown recipe loads safely and refunds buffers', () => {
    const s = new FactorySim({ width: 20, height: 20, storage: rich, hub: null });
    const p = s.place('press', 5, 5, 0);
    if (!p.ok) throw new Error();
    s.setRecipe(p.building.id, 'iron_plate');
    const save = s.serialize();
    const m = save.buildings.find((b) => b.id === p.building.id) as MachineB;
    m.recipe = 'plate_v0';
    m.status = 'working';
    m.progress = 3;
    m.inBuf = { iron_ore: 2 };
    const t = FactorySim.fromSave(save, { width: 20, height: 20 });
    expect(() => t.run(5)).not.toThrow();
    expect(t.count('iron_ore')).toBe(2);
    expect(() => t.remove(p.building.id)).not.toThrow();
  });

  it('a junction with three saturated inputs serves all of them fairly', () => {
    const s = sim({ hub: { x: 4, z: 12, rot: 0 } });
    line(s, 5, 5, 0, 7); // trunk (5,5..11) → hub
    const back = line(s, 5, 2, 0, 3); // (5,2..4) into (5,5) from the back
    const left = line(s, 2, 5, 1, 3);
    const right = line(s, 8, 5, 3, 3);
    for (let t = 0; t < 4000; t++) {
      for (const [ids, item] of [[back, 'tire'], [left, 'plate'], [right, 'bolt']] as const) {
        const c = conveyor(s, ids[0]!);
        const last = c.items[c.items.length - 1];
        if (!last || last.pos >= BELT.SPACING) c.items.push({ item, pos: 0, prev: 0, from: 2 });
      }
      s.tick();
    }
    const counts = ['tire', 'plate', 'bolt'].map((i) => s.delivered[i as 'tire'] ?? 0);
    expect(Math.min(...counts)).toBeGreaterThan(100);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2);
  });

  it('a producer feeding a junction side is not starved by belts', () => {
    const s = sim({ hub: { x: 4, z: 12, rot: 0 }, nodes: [{ resource: 'iron', x: 2, z: 5, w: 1, h: 1 }] });
    line(s, 5, 5, 0, 7);
    const back = line(s, 5, 2, 0, 3);
    s.place('drill', 2, 5, 1); // (2, 5..6) → out (2,5) +X → (3,5)
    line(s, 3, 5, 1, 2); // (3..4, 5) into (5,5) from the left
    for (let t = 0; t < 2000; t++) {
      const c = conveyor(s, back[0]!);
      const last = c.items[c.items.length - 1];
      if (!last || last.pos >= BELT.SPACING) c.items.push({ item: 'plate', pos: 0, prev: 0, from: 2 });
      s.tick();
    }
    // the drill makes 1 ore / 2 s = 50 in 2000 ticks; nearly all must get through
    expect(s.delivered.iron_ore ?? 0).toBeGreaterThanOrEqual(45);
  });

  it('items on a closed loop move at exactly one tile per second', () => {
    const s = sim();
    line(s, 2, 2, 1, 1); // (2,2) → +X
    line(s, 3, 2, 0, 1); // (3,2) → +Z
    line(s, 3, 3, 3, 1); // (3,3) → -X
    line(s, 2, 3, 2, 1); // (2,3) → -Z
    const start = conveyor(s, s.at(2, 2)!.id);
    start.items.push({ item: 'bolt', pos: 0, prev: 0, from: 2 });
    s.run(TICKS_PER_TILE * 4);
    // after exactly one lap it is back on the start tile at the same position
    expect(start.items.length).toBe(1);
    expect(start.items[0]!.pos).toBe(0);
  });
});

describe('machine orientation', () => {
  it('items cross a machine: in through the back long side, out through the front long side', () => {
    for (const rot of [0, 1, 2, 3] as Rot[]) {
      const s = sim();
      const r = s.place('press', 10, 10, rot);
      if (!r.ok) throw new Error(r.check.error);
      const ports = BUILDINGS.press.ports.map((p) => ({ ...s.portWorld(r.building, p.cell, p.side), dir: p.dir }));
      const cells = s.cellsFor('press', 10, 10, rot);
      // the long axis is perpendicular to the flow: both cells share the in side and the out side
      for (const dir of ['in', 'out'] as const) {
        const list = ports.filter((p) => p.dir === dir);
        expect(list).toHaveLength(2);
        expect(new Set(list.map((p) => `${p.cx},${p.cz}`)).size).toBe(2);
        expect(new Set(list.map((p) => p.side)).size).toBe(1);
      }
      const inSide = ports.find((p) => p.dir === 'in')!.side;
      const outSide = ports.find((p) => p.dir === 'out')!.side;
      expect(outSide).toBe(rot); // out = front, like a conveyor with the same rotation
      expect((inSide + 2) & 3).toBe(outSide);
      const longAlongX = new Set(cells.map((c) => c[0])).size === 2;
      expect(longAlongX).toBe(rot % 2 === 0); // flow ±Z → long along X, flow ±X → long along Z
    }
  });

  it('either front cell can feed the output conveyor', () => {
    for (const dx of [0, 1]) {
      const s = sim({ hub: { x: 4, z: 8, rot: 0 } });
      const p = s.place('press', 5, 4, 0, { free: true }); // cells (5,4),(6,4)
      if (!p.ok) throw new Error();
      line(s, 5 + dx, 5, 0, 3); // out conveyor in front of cell dx → hub
      expect(s.linkOf(p.building.id)?.target).toBe(s.at(5 + dx, 5)!.id);
    }
  });

  it('saves from the 64×64 map are shifted onto the 128×128 map around the hub', () => {
    const old = FactorySim.newGame().serialize();
    old.version = 2;
    old.buildings = [
      { type: 'hub', id: 1, x: 30, z: 30, rot: 0 },
      { type: 'conveyor', id: 2, x: 29, z: 31, rot: 1, items: [], lastFrom: -1 },
    ];
    old.nextId = 3;
    const t = FactorySim.fromSave(old);
    expect(t.width).toBe(128);
    const hub = t.buildings.get(1)!;
    expect([hub.x, hub.z]).toEqual([FACTORY_MAP.hub.x, FACTORY_MAP.hub.z]);
    expect(t.at(61, 63)?.id).toBe(2);
    expect(t.linkOf(2)?.target).toBe(1); // still feeding the hub
  });

  it('v1 saves turn machines a quarter so they keep the same cells', () => {
    const s = sim();
    const p = s.place('press', 5, 5, 0);
    const c = s.place('conveyor', 9, 9, 0);
    if (!p.ok || !c.ok) throw new Error();
    const save = s.serialize();
    save.version = 1;
    const old = save.buildings.find((b) => b.id === p.building.id)!;
    old.rot = 0; // v1 rot 0 = 1×2 along Z: cells (5,5),(5,6), shifted by the map growth
    s.buildings.clear();
    const t = FactorySim.fromSave(save, { width: 128, height: 128 });
    const m = t.buildings.get(p.building.id)!;
    expect(m.rot).toBe(1);
    const o = LEGACY_MAP_OFFSET;
    expect(t.cellsFor(m.type, m.x, m.z, m.rot)).toEqual([[5 + o, 5 + o], [5 + o, 6 + o]]);
    expect(t.buildings.get(c.building.id)!.rot).toBe(0); // conveyors untouched
    expect(t.serialize().version).toBe(3);
  });
});

describe('manual feeding & pickup', () => {
  it('loads recipe inputs from storage up to the cap and collects outputs', () => {
    const s = sim({ storage: { plate: 10, iron_rod: 25, bolt: 3, latex: 5 } });
    const r = s.place('assembler', 2, 2, 0, { free: true });
    if (!r.ok) throw new Error();
    const m = r.building as MachineB;
    expect(s.loadFromStorage(m.id)).toBe(0); // no recipe yet
    s.setRecipe(m.id, 'chassis'); // 2 plates + 2 rods + 4 bolts, manual cap ×10
    expect(s.loadFromStorage(m.id)).toBe(10 + 20 + 3);
    expect(m.inBuf).toEqual({ plate: 10, iron_rod: 20, bolt: 3 });
    expect(s.count('plate')).toBe(0);
    expect(s.count('iron_rod')).toBe(5); // above the cap: stays in the hub
    expect(s.count('bolt')).toBe(0);
    expect(s.count('latex')).toBe(5); // not an input
    s.give({ bolt: 10 });
    s.loadFromStorage(m.id);
    s.run(130);
    expect(m.outBuf).toEqual(['chassis']);
    expect(s.collectOutput(m.id)).toBe(1);
    expect(s.count('chassis')).toBe(1);
    expect(m.outBuf).toEqual([]);
  });
});

describe('iron chain (ore → ingot → plate, rod, bolts)', () => {
  /**
   * Straight chain along +Z: iron drill at (5,0) → [2 belts → machine] per step → 2 belts → hub.
   * Machines at rot 0 cover (5,z),(6,z): in through the back of (5,z), out through its front.
   */
  function ironChain(steps: [type: 'smelter' | 'press', recipe: string][]) {
    const s = sim({ nodes: [{ resource: 'iron', x: 5, z: 0, w: 1, h: 1 }] });
    const d = s.place('drill', 5, 0, 0); // out (5,0) +Z → (5,1)
    if (!d.ok) throw new Error(d.check.error);
    let z = 1;
    const machines: MachineB[] = [];
    for (const [type, recipe] of steps) {
      line(s, 5, z, 0, 2);
      z += 2;
      const m = s.place(type, 5, z, 0);
      if (!m.ok) throw new Error(m.check.error);
      expect(s.setRecipe(m.building.id, recipe)).toBe(true);
      machines.push(m.building as MachineB);
      z += 1;
    }
    line(s, 5, z, 0, 2);
    if (!s.place('hub', 4, z + 2, 0, { free: true, force: true }).ok) throw new Error('hub');
    return { s, machines, drill: d.building as DrillB };
  }

  /** Items per minute delivered to the hub once the chain is warm (second minute of production). */
  function steadyRate(s: FactorySim, item: 'plate' | 'iron_rod' | 'bolt' | 'iron_ingot') {
    s.run(20 * 60);
    const before = s.delivered[item] ?? 0;
    const ingots = s.crafted.iron_ingot ?? 0;
    s.run(20 * 60);
    return { delivered: (s.delivered[item] ?? 0) - before, ingots: (s.crafted.iron_ingot ?? 0) - ingots };
  }

  it.each([
    { name: 'plates', steps: [['smelter', 'iron_ingot'], ['press', 'iron_plate']], item: 'plate', perMin: 20, batch: 2 },
    { name: 'rods', steps: [['smelter', 'iron_ingot'], ['press', 'iron_rod']], item: 'iron_rod', perMin: 30, batch: 1 },
    { name: 'bolts', steps: [['smelter', 'iron_ingot'], ['press', 'iron_rod'], ['press', 'bolts']], item: 'bolt', perMin: 120, batch: 4 },
  ] as const)('drill → smelter → constructor → hub delivers $name at the drill rate', ({ steps, item, perMin, batch }) => {
    const { s, machines } = ironChain(steps.map((x) => [...x]));
    const rate = steadyRate(s, item);
    // 1 drill (30 ore/min) = 1 smelter (30 ingots/min) = 1 constructor, give or take one batch
    expect(rate.ingots).toBeGreaterThanOrEqual(29);
    expect(rate.ingots).toBeLessThanOrEqual(31);
    expect(rate.delivered).toBeGreaterThanOrEqual(perMin - batch);
    expect(rate.delivered).toBeLessThanOrEqual(perMin + batch);
    // only the end product reaches the hub, and no machine backs up
    expect(Object.keys(s.delivered)).toEqual([item]);
    for (const m of machines) expect(m.status).not.toBe('blocked');
  });

  it('a constructor ignores ore and accepts only its recipe inputs from a belt', () => {
    const { s, machines, drill } = ironChain([['press', 'iron_plate']]); // no smelter: ore arrives at the constructor
    s.run(20 * 30);
    expect(machines[0]!.inBuf).toEqual({});
    expect(s.delivered).toEqual({});
    // the belt in front of it backs up instead of losing anything
    expect(s.beltItemCount()).toBeGreaterThan(0);
    expect(s.beltItemCount() + drill.outBuf.length).toBe(s.crafted.iron_ore);
  });

  it('smelters only take smelter recipes', () => {
    const s = sim();
    const f = s.place('smelter', 2, 2, 0);
    const p = s.place('press', 2, 6, 0);
    if (!f.ok || !p.ok) throw new Error();
    expect(s.setRecipe(f.building.id, 'iron_plate')).toBe(false);
    expect(s.setRecipe(f.building.id, 'hand_ingot')).toBe(false); // bench recipes are hand-only
    expect(s.setRecipe(p.building.id, 'iron_ingot')).toBe(false);
    expect(s.setRecipe(p.building.id, 'hand_plate')).toBe(false);
    expect(s.setRecipe(f.building.id, 'iron_ingot')).toBe(true);
    expect((f.building as MachineB).status).toBe('idle');
  });
});

describe('hand mining (mineAt)', () => {
  const nodes = [
    { resource: 'iron' as const, x: 5, z: 5, w: 2, h: 2 },
    { resource: 'rubber' as const, x: 12, z: 3, w: 1, h: 1 },
  ];

  it('a free node cell gives one item of its resource', () => {
    const s = sim({ storage: {}, nodes });
    const inv = new Inventory();
    expect(s.mineAt(5, 5, inv)).toBe('iron_ore');
    expect(s.mineAt(6, 6, inv)).toBe('iron_ore');
    expect(s.mineAt(12, 3, inv)).toBe('latex');
    expect(inv.totals()).toEqual({ iron_ore: 2, latex: 1 });
    // nodes never run out, and mining is not production: the hub and the stats are untouched
    for (let i = 0; i < 150; i++) s.mineAt(5, 6, inv);
    expect(inv.count('iron_ore')).toBe(152);
    expect(s.storage).toEqual({});
    expect(s.crafted).toEqual({});
  });

  it('nothing to mine off a node, out of the map, or under a building', () => {
    const s = sim({ storage: {}, nodes });
    const inv = new Inventory();
    expect(s.mineAt(4, 5, inv)).toBeNull();
    expect(s.mineAt(-1, 5, inv)).toBeNull();
    expect(s.mineAt(5, 99, inv)).toBeNull();
    const d = s.place('drill', 5, 5, 0, { free: true }); // covers (5,5),(6,5)
    const c = s.place('conveyor', 12, 3, 0, { free: true }); // a belt on the rubber node
    if (!d.ok || !c.ok) throw new Error();
    expect(s.mineAt(5, 5, inv)).toBeNull();
    expect(s.mineAt(6, 5, inv)).toBeNull();
    expect(s.mineAt(12, 3, inv)).toBeNull();
    expect(inv.usedSlots).toBe(0);
    expect(s.mineAt(5, 6, inv)).toBe('iron_ore'); // the rest of the node stays minable
    s.remove(d.building.id);
    expect(s.mineAt(5, 5, inv)).toBe('iron_ore');
  });

  it('a full sink gives nothing and nothing is lost', () => {
    const s = sim({ storage: {}, nodes });
    const inv = new Inventory(1);
    inv.add('plate', 1); // the only slot holds something else
    expect(s.mineAt(5, 5, inv)).toBeNull();
    expect(inv.totals()).toEqual({ plate: 1 });
    const full = new Inventory(1);
    full.add('iron_ore', ITEMS.iron_ore.stack);
    expect(s.mineAt(5, 5, full)).toBeNull();
    expect(full.count('iron_ore')).toBe(ITEMS.iron_ore.stack);
    expect(s.storage).toEqual({});
    // through a wallet, a full backpack overflows to the hub
    expect(s.mineAt(5, 5, new Wallet(full, s.hub))).toBe('iron_ore');
    expect(s.count('iron_ore')).toBe(1);
  });
});

describe('save migrations (progression)', () => {
  function saveWith(type: 'smelter' | 'press' | 'assembler', patch: Partial<MachineB>) {
    const s = new FactorySim({ width: 20, height: 20, storage: {}, hub: null });
    const p = s.place(type, 5, 5, 0, { free: true });
    if (!p.ok) throw new Error();
    const save = s.serialize();
    Object.assign(save.buildings.find((b) => b.id === p.building.id)!, patch);
    return { save, id: p.building.id };
  }
  const load = (save: FactorySave) => FactorySim.fromSave(JSON.parse(JSON.stringify(save)), { width: 20, height: 20 });

  it('a constructor saved with an old ore recipe is reset and its items go back to the hub', () => {
    for (const [recipe, outBuf] of [['plate', ['plate']], ['bolt', ['bolt', 'bolt']]] as const) {
      const { save, id } = saveWith('press', { recipe, inBuf: { iron_ore: 3 }, outBuf: [...outBuf], status: 'working', progress: 12 });
      const t = load(save);
      const m = t.buildings.get(id) as MachineB;
      expect(m).toMatchObject({ type: 'press', recipe: null, inBuf: {}, outBuf: [], progress: 0, status: 'noRecipe' });
      expect(t.storage).toEqual({ iron_ore: 3, [outBuf[0]]: outBuf.length });
      t.run(5);
      expect(m.status).toBe('noRecipe');
      expect(t.setRecipe(id, 'iron_plate')).toBe(true); // usable right away with a new recipe
    }
  });

  it('a recipe of another machine is reset too', () => {
    const { save, id } = saveWith('press', { recipe: 'iron_ingot', inBuf: { iron_ore: 2 } });
    const t = load(save);
    expect((t.buildings.get(id) as MachineB).recipe).toBeNull();
    expect(t.count('iron_ore')).toBe(2);
  });

  it('stale items that are not inputs of a kept recipe are cleaned and refunded', () => {
    const inBuf = { plate: 2, bolt: 4, tire: 3, unobtainium: 5 } as MachineB['inBuf'];
    const { save, id } = saveWith('assembler', { recipe: 'chassis', inBuf, outBuf: ['chassis'], status: 'idle' });
    const t = load(save);
    const m = t.buildings.get(id) as MachineB;
    expect(m.recipe).toBe('chassis');
    expect(m.inBuf).toEqual({ plate: 2, bolt: 4 });
    expect(m.outBuf).toEqual(['chassis']);
    expect(t.storage).toEqual({ tire: 3 }); // unknown ids are dropped, not minted
    // the machine still works once the new input (rods) arrives
    t.give({ iron_rod: 2 });
    expect(t.loadFromStorage(id)).toBe(2);
    t.run(RECIPES_BY_ID.chassis!.ticks + 2);
    expect(m.outBuf).toEqual(['chassis', 'chassis']);
  });

  it('a working smelter round-trips', () => {
    const s = new FactorySim({ width: 20, height: 20, storage: { iron_ore: 7 }, hub: null });
    const f = s.place('smelter', 5, 5, 0, { free: true });
    if (!f.ok) throw new Error();
    s.setRecipe(f.building.id, 'iron_ingot');
    s.loadFromStorage(f.building.id);
    s.run(50);
    const t = load(s.serialize());
    const m = t.buildings.get(f.building.id) as MachineB;
    expect(m).toMatchObject({ type: 'smelter', recipe: 'iron_ingot', status: 'working' });
    expect(t.hash()).toBe(s.hash());
    s.run(300);
    t.run(300);
    expect(t.hash()).toBe(s.hash());
    expect(m.outBuf).toHaveLength(7);
  });
});
