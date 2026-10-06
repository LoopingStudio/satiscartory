import { BELT, DRILL, MACHINE, START_STORAGE } from '../../data/balance';
import { BUILDINGS, type BuildingType, type Side } from '../../data/buildings';
import { FACTORY_MAP, RESOURCES, type ResourceId, type ResourceNode } from '../../data/factoryMap';
import { isItemId, type Inventory, type ItemId } from '../../data/items';
import { RECIPES_BY_ID } from '../../data/recipes';
import { Emitter } from '../../core/events';
import { DX, DZ, opposite, rotateCell, rotateSide, rotatedSize, unrotateSide, type Rot } from './dirs';
import type { BeltItem, Building, ConveyorB, DrillB, FactorySave, HubB, Link, MachineB, PlaceCheck } from './types';

export interface SimEvents extends Record<string, unknown> {
  placed: Building;
  removed: Building;
  /** Links between buildings changed (conveyor shapes may change). */
  topology: undefined;
}

export interface FactorySimOptions {
  width?: number;
  height?: number;
  nodes?: ResourceNode[];
  storage?: Inventory;
  /** Pre-placed hub (null = none, e.g. in unit tests). */
  hub?: { x: number; z: number; rot: Rot } | null;
}

export type ConveyorShape = 'straight' | 'left' | 'right' | 'junction';

const RESOURCE_IDS = Object.keys(RESOURCES) as ResourceId[];

/**
 * Deterministic, grid-based factory simulation. Pure TypeScript: integers only,
 * iteration in id order, no wall-clock. Runs at FACTORY_HZ ticks per second.
 */
export class FactorySim {
  readonly width: number;
  readonly height: number;
  /** Building id per cell (0 = empty). */
  readonly grid: Int32Array;
  /** Resource index + 1 per cell (0 = none). */
  readonly nodeGrid: Int8Array;
  readonly nodes: ResourceNode[];
  readonly buildings = new Map<number, Building>();
  storage: Inventory;
  /** Items received by the hub since the start (objectives/stats). */
  delivered: Inventory = {};
  /** Items produced by drills and machines since the start. */
  crafted: Inventory = {};
  tickCount = 0;
  nextId = 1;
  readonly events = new Emitter<SimEvents>();

  private outLinks = new Map<number, Link | null>();
  private feeders = new Map<number, { id: number; side: Side }[]>();
  private convOrder: ConveyorB[] = [];
  private producers: (DrillB | MachineB)[] = [];
  private topoDirty = true;
  /** Transient (within one tick): items inserted onto belts that must not move until the next tick. */
  private fresh = new Set<BeltItem>();

  constructor(opts: FactorySimOptions = {}) {
    this.width = opts.width ?? 64;
    this.height = opts.height ?? 64;
    this.grid = new Int32Array(this.width * this.height);
    this.nodeGrid = new Int8Array(this.width * this.height);
    this.nodes = opts.nodes ?? [];
    for (const n of this.nodes) {
      const idx = RESOURCE_IDS.indexOf(n.resource) + 1;
      for (let x = n.x; x < n.x + n.w; x++) for (let z = n.z; z < n.z + n.h; z++) if (this.inBounds(x, z)) this.nodeGrid[this.idx(x, z)] = idx;
    }
    this.storage = { ...(opts.storage ?? {}) };
    if (opts.hub) this.place('hub', opts.hub.x, opts.hub.z, opts.hub.rot, { free: true, force: true });
  }

  /** New game with the default map, hub and starting stock. */
  static newGame(): FactorySim {
    return new FactorySim({
      nodes: FACTORY_MAP.nodes,
      storage: START_STORAGE,
      hub: FACTORY_MAP.hub,
    });
  }

  // ---------------------------------------------------------------- grid helpers

  inBounds(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.width && z < this.height;
  }

  private idx(x: number, z: number): number {
    return z * this.width + x;
  }

