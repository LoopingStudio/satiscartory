import { BUILDINGS } from '../../data/buildings';
import { DX, DZ, opposite, unrotateSide, type Rot } from './dirs';
import type { FactorySim } from './FactorySim';
import type { Building, PlanLinks, Placement } from './types';

/**
 * Conveyor placement helpers (pure): orientation that connects to the ports around a cell, snapping an
 * aimed building cell to one of its free ports, and the L path of a drag. Satisfactory-like: a belt laid
 * against a machine connects without fiddling with R.
 */

const ROTS: Rot[] = [0, 1, 2, 3];

/** Direction (as a rotation) from one cell to an adjacent one. */
export function dirTo(from: readonly [number, number], to: readonly [number, number]): Rot {
  return to[0] > from[0] ? 1 : to[0] < from[0] ? 3 : to[1] > from[1] ? 0 : 2;
}

function conveyorLinks(sim: FactorySim, x: number, z: number, rot: Rot): PlanLinks {
  return sim.planLinks([{ type: 'conveyor', x, z, rot }])[0]!;
}

/** Feeds a building that is not a conveyor (machine input, hub): the point of laying a belt there. */
function feedsMachine(sim: FactorySim, l: PlanLinks): boolean {
  const t = l.out ? sim.buildings.get(l.out.target) : undefined;
  return !!t && t.type !== 'conveyor';
}

/**
 * An existing building that would feed the planned belt only by taking its output away from where it goes
 * now (a machine outputs through one port only): placing the belt cuts the line that works.
 */
export function steals(sim: FactorySim, feeder: { id: number }): boolean {
  const b = feeder.id >= 0 ? sim.buildings.get(feeder.id) : undefined;
  // A splitter feeds every output that takes items: a new one takes nothing away.
  return !!b && !BUILDINGS[b.type].multiOut && !!sim.linkOf(feeder.id);
}

/** Runs into a building that refuses its items (front onto a machine's wall or output, head-on belt). */
function deadEnd(sim: FactorySim, x: number, z: number, rot: Rot, l: PlanLinks): boolean {
  return !l.out && !!sim.at(x + DX[rot], z + DZ[rot]);
}

/** Rotation distance between two rotations (0..2). */
function turns(a: Rot, b: Rot): number {
  const d = (a - b + 4) & 3;
  return d === 3 ? 1 : d;
}

/**
 * Orientation of a single conveyor at (x, z): the one that connects best to what surrounds it. Feeding a
 * machine or the hub counts most, then receiving from an output or a belt end; running into a building
 * that refuses, or taking a machine's output away from its current line, counts against (merging into
 * another belt counts for nothing: no forced merge into a line running alongside). Among equals, a straight
 * entry from the back (in line with what feeds it), then `preferred` (the last orientation used), then the
 * nearest turn. `linked`: the chosen orientation feeds a machine/the hub or receives something.
 */
export function snapConveyorRot(sim: FactorySim, x: number, z: number, preferred: Rot): { rot: Rot; linked: boolean } {
  const cands = ROTS.map((r) => {
    const l = conveyorLinks(sim, x, z, r);
    const feeds = feedsMachine(sim, l);
    const fed = l.in.filter((f) => !steals(sim, f));
    const stolen = fed.length < l.in.length;
    const score = (feeds ? 2 : 0) + (fed.length ? 1 : 0) - (deadEnd(sim, x, z, r, l) ? 1 : 0) - (stolen ? 1 : 0);
    const straight = fed.some((f) => unrotateSide(f.link.entry, r) === 2);
    return { r, score, straight, linked: feeds || fed.length > 0 };
  });
  cands.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.straight) - Number(a.straight) ||
      Number(b.r === preferred) - Number(a.r === preferred) ||
      turns(a.r, preferred) - turns(b.r, preferred) ||
      a.r - b.r,
  );
  return { rot: cands[0]!.r, linked: cands[0]!.linked };
}

