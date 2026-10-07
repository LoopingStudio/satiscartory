import { BELT, DRILL, MACHINE, NODE, START_STORAGE } from '../../data/balance';
import { BUILDINGS, isBelt, type BuildingType, type Side } from '../../data/buildings';
import { FACTORY_MAP, LEGACY_MAP_OFFSET, RESOURCES, type ResourceId, type ResourceNode } from '../../data/factoryMap';
import { FACTORY_GRID_H, FACTORY_GRID_W } from '../../config/constants';
import { isItemId, type Inventory, type ItemId } from '../../data/items';
import { RECIPES_BY_ID } from '../../data/recipes';
import { Emitter } from '../../core/events';
import { FACTORY_TERRAIN_DEFAULT, type TerrainId } from '../../data/factoryTerrain';
import { Terrain } from './terrain';
import { DX, DZ, opposite, rotateCell, rotateSide, rotatedSize, unrotateSide, type Rot } from './dirs';
import { isMachine, isNode, isProducer, type NodeB, type BeltItem, type Building, type ConveyorB, type DrillB, type FactorySave, type GarageB, type HubB, type ItemSink, type ItemSource, type Link, type MachineB, type PlaceCheck, type Placement, type PlanLinks, type PortInfo } from './types';

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
  /** Relief of the map (default: flat, like every unit test). */
  terrain?: TerrainId | Terrain;
}

export type ConveyorShape = 'straight' | 'left' | 'right' | 'junction';