  at(x: number, z: number): Building | undefined {
    if (!this.inBounds(x, z)) return undefined;
    const id = this.grid[this.idx(x, z)]!;
    return id ? this.buildings.get(id) : undefined;
  }

  resourceAt(x: number, z: number): ResourceId | null {
    if (!this.inBounds(x, z)) return null;
    const v = this.nodeGrid[this.idx(x, z)]!;
    return v ? RESOURCE_IDS[v - 1]! : null;
  }

  /** World cells covered by a building of this type at (x, z, rot). */
  cellsFor(type: BuildingType, x: number, z: number, rot: Rot): [number, number][] {
    const [w, h] = BUILDINGS[type].footprint;
    const [rw, rh] = rotatedSize(w, h, rot);
    const cells: [number, number][] = [];
    for (let dz = 0; dz < rh; dz++) for (let dx = 0; dx < rw; dx++) cells.push([x + dx, z + dz]);
    return cells;
  }

  /** World cell + side of a local port. */
  portWorld(b: { type: BuildingType; x: number; z: number; rot: Rot }, cell: [number, number], side: Side): { cx: number; cz: number; side: Side } {
    const [w, h] = BUILDINGS[b.type].footprint;
    const [rx, rz] = rotateCell(cell[0], cell[1], b.rot, w, h);
    return { cx: b.x + rx, cz: b.z + rz, side: rotateSide(side, b.rot) };
  }

  // ---------------------------------------------------------------- inventory

  count(item: ItemId): number {
    return this.storage[item] ?? 0;
  }

  missingFor(cost: Inventory): Inventory | null {
    const missing: Inventory = {};
    let any = false;
    for (const [item, n] of Object.entries(cost) as [ItemId, number][]) {
      const have = this.count(item);
      if (have < n) {
        missing[item] = n - have;
        any = true;
      }
    }
    return any ? missing : null;
  }

  canAfford(cost: Inventory): boolean {
    return this.missingFor(cost) === null;
  }

  /** Removes items from storage; returns false (and changes nothing) if not enough. */
  take(cost: Inventory): boolean {
    if (!this.canAfford(cost)) return false;
    for (const [item, n] of Object.entries(cost) as [ItemId, number][]) this.storage[item] = this.count(item) - n;
    return true;
  }

  give(items: Inventory): void {
    for (const [item, n] of Object.entries(items) as [ItemId, number][]) {
      if (n) this.storage[item] = this.count(item) + n;
    }
  }

  private giveOne(item: ItemId): void {
    this.storage[item] = this.count(item) + 1;
  }

  // ---------------------------------------------------------------- placement

  check(type: BuildingType, x: number, z: number, rot: Rot, opts: { free?: boolean; force?: boolean } = {}): PlaceCheck {
    const def = BUILDINGS[type];
    const cells = this.cellsFor(type, x, z, rot);
    if (!def.buildable && !opts.force) return { ok: false, error: 'notBuildable', cells };
    for (const [cx, cz] of cells) {
      if (!this.inBounds(cx, cz)) return { ok: false, error: 'outOfBounds', cells };
    }
    for (const [cx, cz] of cells) {
      if (this.grid[this.idx(cx, cz)]) return { ok: false, error: 'occupied', cells };
    }
    let resource: ResourceId | null = null;
    if (def.needsNode) {
      for (const [cx, cz] of cells) {
        resource = this.resourceAt(cx, cz);
        if (resource) break;
      }
      if (!resource) return { ok: false, error: 'needsNode', cells, resource: null };
    }
    if (!opts.free) {
      const missing = this.missingFor(def.cost);
      if (missing) return { ok: false, error: 'cost', cells, missing, resource };
    }
    return { ok: true, cells, resource };
  }