/**
 * An end of a conveyor drag: the cell, the kind of port it lies in front of, and that port's building. A
 * belt leaves an output ('out', also the end of a belt it continues) and runs into an input ('in', also
 * along the hub); null for a plain cell (or a belt aimed at as the end, which the path merges into).
 */
export interface DragEnd {
  cell: [number, number];
  port: 'in' | 'out' | null;
  /** Building whose port it is (not set for a belt end). */
  target?: number;
}

/** Cells in front of the free ports of `b` of one kind (any free edge cell of the hub for inputs). */
function portCells(sim: FactorySim, b: Building, dir: 'in' | 'out'): [number, number][] {
  if (BUILDINGS[b.type].acceptsAllEdges) {
    if (dir === 'out') return [];
    const cells: [number, number][] = [];
    for (const [cx, cz] of sim.cellsFor(b.type, b.x, b.z, b.rot)) {
      for (let s = 0; s < 4; s++) {
        const nx = cx + DX[s];
        const nz = cz + DZ[s];
        if (sim.inBounds(nx, nz) && !sim.at(nx, nz)) cells.push([nx, nz]);
      }
    }
    return cells;
  }
  return sim.portsOf(b.id).filter((p) => p.state === 'free' && p.dir === dir).map((p) => [p.cx + DX[p.side], p.cz + DZ[p.side]]);
}

/**
 * Ports a free cell lies in front of (where their markers are drawn): free machine ports, hub edges (inputs)
 * and belt ends (outputs), in neighbor order.
 */
function portsAround(sim: FactorySim, cell: readonly [number, number]): DragEnd[] {
  const out: DragEnd[] = [];
  const [x, z] = cell;
  if (!freeCell(sim, x, z)) return out;
  for (let s = 0; s < 4; s++) {
    const n = sim.at(x + DX[s], z + DZ[s]);
    if (!n) continue;
    if (n.type === 'conveyor') {
      if (n.x + DX[n.rot] === x && n.z + DZ[n.rot] === z) out.push({ cell: [x, z], port: 'out' });
    } else if (BUILDINGS[n.type].acceptsAllEdges) out.push({ cell: [x, z], port: 'in', target: n.id });
    else {
      for (const p of sim.portsOf(n.id)) {
        if (p.state === 'free' && p.cx + DX[p.side] === x && p.cz + DZ[p.side] === z) out.push({ cell: [x, z], port: p.dir, target: n.id });
      }
    }
  }
  return out;
}