/** A building, existing or planned (planned ones have negative ids), as seen by link finding. */
type Occupant = Placement & { id: number };
/** Who stands on a cell (undefined: empty or out of bounds). */
type OccupantAt = (x: number, z: number) => Occupant | undefined;

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
  /** Relief: natural ground and the ground as the padded buildings left it. */
  readonly terrain: Terrain;
  readonly buildings = new Map<number, Building>();
  storage: Inventory;
  /** Items received by the hub since the start (objectives/stats). */
  delivered: Inventory = {};
  /** Items produced by drills and machines since the start. */
  crafted: Inventory = {};
  tickCount = 0;
  nextId = 1;
  /** Bumped each time links are rebuilt (caches keyed on the topology). */
  topologyVersion = 0;
  readonly events = new Emitter<SimEvents>();

  private outLinks = new Map<number, Link | null>();
  private feeders = new Map<number, { id: number; side: Side }[]>();
  /** Per target building: the links that feed it (any building type). */
  private inbound = new Map<number, { id: number; link: Link }[]>();
  /** Splitters: the link of each output port (null where nothing takes items), in port order. */
  private multiLinks = new Map<number, (Link | null)[]>();
  private logistics: NodeB[] = [];
  private readonly occupantAt: OccupantAt = (x, z) => this.at(x, z);
  private convOrder: ConveyorB[] = [];
  private producers: (DrillB | MachineB)[] = [];
  private topoDirty = true;
  /** Transient (within one tick): items inserted onto belts that must not move until the next tick. */
  private fresh = new Set<BeltItem>();

  constructor(opts: FactorySimOptions = {}) {
    this.width = opts.width ?? FACTORY_GRID_W;
    this.height = opts.height ?? FACTORY_GRID_H;
    this.grid = new Int32Array(this.width * this.height);
    this.nodeGrid = new Int8Array(this.width * this.height);
    this.nodes = opts.nodes ?? [];
    for (const n of this.nodes) {
      const idx = RESOURCE_IDS.indexOf(n.resource) + 1;
      for (let x = n.x; x < n.x + n.w; x++) for (let z = n.z; z < n.z + n.h; z++) if (this.inBounds(x, z)) this.nodeGrid[this.idx(x, z)] = idx;
    }
    const t = opts.terrain ?? 'flat';
    this.terrain = t instanceof Terrain ? t : Terrain.create(t, this.width, this.height, this.nodes);
    this.storage = { ...(opts.storage ?? {}) };
    if (opts.hub) this.place('hub', opts.hub.x, opts.hub.z, opts.hub.rot, { free: true, force: true });
  }

  /** New game with the default map, hub and starting stock (and the default relief, unless given). */
  static newGame(opts: { terrain?: TerrainId } = {}): FactorySim {
    return new FactorySim({
      nodes: FACTORY_MAP.nodes,
      storage: START_STORAGE,
      hub: FACTORY_MAP.hub,
      terrain: opts.terrain ?? FACTORY_TERRAIN_DEFAULT,
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

  /** The hub storage as an item source/sink (unlimited capacity). */
  readonly hub: ItemSource & ItemSink = {
    count: (item) => this.count(item),
    remove: (item, n) => {
      const k = Math.max(0, Math.min(n, this.count(item)));
      if (k) this.storage[item] = this.count(item) - k;
      return k;
    },
    add: (item, n) => {
      if (n > 0) this.storage[item] = this.count(item) + n;
      return Math.max(0, n);
    },
  };

  /** Gives items to `sink` first; whatever it refuses goes to the hub. */
  private refund(item: ItemId, n: number, sink?: ItemSink): void {
    if (n <= 0) return;
    const accepted = sink ? sink.add(item, n) : 0;
    if (accepted < n) this.storage[item] = this.count(item) + (n - accepted);
  }

  private missingIn(source: ItemSource, cost: Inventory): Inventory | null {
    const missing: Inventory = {};
    let any = false;
    for (const [item, n] of Object.entries(cost) as [ItemId, number][]) {
      const have = source.count(item);
      if (have < n) {
        missing[item] = n - have;
        any = true;
      }
    }
    return any ? missing : null;
  }

  /**
   * Picking items off belts by hand: takes the items of the given conveyors into `sink`, front item first,
   * tile after tile; what the sink refuses (full backpack) stays where it is on the belt. Returns what was
   * taken. Items behind a taken one only get more room, so the belt keeps its spacing.
   */
  takeFromBelts(ids: readonly number[], sink: ItemSink): Inventory {
    const taken: Inventory = {};
    const take = (item: ItemId) => {
      if (sink.add(item, 1) !== 1) return false;
      taken[item] = (taken[item] ?? 0) + 1;
      return true;
    };
    for (const id of ids) {
      const b = this.buildings.get(id);
      if (b?.type === 'conveyor') b.items = b.items.filter((it) => !take(it.item));
      else if (isNode(b)) {
        b.out = b.out.map((it) => (it && take(it) ? null : it));
        b.buf = b.buf.filter((it) => !take(it));
      }
    }
    return taken;
  }

  /** Items lying on a belt piece (conveyor, splitter, merger). */
  itemsOn(id: number): number {
    const b = this.buildings.get(id);
    if (b?.type === 'conveyor') return b.items.length;
    return isNode(b) ? b.buf.length + b.out.filter((it) => it).length : 0;
  }

  /**
   * Belt pieces (conveyors, splitters, mergers) connected to `id` without a machine in between, downstream
   * (its outputs) and upstream (what feeds it, through merges), in id order. Machines and the hub end it.
   * [] if `id` is not a belt piece.
   */
  beltLine(id: number): number[] {
    const start = this.buildings.get(id);
    if (!start || !isBelt(start.type)) return [];
    this.syncTopology();
    const seen = new Set<number>([id]);
    const todo = [id];
    while (todo.length) {
      const cur = todo.pop()!;
      const outs = this.multiLinks.get(cur) ?? [this.outLinks.get(cur) ?? null];
      const next = [...outs.map((l) => l?.target), ...(this.inbound.get(cur) ?? []).map((f) => f.id)];
      for (const n of next) {
        if (n === undefined || seen.has(n)) continue;
        const b = this.buildings.get(n);
        if (!b || !isBelt(b.type)) continue;
        seen.add(n);
        todo.push(n);
      }
    }
    return [...seen].sort((a, b) => a - b);
  }

  /**
   * Hand mining: one item of the resource under a free cell (not covered by a building) into `sink`.
   * Returns the item, or null if there is nothing to mine or the sink is full.
   */
  mineAt(x: number, z: number, sink: ItemSink): ItemId | null {
    const res = this.resourceAt(x, z);
    if (!res || this.grid[this.idx(x, z)]) return null;
    const item = RESOURCES[res].item;
    return sink.add(item, 1) === 1 ? item : null;
  }

  // ---------------------------------------------------------------- placement

  /**
   * @param opts.wallet where the cost is paid from (default: the hub storage).
   */
  check(type: BuildingType, x: number, z: number, rot: Rot, opts: { free?: boolean; force?: boolean; wallet?: ItemSource } = {}): PlaceCheck {
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
      const missing = this.missingIn(opts.wallet ?? this.hub, def.cost);
      if (missing) return { ok: false, error: 'cost', cells, missing, resource };
    }
    return { ok: true, cells, resource };
  }

  place(
    type: BuildingType,
    x: number,
    z: number,
    rot: Rot,
    opts: { free?: boolean; force?: boolean; wallet?: ItemSource } = {},
  ): { ok: true; building: Building } | { ok: false; check: PlaceCheck } {
    const check = this.check(type, x, z, rot, opts);
    if (!check.ok) return { ok: false, check };
    if (!opts.free) {
      const wallet = opts.wallet ?? this.hub;
      for (const [item, n] of Object.entries(BUILDINGS[type].cost) as [ItemId, number][]) wallet.remove(item, n);
    }
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
      case 'splitter':
      case 'merger':
        return { type, id, x, z, rot, buf: [], out: this.outSlots(type), lastOut: -1, lastFrom: -1 };
      case 'drill':
        return { type, id, x, z, rot, resource, progress: 0, outBuf: [] };
      case 'smelter':
      case 'press':
      case 'assembler':
        return { type, id, x, z, rot, recipe: null, inBuf: {}, outBuf: [], progress: 0, status: 'noRecipe' };
      case 'garage':
      case 'hub':
        return { type, id, x, z, rot };
    }
  }

  /** Empty output slots of a splitter (one per output port); none for a merger. */
  private outSlots(type: 'splitter' | 'merger'): null[] {
    return type === 'splitter' ? BUILDINGS.splitter.ports.filter((p) => p.dir === 'out').map(() => null) : [];
  }

  private insert(b: Building): void {
    this.buildings.set(b.id, b);
    for (const [cx, cz] of this.cellsFor(b.type, b.x, b.z, b.rot)) this.grid[this.idx(cx, cz)] = b.id;
    this.topoDirty = true;
  }

  /** Dismantles a building, refunding its cost and any items it holds (to `sink` first, overflow to the hub). */
  remove(id: number, sink?: ItemSink): boolean {
    const b = this.buildings.get(id);
    if (!b || !BUILDINGS[b.type].buildable) return false;
    for (const [cx, cz] of this.cellsFor(b.type, b.x, b.z, b.rot)) this.grid[this.idx(cx, cz)] = 0;
    this.buildings.delete(id);
    // Buildings placed for free (dev layouts) refund nothing for their cost.
    if (!b.free) for (const [item, n] of Object.entries(BUILDINGS[b.type].cost) as [ItemId, number][]) this.refund(item, n, sink);
    this.refundContents(b, sink);
    this.topoDirty = true;
    this.events.emit('removed', b);
    return true;
  }

  private refundContents(b: Building, sink?: ItemSink): void {
    if (b.type === 'conveyor') for (const it of b.items) this.refund(it.item, 1, sink);
    if (isNode(b)) for (const it of [...b.buf, ...b.out]) if (it) this.refund(it, 1, sink);
    if (b.type === 'drill') for (const it of b.outBuf) this.refund(it, 1, sink);
    if (isMachine(b)) {
      for (const [item, n] of Object.entries(b.inBuf) as [ItemId, number][]) this.refund(item, n, sink);
      for (const it of b.outBuf) this.refund(it, 1, sink);
      const r = b.recipe ? RECIPES_BY_ID[b.recipe] : undefined;
      if (b.status === 'working' && r) {
        // Inputs of the interrupted craft are given back too.
        for (const st of r.inputs) this.refund(st.item, st.count, sink);
      }
    }
  }

  setRecipe(id: number, recipeId: string | null, sink?: ItemSink): boolean {
    const b = this.buildings.get(id);
    if (!isMachine(b)) return false;
    if (recipeId !== null) {
      const r = RECIPES_BY_ID[recipeId];
      if (!r || r.machine !== b.type) return false;
    }
    if (b.recipe === recipeId) return true;
    this.refundContents(b, sink);
    b.recipe = recipeId;
    b.inBuf = {};
    b.outBuf = [];
    b.progress = 0;
    b.status = recipeId ? 'idle' : 'noRecipe';
    return true;
  }

  /**
   * Manual feeding (like inserting items by hand in Satisfactory): moves the
   * current recipe's inputs from storage into the machine, up to its buffer cap.
   * Returns the number of items moved.
   */
  loadFromStorage(id: number): number {
    return this.loadFrom(id, this.hub);
  }

  /** Manual feeding from any source (backpack, hub, or both through a wallet). */
  loadFrom(id: number, source: ItemSource): number {
    const m = this.buildings.get(id);
    if (!isMachine(m)) return 0;
    const r = m.recipe ? RECIPES_BY_ID[m.recipe] : undefined;
    if (!r) return 0;
    let moved = 0;
    for (const s of r.inputs) {
      const cap = s.count * MACHINE.MANUAL_CAP_FACTOR;
      const want = Math.min(cap - (m.inBuf[s.item] ?? 0), source.count(s.item));
      if (want <= 0) continue;
      const n = source.remove(s.item, want);
      m.inBuf[s.item] = (m.inBuf[s.item] ?? 0) + n;
      moved += n;
    }
    return moved;
  }

  /**
   * Manual pickup: moves what waits in a producer's output buffer into `sink`
   * (default: the hub). Items the sink refuses (full backpack) stay in the machine.
   */
  collectOutput(id: number, sink: ItemSink = this.hub): number {
    const b = this.buildings.get(id);
    if (!isProducer(b)) return 0;
    const kept: ItemId[] = [];
    let moved = 0;
    for (const it of b.outBuf) {
      if (sink.add(it, 1) === 1) moved++;
      else kept.push(it);
    }
    b.outBuf = kept;
    return moved;
  }

  // ---------------------------------------------------------------- topology

  /** Does `target` accept items entering cell (cx, cz) through world side `entry`? */
  private acceptsAt(target: Occupant, cx: number, cz: number, entry: Side, at: OccupantAt): boolean {
    const def = BUILDINGS[target.type];
    if (def.acceptsAllEdges) return at(cx, cz)?.id === target.id && at(cx + DX[entry], cz + DZ[entry])?.id !== target.id;
    for (const p of def.ports) {
      if (p.dir !== 'in') continue;
      const w = this.portWorld(target, p.cell, p.side);
      if (w.cx === cx && w.cz === cz && w.side === entry) return true;
    }
    return false;
  }

  /** Output link of `b` among the occupants given by `at`: its output ports in order, the first one that links wins. */
  private findLink(b: Occupant, at: OccupantAt): Link | null {
    return this.findLinks(b, at, true).find((l) => l) ?? null;
  }

  /** The link of each output port of `b`, in port order (null where nothing takes items); `first` stops at the first link. */
  private findLinks(b: Occupant, at: OccupantAt, first = false): (Link | null)[] {
    const links: (Link | null)[] = [];
    for (const out of BUILDINGS[b.type].ports) {
      if (out.dir !== 'out') continue;
      const w = this.portWorld(b, out.cell, out.side);
      const nx = w.cx + DX[w.side];
      const nz = w.cz + DZ[w.side];
      const t = at(nx, nz);
      const entry = opposite(w.side);
      const link = t && t.id !== b.id && this.acceptsAt(t, nx, nz, entry, at) ? { target: t.id, cx: nx, cz: nz, entry } : null;
      links.push(link);
      if (link && first) break;
    }
    return links;
  }

  /** Every output link a building makes: all of a splitter's, the first one of anything else. */
  private outputLinks(b: Occupant, at: OccupantAt): (Link | null)[] {
    return BUILDINGS[b.type].multiOut ? this.findLinks(b, at) : [this.findLink(b, at)];
  }

  private rebuildTopology(): void {
    this.topoDirty = false;
    this.topologyVersion++;
    this.outLinks.clear();
    this.feeders.clear();
    this.inbound.clear();
    this.multiLinks.clear();
    const sorted = [...this.buildings.values()].sort((a, b) => a.id - b.id);
    for (const b of sorted) {
      const links = this.outputLinks(b, this.occupantAt);
      for (const link of links) {
        if (!link) continue;
        const t = this.buildings.get(link.target)!;
        // Round-robin merging (conveyors, mergers) looks at the feeders by local side.
        if (t.type === 'conveyor' || t.type === 'merger') {
          let list = this.feeders.get(t.id);
          if (!list) this.feeders.set(t.id, (list = []));
          list.push({ id: b.id, side: unrotateSide(link.entry, t.rot) });
        }
        let ins = this.inbound.get(t.id);
        if (!ins) this.inbound.set(t.id, (ins = []));
        ins.push({ id: b.id, link });
      }
      this.outLinks.set(b.id, links.find((l) => l) ?? null);
      if (BUILDINGS[b.type].multiOut) this.multiLinks.set(b.id, links);
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
    this.producers = sorted.filter(isProducer);
    this.logistics = sorted.filter(isNode);
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

  /**
   * Ports of a building with their state, for markers and panels. A hub (it accepts on every edge) and a
   * garage have none listed.
   */
  portsOf(id: number): PortInfo[] {
    this.syncTopology();
    const b = this.buildings.get(id);
    if (!b) return [];
    const link = this.outLinks.get(id) ?? null;
    const multi = this.multiLinks.get(id);
    const ins = this.inbound.get(id) ?? [];
    return BUILDINGS[b.type].ports.map((p) => {
      const w = this.portWorld(b, p.cell, p.side);
      const nx = w.cx + DX[w.side];
      const nz = w.cz + DZ[w.side];
      const own = (l: Link | null) => !!l && l.cx === nx && l.cz === nz && l.entry === opposite(w.side);
      const linked =
        p.dir === 'out'
          ? multi ? multi.some(own) : own(link)
          : ins.some((f) => f.link.cx === w.cx && f.link.cz === w.cz && f.link.entry === w.side);
      const neighbor = this.at(nx, nz);
      // A building outputs through one port only (the first that links): with an output linked, its other
      // outputs are unused even with nothing in front (a belt there would get nothing, or steal the output).
      // A splitter uses them all.
      const state = linked ? 'linked' : !this.inBounds(nx, nz) || neighbor ? 'blocked' : p.dir === 'out' && link && !multi ? 'unused' : 'free';
      return { cx: w.cx, cz: w.cz, side: w.side, dir: p.dir, state, neighbor: neighbor?.id ?? null };
    });
  }

  /** Buildings feeding `id` (any type), in id order. */
  inboundOf(id: number): { id: number; link: Link }[] {
    this.syncTopology();
    return this.inbound.get(id) ?? [];
  }

  /**
   * A conveyor whose front runs into a building that refuses its items (a machine's wall or output,
   * a belt coming head-on…): items pile up at its end forever. A front onto empty ground is not one.
   */
  isDeadEnd(id: number): boolean {
    const c = this.buildings.get(id);
    if (!c || c.type !== 'conveyor' || this.linkOf(id)) return false;
    return !!this.at(c.x + DX[c.rot], c.z + DZ[c.rot]);
  }

  /**
   * Links that planned buildings would make, without placing them (build ghosts). Planned buildings get
   * the ids -1, -2… in order; their cells are assumed free (check() ok) and they see each other. The
   * result mirrors the topology placing them all would give: per planned building, its output link and
   * the buildings (existing or planned) that would feed it.
   */
  planLinks(plan: Placement[]): PlanLinks[] {
    this.syncTopology();
    const planned: Occupant[] = plan.map((p, i) => ({ type: p.type, x: p.x, z: p.z, rot: p.rot, id: -1 - i }));
    const cells = new Map<number, Occupant>();
    for (const p of planned) for (const [cx, cz] of this.cellsFor(p.type, p.x, p.z, p.rot)) if (this.inBounds(cx, cz)) cells.set(this.idx(cx, cz), p);
    const at: OccupantAt = (x, z) => (this.inBounds(x, z) ? (cells.get(this.idx(x, z)) ?? this.at(x, z)) : undefined);
    const res: PlanLinks[] = planned.map(() => ({ out: null, outs: [], in: [] }));
    const feed = (from: Occupant) => {
      const links = this.outputLinks(from, at).filter((l): l is Link => !!l);
      for (const l of links) if (l.target < 0) res[-1 - l.target]!.in.push({ id: from.id, link: l });
      return links;
    };
    // Existing neighbors of planned cells may link into them (in id order, as the topology would).
    const neighbors = new Map<number, Building>();
    for (const p of planned) {
      const outs = feed(p);
      res[-1 - p.id]!.outs = outs;
      res[-1 - p.id]!.out = outs[0] ?? null;
      for (const [cx, cz] of this.cellsFor(p.type, p.x, p.z, p.rot)) {
        for (let s = 0; s < 4; s++) {
          const n = this.at(cx + DX[s], cz + DZ[s]);
          if (n) neighbors.set(n.id, n);
        }
      }
    }
    for (const n of [...neighbors.values()].sort((a, b) => a.id - b.id)) feed(n);
    return res;
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
    // After the belts: an output belt has already moved this tick, so a node keeps up with a full line.
    for (const n of this.logistics) this.stepNode(n);
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

  /**
   * Passes items on, one per tick and per output (more than a belt carries). A merger pushes its front item.
   * A splitter hands its front item to the next linked output (from the one after the last served) whose
   * slot is free, then every slot pushes into its target: an output whose target is busy keeps its item
   * waiting there (it counts as ready for that target's merge turns) while the others go on.
   */
  private stepNode(n: NodeB): void {
    if (n.type === 'merger') {
      const item = n.buf[0];
      const link = this.outLinks.get(n.id);
      if (item !== undefined && link && this.tryInsert(link, item, n.id, 0)) n.buf.shift();
      return;
    }
    const links = this.multiLinks.get(n.id) ?? [];
    const item = n.buf[0];
    if (item !== undefined) {
      for (let k = 1; k <= links.length; k++) {
        const i = (n.lastOut + k + links.length) % links.length;
        if (links[i] && !n.out[i]) {
          n.out[i] = n.buf.shift()!;
          n.lastOut = i;
          break;
        }
      }
    }
    n.out.forEach((it, i) => {
      const link = links[i];
      if (it && link && this.tryInsert(link, it, n.id, 0)) n.out[i] = null;
    });
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

  /** Is `feederId` about to push an item into `targetId`? (merge turns) */
  private isReady(feederId: number, targetId: number): boolean {
    const f = this.buildings.get(feederId);
    if (!f) return false;
    if (f.type === 'conveyor') return (f.items[0]?.pos ?? -1) >= BELT.SEG - BELT.SPEED;
    if (f.type === 'splitter') {
      // The slot of the output that feeds this target.
      const links = this.multiLinks.get(f.id) ?? [];
      return f.out.some((it, i) => !!it && links[i]?.target === targetId);
    }
    if (isNode(f)) return f.buf.length > 0;
    if (isProducer(f)) return f.outBuf.length > 0;
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
          if (f.id !== fromId && f.side !== from && mergePriority(f.side, t.lastFrom) < mine && this.isReady(f.id, t.id)) return false;
        }
        const entry: BeltItem = { item, pos: 0, prev, from };
        t.items.push(entry);
        this.fresh.add(entry);
        t.lastFrom = from;
        return true;
      }
      case 'smelter':
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
      case 'splitter':
      case 'merger': {
        if (t.buf.length >= NODE.CAP) return false;
        const from = unrotateSide(link.entry, t.rot);
        if (t.type === 'merger') {
          // Round-robin like a conveyor merge: an input whose turn comes first and that is ready goes first.
          const mine = mergePriority(from, t.lastFrom);
          for (const f of this.feeders.get(t.id) ?? []) {
            if (f.id !== fromId && f.side !== from && mergePriority(f.side, t.lastFrom) < mine && this.isReady(f.id, t.id)) return false;
          }
        }
        t.buf.push(item);
        t.lastFrom = from;
        return true;
      }
      case 'hub':
        this.giveOne(item);
        this.delivered[item] = (this.delivered[item] ?? 0) + 1;
        return true;
      case 'drill':
      case 'garage':
        return false;
    }
  }

  /** Craft progress 0..1 of a machine/drill (for animations). */
  progressOf(b: Building): number {
    if (b.type === 'drill') return b.progress / DRILL.PERIOD;
    if (isMachine(b) && b.recipe && b.status === 'working') {
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
      version: 3,
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
      // v1 machines were 1×2 with items flowing along their length; v2 machines are 2×1
      // with items crossing them. A quarter turn keeps exactly the same cells.
      const version = data.version ?? 1;
      if (version < 2 && (b.type === 'drill' || b.type === 'press' || b.type === 'assembler')) b.rot = ((b.rot + 1) & 3) as Rot;
      // v3: the map grew from 64×64 to 128×128 around a centered hub.
      if (version < 3) {
        b.x += LEGACY_MAP_OFFSET;
        b.z += LEGACY_MAP_OFFSET;
      }
      const cells = sim.cellsFor(b.type, b.x, b.z, b.rot);
      if (cells.some(([cx, cz]) => !sim.inBounds(cx, cz) || sim.grid[sim.idx(cx, cz)])) continue;
      if (b.type === 'conveyor') b.items = b.items.filter((it) => isItemId(it.item));
      if (isNode(b)) {
        b.buf = (b.buf ?? []).filter((it) => isItemId(it));
        const slots = sim.outSlots(b.type);
        b.out = slots.map((_, i) => (isItemId(b.out?.[i]) ? b.out[i]! : null));
        if (!Number.isInteger(b.lastOut)) b.lastOut = -1;
        if (!Number.isInteger(b.lastFrom)) b.lastFrom = -1;
      }
      if (isMachine(b)) {
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
        } else if (r) {
          // Same recipe id, different inputs (rebalance): stale items go back to the hub.
          for (const [item, n] of Object.entries(b.inBuf ?? {}) as [string, number][]) {
            if (r.inputs.some((s) => s.item === item)) continue;
            if (isItemId(item) && n > 0) sim.give({ [item]: n });
            delete (b.inBuf as Record<string, number>)[item];
          }
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

export type { Building, ConveyorB, DrillB, MachineB, GarageB, HubB };