  place(
    type: BuildingType,
    x: number,
    z: number,
    rot: Rot,
    opts: { free?: boolean; force?: boolean } = {},
  ): { ok: true; building: Building } | { ok: false; check: PlaceCheck } {
    const check = this.check(type, x, z, rot, opts);
    if (!check.ok) return { ok: false, check };
    if (!opts.free) this.take(BUILDINGS[type].cost);
    const id = this.nextId++;
    const b = this.makeBuilding(type, id, x, z, rot, check.resource ?? null);
    if (opts.free) b.free = true;
    this.insert(b);
    this.events.emit('placed', b);
    return { ok: true, building: b };
  }

  private makeBuilding(type: BuildingType, id: number, x: number, z: number, rot: Rot, resource: ResourceId | null): Building {
    switch (type) {
      case 'conveyor':
        return { type, id, x, z, rot, items: [], lastFrom: -1 };
      case 'drill':
        return { type, id, x, z, rot, resource, progress: 0, outBuf: [] };
      case 'press':
      case 'assembler':
        return { type, id, x, z, rot, recipe: null, inBuf: {}, outBuf: [], progress: 0, status: 'noRecipe' };
      case 'hub':
        return { type, id, x, z, rot };
    }
  }

  private insert(b: Building): void {
    this.buildings.set(b.id, b);
    for (const [cx, cz] of this.cellsFor(b.type, b.x, b.z, b.rot)) this.grid[this.idx(cx, cz)] = b.id;
    this.topoDirty = true;
  }

  /** Dismantles a building, refunding its cost and any items it holds. */
  remove(id: number): boolean {
    const b = this.buildings.get(id);
    if (!b || !BUILDINGS[b.type].buildable) return false;
    for (const [cx, cz] of this.cellsFor(b.type, b.x, b.z, b.rot)) this.grid[this.idx(cx, cz)] = 0;
    this.buildings.delete(id);
    // Buildings placed for free (dev layouts) refund nothing for their cost.
    if (!b.free) this.give(BUILDINGS[b.type].cost);
    this.refundContents(b);
    this.topoDirty = true;
    this.events.emit('removed', b);
    return true;
  }

  private refundContents(b: Building): void {
    if (b.type === 'conveyor') for (const it of b.items) this.giveOne(it.item);
    if (b.type === 'drill') for (const it of b.outBuf) this.giveOne(it);
    if (b.type === 'press' || b.type === 'assembler') {
      this.give(b.inBuf);
      for (const it of b.outBuf) this.giveOne(it);
      const r = b.recipe ? RECIPES_BY_ID[b.recipe] : undefined;
      if (b.status === 'working' && r) {
        // Inputs of the interrupted craft go back to storage.
        for (const s of r.inputs) this.storage[s.item] = this.count(s.item) + s.count;
      }
    }
  }

  setRecipe(id: number, recipeId: string | null): boolean {
    const b = this.buildings.get(id);
    if (!b || (b.type !== 'press' && b.type !== 'assembler')) return false;
    if (recipeId !== null) {
      const r = RECIPES_BY_ID[recipeId];
      if (!r || r.machine !== b.type) return false;
    }
    if (b.recipe === recipeId) return true;
    this.refundContents(b);
    b.recipe = recipeId;
    b.inBuf = {};
    b.outBuf = [];
    b.progress = 0;
    b.status = recipeId ? 'idle' : 'noRecipe';
    return true;
  }

  // ---------------------------------------------------------------- topology

  /** Does `target` accept items entering cell (cx, cz) through world side `entry`? */
  private acceptsAt(target: Building, cx: number, cz: number, entry: Side): boolean {
    const def = BUILDINGS[target.type];
    if (def.acceptsAllEdges) {
      const nx = cx + DX[entry];
      const nz = cz + DZ[entry];
      return this.grid[this.idx(cx, cz)] === target.id && (!this.inBounds(nx, nz) || this.grid[this.idx(nx, nz)] !== target.id);
    }
    for (const p of def.ports) {
      if (p.dir !== 'in') continue;
      const w = this.portWorld(target, p.cell, p.side);
      if (w.cx === cx && w.cz === cz && w.side === entry) return true;
    }
    return false;
  }