/** The candidate nearest to `to` (cell units, from cell centers), ties to the first. */
function nearest(cands: [number, number][], to: readonly [number, number]): [number, number] | null {
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const c of cands) {
    const d = Math.hypot(c[0] + 0.5 - to[0], c[1] + 0.5 - to[1]);
    if (d < bestD - 1e-9) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/**
 * Snaps an aimed cell taken by a building to the free cell in front of its nearest free port, trying the
 * kinds of `dirs` in order (for the hub, which accepts on every edge, the nearest free cell along it as an
 * input). `point` is the aimed point in cell units (fractional), the cell center by default. Null when the
 * cell is free, holds a conveyor, or the building has no free port of those kinds.
 */
export function snapToPort(sim: FactorySim, cell: readonly [number, number], point?: readonly [number, number], dirs: ('in' | 'out')[] = ['out', 'in']): DragEnd | null {
  const b = sim.at(cell[0], cell[1]);
  if (!b || b.type === 'conveyor') return null;
  const to = point ?? [cell[0] + 0.5, cell[1] + 0.5];
  for (const dir of dirs) {
    const c = nearest(portCells(sim, b, dir), to);
    if (c) return { cell: c, port: dir, target: b.id };
  }
  return null;
}

/**
 * Where a conveyor drag starts (or a single conveyor goes) for an aimed cell: just past the end of a belt
 * aimed at, to continue it; in front of the nearest free output of a building aimed at, else of its nearest
 * free input (the drag then flows toward it); a free cell keeps the kind of port it lies in front of (an
 * output first). Otherwise the cell itself.
 */
export function startCell(sim: FactorySim, cell: readonly [number, number], point?: readonly [number, number]): DragEnd {
  const plain: DragEnd = { cell: [cell[0], cell[1]], port: null };
  const b = sim.at(cell[0], cell[1]);
  if (b?.type === 'conveyor') {
    const nx = b.x + DX[b.rot];
    const nz = b.z + DZ[b.rot];
    return freeCell(sim, nx, nz) ? { cell: [nx, nz], port: 'out' } : plain;
  }
  if (b) return snapToPort(sim, cell, point, ['out', 'in']) ?? plain;
  const around = portsAround(sim, cell);
  return around.find((p) => p.port === 'out') ?? around.find((p) => p.port === 'in') ?? plain;
}

/**
 * Where a conveyor drag from `start` ends for an aimed cell. The port kind that completes the belt is an
 * input when the start is an output, an output when it is an input, an input else an output from a plain
 * cell. On a building: in front of its free port of that kind nearest the start (shortest belt), ties to the
 * aimed point; none: the cell itself. On a free cell: the kind of port it lies in front of, if it fits. On a
 * belt: its end when the drag comes from ahead of it (the new belt continues it) or from an input; else it
 * stays the end and the path merges into it.
 */
export function endCell(sim: FactorySim, cell: readonly [number, number], start: DragEnd, point?: readonly [number, number]): DragEnd {
  const dirs: ('in' | 'out')[] = start.port === 'out' ? ['in'] : start.port === 'in' ? ['out'] : ['in', 'out'];
  const keep: DragEnd = { cell: [cell[0], cell[1]], port: null };
  const b = sim.at(cell[0], cell[1]);
  if (!b) {
    const around = portsAround(sim, cell);
    for (const dir of dirs) {
      const p = around.find((a) => a.port === dir);
      if (p) return p;
    }
    return keep;
  }
  if (b.type === 'conveyor') {
    const nx = b.x + DX[b.rot];
    const nz = b.z + DZ[b.rot];
    const ahead = DX[b.rot] * (start.cell[0] - b.x) + DZ[b.rot] * (start.cell[1] - b.z) > 0;
    return freeCell(sim, nx, nz) && (start.port === 'in' || (start.port === null && ahead)) ? { cell: [nx, nz], port: 'out' } : keep;
  }
  const to = point ?? [cell[0] + 0.5, cell[1] + 0.5];
  const from: [number, number] = [start.cell[0] + 0.5, start.cell[1] + 0.5];
  for (const dir of dirs) {
    const cands = portCells(sim, b, dir);
    if (!cands.length) continue;
    // Shortest belt first; among equally far cells, the aimed one.
    const d = (c: [number, number]) => Math.abs(c[0] + 0.5 - from[0]) + Math.abs(c[1] + 0.5 - from[1]);
    const min = Math.min(...cands.map(d));
    return { cell: nearest(cands.filter((c) => d(c) === min), to)!, port: dir, target: b.id };
  }
  return keep;
}

/**
 * Conveyor path of a drag between two ends: from the start to the end, or the other way round when the
 * belt must flow toward the start (it starts at an input, or ends at an output); the last tile turns into
 * the input it was aimed at. A path over `max` tiles keeps the pressed end. See planConveyorPath.
 */
export function planDrag(sim: FactorySim, start: DragEnd, end: DragEnd, preferred: Rot, max = 64): Placement[] {
  const reverse = start.port === 'in' || (start.port === null && end.port === 'out');
  if (reverse) return planConveyorPath(sim, end.cell, start.cell, preferred, max, { target: start.port === 'in' ? start.target : undefined, keepTail: true });
  return planConveyorPath(sim, start.cell, end.cell, preferred, max, { target: end.port === 'in' ? end.target : undefined });
}

/** Cells of an L from a to b, one leg after the other. */
function lPath(a: readonly [number, number], b: readonly [number, number], xFirst: boolean): [number, number][] {
  const cells: [number, number][] = [[a[0], a[1]]];
  let x = a[0];
  let z = a[1];
  const sx = Math.sign(b[0] - a[0]);
  const sz = Math.sign(b[1] - a[1]);
  const legX = () => {
    while (x !== b[0]) cells.push([(x += sx), z]);
  };
  const legZ = () => {
    while (z !== b[1]) cells.push([x, (z += sz)]);
  };
  if (xFirst) {
    legX();
    legZ();
  } else {
    legZ();
    legX();
  }
  return cells;
}

/** Can a conveyor stand there (on the map, nothing built)? */
function freeCell(sim: FactorySim, x: number, z: number): boolean {
  return sim.inBounds(x, z) && !sim.at(x, z);
}

/**
 * Tiles along cells, each facing the next. The last one turns into `target` (an input aimed at) when it
 * can; else it goes straight on, or turns into a machine or hub input beside it if straight feeds none (it
 * can take any side but the one it receives from).
 */
function tilesAlong(sim: FactorySim, cells: [number, number][], target?: number): Placement[] {
  const path: Placement[] = cells.map((c, i) => ({ type: 'conveyor', x: c[0], z: c[1], rot: dirTo(c, cells[Math.min(i + 1, cells.length - 1)]!) }));
  const n = cells.length;
  const [x, z] = cells[n - 1]!;
  const straight = dirTo(cells[n - 2]!, cells[n - 1]!);
  const options = [straight, ...ROTS.filter((r) => r !== straight && r !== opposite(straight))];
  const links = options.map((r) => conveyorLinks(sim, x, z, r));
  let i = target !== undefined ? links.findIndex((l) => l.out?.target === target) : -1;
  if (i < 0) i = Math.max(0, links.findIndex((l) => feedsMachine(sim, l)));
  path[n - 1]!.rot = options[i]!;
  return path;
}

/** Does the last tile that can stand run into a building that refuses its items (e.g. head-on into a belt)? */
function endsDead(sim: FactorySim, path: Placement[]): boolean {
  for (let i = path.length - 1; i >= 0; i--) {
    const t = path[i]!;
    if (!freeCell(sim, t.x, t.z)) continue;
    return deadEnd(sim, t.x, t.z, t.rot, conveyorLinks(sim, t.x, t.z, t.rot));
  }
  return false;
}

/**
 * Conveyor drag from cell a to cell b: an L, along its longer leg first unless the other order goes around
 * more buildings, or (equal) is the only one whose last tile feeds `target`, or does not end head-on into a
 * building (a belt aimed at is merged into from the side). At most `max` tiles, cut at b's end when
 * `keepTail`. Tiles follow the path (see tilesAlong); a single tile snaps like snapConveyorRot.
 */
export function planConveyorPath(
  sim: FactorySim,
  a: readonly [number, number],
  b: readonly [number, number],
  preferred: Rot,
  max = 64,
  opts: { target?: number; keepTail?: boolean } = {},
): Placement[] {
  const single = (x: number, z: number): Placement[] => [{ type: 'conveyor', x, z, rot: snapConveyorRot(sim, x, z, preferred).rot }];
  if (a[0] === b[0] && a[1] === b[1]) return single(a[0], a[1]);
  const cap = Math.max(1, max);
  const majorX = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
  const options = [majorX, !majorX].map((xFirst) => {
    let cells = lPath(a, b, xFirst);
    if (cells.length > cap) cells = opts.keepTail ? cells.slice(-cap) : cells.slice(0, cap);
    const path = cells.length === 1 ? single(cells[0]![0], cells[0]![1]) : tilesAlong(sim, cells, opts.target);
    const last = path[path.length - 1]!;
    const feeds = opts.target === undefined || conveyorLinks(sim, last.x, last.z, last.rot).out?.target === opts.target;
    return { path, blocked: cells.filter(([x, z]) => !freeCell(sim, x, z)).length, feeds, dead: endsDead(sim, path) };
  });
  const [first, other] = options as [(typeof options)[0], (typeof options)[0]];
  const better =
    other.blocked < first.blocked ||
    (other.blocked === first.blocked && (other.feeds !== first.feeds ? other.feeds : first.dead && !other.dead));
  return (better ? other : first).path;
}