  private rebuildTopology(): void {
    this.topoDirty = false;
    this.outLinks.clear();
    this.feeders.clear();
    const sorted = [...this.buildings.values()].sort((a, b) => a.id - b.id);
    for (const b of sorted) {
      const out = BUILDINGS[b.type].ports.find((p) => p.dir === 'out');
      let link: Link | null = null;
      if (out) {
        const w = this.portWorld(b, out.cell, out.side);
        const nx = w.cx + DX[w.side];
        const nz = w.cz + DZ[w.side];
        const t = this.at(nx, nz);
        const entry = opposite(w.side);
        if (t && t.id !== b.id && this.acceptsAt(t, nx, nz, entry)) {
          link = { target: t.id, cx: nx, cz: nz, entry };
          if (t.type === 'conveyor') {
            let list = this.feeders.get(t.id);
            if (!list) this.feeders.set(t.id, (list = []));
            list.push({ id: b.id, side: unrotateSide(entry, t.rot) });
          }
        }
      }
      this.outLinks.set(b.id, link);
    }

    // Conveyors downstream-first so that space frees up before upstream items move.
    const visited = new Set<number>();
    this.convOrder = [];
    for (const b of sorted) {
      if (b.type !== 'conveyor' || visited.has(b.id)) continue;
      const chain: ConveyorB[] = [];
      let cur: Building | undefined = b;
      while (cur && cur.type === 'conveyor' && !visited.has(cur.id)) {
        visited.add(cur.id);
        chain.push(cur);
        const l = this.outLinks.get(cur.id);
        cur = l ? this.buildings.get(l.target) : undefined;
      }
      for (let i = chain.length - 1; i >= 0; i--) this.convOrder.push(chain[i]!);
    }
    this.producers = sorted.filter((b): b is DrillB | MachineB => b.type === 'drill' || b.type === 'press' || b.type === 'assembler');
    this.events.emit('topology', undefined);
  }

  /** Ensures links are current (call before reading linkOf/feedersOf from views). */
  syncTopology(): void {
    if (this.topoDirty) this.rebuildTopology();
  }

  linkOf(id: number): Link | null {
    this.syncTopology();
    return this.outLinks.get(id) ?? null;
  }

  feedersOf(id: number): { id: number; side: Side }[] {
    this.syncTopology();
    return this.feeders.get(id) ?? [];
  }

  /** Visual shape of a conveyor, derived from the local sides of its feeders. */
  conveyorShape(id: number): ConveyorShape {
    const sides = new Set(this.feedersOf(id).map((f) => f.side));
    if (sides.size >= 2) return 'junction';
    if (sides.has(3)) return 'left';
    if (sides.has(1)) return 'right';
    return 'straight';
  }

  // ---------------------------------------------------------------- simulation

  tick(): void {
    if (this.topoDirty) this.rebuildTopology();
    this.tickCount++;

    for (const b of this.producers) {
      if (b.type === 'drill') this.stepDrill(b);
      else this.stepMachine(b);
    }
    for (const b of this.producers) {
      if (b.outBuf.length === 0) continue;
      const link = this.outLinks.get(b.id);
      if (link && this.tryInsert(link, b.outBuf[0]!, b.id, 0)) b.outBuf.shift();
    }
    for (const c of this.convOrder) this.stepConveyor(c);
    this.fresh.clear();
  }

  /** Runs n ticks (tests, offline catch-up). */
  run(n: number): void {
    for (let i = 0; i < n; i++) this.tick();
  }

  private stepDrill(d: DrillB): void {
    if (!d.resource || d.outBuf.length >= DRILL.OUT_CAP) return;
    d.progress++;
    if (d.progress >= DRILL.PERIOD) {
      d.progress = 0;
      const item = RESOURCES[d.resource].item;
      d.outBuf.push(item);
      this.crafted[item] = (this.crafted[item] ?? 0) + 1;
    }
  }

  private stepMachine(m: MachineB): void {
    const r = m.recipe ? RECIPES_BY_ID[m.recipe] : undefined;
    if (!r) {
      m.status = 'noRecipe';
      return;
    }
    if (m.status === 'working') {
      m.progress++;
      if (m.progress < r.ticks) return;
      for (const o of r.outputs) {
        for (let i = 0; i < o.count; i++) m.outBuf.push(o.item);
        this.crafted[o.item] = (this.crafted[o.item] ?? 0) + o.count;
      }
      m.progress = 0;
      m.status = 'idle';
    }
    const outCount = r.outputs.reduce((s, o) => s + o.count, 0);
    if (m.outBuf.length + outCount > MACHINE.OUT_CAP) {
      m.status = 'blocked';
      return;
    }
    for (const i of r.inputs) {
      if ((m.inBuf[i.item] ?? 0) < i.count) {
        m.status = 'idle';
        return;
      }
    }
    for (const i of r.inputs) m.inBuf[i.item] = (m.inBuf[i.item] ?? 0) - i.count;
    m.status = 'working';
    m.progress = 0;
  }

  private stepConveyor(c: ConveyorB): void {
    const items = c.items;
    let limit: number = BELT.SEG;
    let i = 0;
    while (i < items.length) {
      const it = items[i]!;
      if (this.fresh.has(it)) {
        // Entered this tick: keep its hand-off position, move from the next tick on.
        limit = it.pos - BELT.SPACING;
        i++;
        continue;
      }
      it.prev = it.pos;
      const np = Math.min(it.pos + BELT.SPEED, limit);
      if (np > it.pos) it.pos = np;
      if (i === 0 && it.pos >= BELT.SEG) {
        const link = this.outLinks.get(c.id);
        if (link && this.tryInsert(link, it.item, c.id, it.prev - BELT.SEG)) {
          items.shift();
          continue; // the next item becomes the front one; its limit is the tile end
        }
      }
      limit = it.pos - BELT.SPACING;
      i++;
    }
  }

  /** Is `feederId` about to push an item into its link target? */
  private isReady(feederId: number): boolean {
    const f = this.buildings.get(feederId);
    if (!f) return false;
    if (f.type === 'conveyor') return (f.items[0]?.pos ?? -1) >= BELT.SEG - BELT.SPEED;
    if (f.type === 'drill' || f.type === 'press' || f.type === 'assembler') return f.outBuf.length > 0;
    return false;
  }

  private tryInsert(link: Link, item: ItemId, fromId: number, prev: number): boolean {
    const t = this.buildings.get(link.target);
    if (!t) return false;
    switch (t.type) {
      case 'conveyor': {
        const from = unrotateSide(link.entry, t.rot);
        if (from === 0) return false;
        const last = t.items[t.items.length - 1];
        if (last && last.pos < BELT.SPACING) return false;
        // Round-robin merge: the side right after the last accepted one has priority.
        const mine = mergePriority(from, t.lastFrom);
        for (const f of this.feeders.get(t.id) ?? []) {
          if (f.id !== fromId && f.side !== from && mergePriority(f.side, t.lastFrom) < mine && this.isReady(f.id)) return false;
        }
        const entry: BeltItem = { item, pos: 0, prev, from };
        t.items.push(entry);
        this.fresh.add(entry);
        t.lastFrom = from;
        return true;
      }
      case 'press':
      case 'assembler': {
        const recipe = t.recipe ? RECIPES_BY_ID[t.recipe] : undefined;
        if (!recipe) return false;
        const need = recipe.inputs.find((s) => s.item === item);
        if (!need) return false;
        const cur = t.inBuf[item] ?? 0;
        if (cur >= need.count * MACHINE.IN_CAP_FACTOR) return false;
        t.inBuf[item] = cur + 1;
        return true;
      }
      case 'hub':
        this.giveOne(item);
        this.delivered[item] = (this.delivered[item] ?? 0) + 1;
        return true;
      case 'drill':
        return false;
    }
  }

  /** Craft progress 0..1 of a machine/drill (for animations). */
  progressOf(b: Building): number {
    if (b.type === 'drill') return b.progress / DRILL.PERIOD;
    if ((b.type === 'press' || b.type === 'assembler') && b.recipe && b.status === 'working') {
      const r = RECIPES_BY_ID[b.recipe];
      return r ? b.progress / r.ticks : 0;
    }
    return 0;
  }

  /** Number of items on all belts (perf/debug). */
  beltItemCount(): number {
    let n = 0;
    for (const b of this.buildings.values()) if (b.type === 'conveyor') n += b.items.length;
    return n;
  }

  // ---------------------------------------------------------------- persistence

  serialize(): FactorySave {
    const buildings = [...this.buildings.values()].sort((a, b) => a.id - b.id);
    return structuredCloneJSON({
      version: 1,
      tick: this.tickCount,
      nextId: this.nextId,
      storage: this.storage,
      delivered: this.delivered,
      crafted: this.crafted,
      buildings,
    });
  }

  static fromSave(save: FactorySave, opts: Omit<FactorySimOptions, 'hub' | 'storage'> = { nodes: FACTORY_MAP.nodes }): FactorySim {
    const sim = new FactorySim({ ...opts, hub: null });
    const data = structuredCloneJSON(save);
    sim.tickCount = data.tick;
    sim.nextId = data.nextId;
    sim.storage = data.storage ?? {};
    sim.delivered = data.delivered ?? {};
    sim.crafted = data.crafted ?? {};
    for (const b of data.buildings) {
      if (!BUILDINGS[b.type]) continue;
      const cells = sim.cellsFor(b.type, b.x, b.z, b.rot);
      if (cells.some(([cx, cz]) => !sim.inBounds(cx, cz) || sim.grid[sim.idx(cx, cz)])) continue;
      if (b.type === 'conveyor') b.items = b.items.filter((it) => isItemId(it.item));
      if (b.type === 'press' || b.type === 'assembler') {
        const r = b.recipe ? RECIPES_BY_ID[b.recipe] : undefined;
        if (b.recipe && (!r || r.machine !== b.type)) {
          // Recipe no longer exists (older save): give buffered items back and reset.
          for (const [item, n] of Object.entries(b.inBuf ?? {})) if (isItemId(item) && n) sim.give({ [item]: n });
          for (const item of b.outBuf ?? []) if (isItemId(item)) sim.give({ [item]: 1 });
          b.recipe = null;
          b.inBuf = {};
          b.outBuf = [];
          b.progress = 0;
          b.status = 'noRecipe';
        }
      }
      sim.insert(b);
    }
    return sim;
  }

  /** Stable hash of the full state (determinism tests). */
  hash(): string {
    const s = canonicalJSON(this.serialize());
    let h1 = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h1 ^= s.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193);
    }
    return (h1 >>> 0).toString(16);
  }
}

/** Cyclic merge order of a conveyor's input sides (back, right, left). */
const MERGE_ORDER = [2, 1, 3];
/** 0 = highest priority: the side just after the last accepted side in the cycle. */
function mergePriority(side: number, lastFrom: number): number {
  const i = MERGE_ORDER.indexOf(side);
  const l = MERGE_ORDER.indexOf(lastFrom);
  return l < 0 ? i : (i - l - 1 + 3) % 3;
}

/** JSON with object keys sorted (stable regardless of insertion order). */
export function canonicalJSON(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJSON(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function structuredCloneJSON<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export type { Building, ConveyorB, DrillB, MachineB, HubB };
