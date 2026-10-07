import { PhysicsWorld, RAPIER } from '../core/physics/PhysicsWorld';
import { FACTORY_CELL, GRAVITY_FACTORY } from '../config/constants';
import { BUILDINGS, isBelt } from '../data/buildings';
import { CONVEYOR_GROUPS } from './collisionGroups';
import { PLAYER } from '../data/player';
import { rotatedSize } from './sim/dirs';
import { HUB_BENCH } from './view/hubBench';
import { GARAGE_CLUTTER, GARAGE_LINTEL, GARAGE_WALLS, rotateBox } from './view/garageLayout';
import { rotateLocal } from './view/beltPath';
import type { FactorySim, TerrainRect } from './sim/FactorySim';
import { deckY, type DeckPlane, type Terrain } from './sim/terrain';
import { decorLayoutCached, isCleared, type DecorLayout } from './sim/decor';
import { FACTORY_MAP } from '../data/factoryMap';
import { TERRAINS } from '../data/factoryTerrain';
import type { Building } from './sim/types';

/** Collider heights per building type (meters). Conveyors are low enough to step onto. */
const HEIGHTS = { conveyor: 0.8, splitter: 0.8, merger: 0.8, drill: 3.6, smelter: 2.1, press: 2.1, assembler: 2.1 } as const;
/** On the relief, padded buildings' colliders reach this far under their pad (no gap over a lower neighbor's step). */
const PAD_DEPTH = 1;

/**
 * Rapier world of the factory: the ground (a flat slab, or the relief's heightfield) + one static
 * collider set per building, kept in sync with the sim.
 */
export class FactoryWorld {
  readonly physics = new PhysicsWorld(GRAVITY_FACTORY);
  private colliders = new Map<number, RAPIER.Collider[]>();
  private byHandle = new Map<number, number>();
  readonly ground: RAPIER.Collider;
  readonly terrain: Terrain;
  /** Heights of the heightfield, column-major (refilled where the relief changes). */
  private heights: Float32Array | null = null;
  /** Lattice corners changed since the last flush (union of the sim's 'terrain' rectangles). */
  private dirty: TerrainRect | null = null;
  /** Belt decks have to be checked again (links changed: a conveyor's shape, so its deck, may change). */
  private beltsStale = false;
  /** Deck each belt piece's collider was built on. */
  private beltDecks = new Map<number, DeckPlane>();
  /**
   * Belt pieces placed on the relief whose collider waits for the next flush: their deck depends on the
   * links, rebuilt once there rather than once per tile of a drag.
   */
  private readonly pendingBelts = new Set<number>();
  private readonly deck: DeckPlane = { c: 0, sx: 0, sz: 0 };
  /** Relief map: the scenery (trunks and big rocks are solid) and their colliders by item. */
  private decor: DecorLayout | null = null;
  private readonly decorColliders = new Map<number, RAPIER.Collider>();
  private readonly decorHandles = new Set<number>();
  /** Decor colliders to re-enable once nothing stands in them (a building was dismantled over the player). */
  private readonly decorPending = new Set<number>();
  /** The last flush rebuilt something (ground, belts): things standing there may need lifting. */
  rebuilt = false;
  /** Does this collider overlap the player? Set by the factory (never re-enable a trunk inside the player). */
  overlapsPlayer: ((c: RAPIER.Collider) => boolean) | null = null;
  private unsub: (() => void)[] = [];

  constructor(private readonly sim: FactorySim) {
    const w = sim.width * FACTORY_CELL;
    const h = sim.height * FACTORY_CELL;
    this.terrain = sim.terrain;
    if (sim.terrain.flat) {
      this.ground = this.physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(w * 2, 0.5, h * 2).setTranslation(w / 2, -0.5, h / 2).setFriction(1),
      );
    } else {
      // Created before any building collider and before the mode's first step, so the first aim ray sees it.
      const t = sim.terrain;
      this.heights = new Float32Array(t.nx * t.nz);
      this.fillHeights(0, 0, t.nx - 1, t.nz - 1);
      this.ground = this.physics.addHeightfield(t.nz - 1, t.nx - 1, this.heights, { x: (t.nx - 1) * FACTORY_CELL, z: (t.nz - 1) * FACTORY_CELL }, { x: w / 2, y: 0, z: h / 2 });
      this.ground.setFriction(1);
    }
    for (const b of sim.buildings.values()) this.add(b);
    // Belt pieces of a loaded factory: their colliders now (one topology pass), for the first queries.
    if (this.pendingBelts.size) {
      sim.syncTopology();
      for (const id of this.pendingBelts) this.add(sim.buildings.get(id)!, true);
      this.pendingBelts.clear();
    }
    if (sim.terrain.generated && sim.terrain.id in TERRAINS) {
      const spawn = { x: FACTORY_MAP.spawn.x * FACTORY_CELL, z: FACTORY_MAP.spawn.z * FACTORY_CELL };
      this.decor = decorLayoutCached(sim.terrain, sim.nodes, spawn, TERRAINS[sim.terrain.id as keyof typeof TERRAINS].plateau);
      this.decor.items.forEach((it, i) => {
        if (!it.solid) return;
        const y = sim.terrain.heightAt(it.x, it.z);
        const desc = it.kind === 'rock'
          ? RAPIER.ColliderDesc.ball(0.75 * it.scale).setTranslation(it.x, y + 0.15 * it.scale, it.z)
          : RAPIER.ColliderDesc.cylinder(1.5, (it.kind === 'oak' ? 0.35 : it.kind === 'pine' ? 0.28 : 0.2) * it.scale).setTranslation(it.x, y + 1.5, it.z);
        const c = this.physics.world.createCollider(desc.setFriction(0.8));
        c.setEnabled(!isCleared(this.decor!, i, sim.grid));
        this.decorColliders.set(i, c);
        this.decorHandles.add(c.handle);
      });
    }
    this.unsub.push(
      sim.events.on('placed', (b) => {
        this.add(b);
        this.refreshDecor(b);
      }),
      sim.events.on('removed', (b) => {
        this.remove(b.id);
        this.refreshDecor(b);
      }),
      sim.events.on('terrain', (r) => {
        const d = this.dirty;
        this.dirty = d ? { i0: Math.min(d.i0, r.i0), j0: Math.min(d.j0, r.j0), i1: Math.max(d.i1, r.i1), j1: Math.max(d.j1, r.j1) } : { ...r };
      }),
      sim.events.on('topology', () => (this.beltsStale = true)),
    );
  }

  /**
   * Brings the physics up to date with the relief (call before stepping or casting): the heightfield where
   * pads changed the ground, and the colliders of the belts whose deck moved. Returns the changed area in
   * meters [x0, z0, x1, z1] (things standing there may now be under the ground), or null.
   */
  flush(): [number, number, number, number] | null {
    this.rebuilt = false;
    if (this.terrain.flat) return null;
    const t = this.terrain;
    let area: [number, number, number, number] | null = null;
    const d = this.dirty;
    if (d) {
      this.dirty = null;
      const M = t.margin;
      this.fillHeights(Math.max(0, d.i0 + M), Math.max(0, d.j0 + M), Math.min(t.nx - 1, d.i1 + M), Math.min(t.nz - 1, d.j1 + M));
      // One shape swap per flush; the collider (and its handle) stays.
      this.ground.setShape(new RAPIER.Heightfield(t.nz - 1, t.nx - 1, this.heights!, { x: (t.nx - 1) * FACTORY_CELL, y: 1, z: (t.nz - 1) * FACTORY_CELL }));
      area = [d.i0 * FACTORY_CELL, d.j0 * FACTORY_CELL, d.i1 * FACTORY_CELL, d.j1 * FACTORY_CELL];
      this.rebuilt = true;
    }
    // Decor back where nothing stands any more (not inside the player), and on the changed ground.
    for (const i of [...this.decorPending]) {
      const c = this.decorColliders.get(i)!;
      if (this.overlapsPlayer?.(c)) continue;
      c.setEnabled(true);
      this.decorPending.delete(i);
    }
    if (d && this.decor) {
      const [x0, z0, x1, z1] = [d.i0 * FACTORY_CELL, d.j0 * FACTORY_CELL, d.i1 * FACTORY_CELL, d.j1 * FACTORY_CELL];
      for (const [i, c] of this.decorColliders) {
        const it = this.decor.items[i]!;
        if (it.x < x0 - 1 || it.x > x1 + 1 || it.z < z0 - 1 || it.z > z1 + 1) continue;
        const y = this.terrain.heightAt(it.x, it.z);
        c.setTranslation({ x: it.x, y: y + (it.kind === 'rock' ? 0.15 * it.scale : 1.5), z: it.z });
      }
    }
    if (d || this.beltsStale || this.pendingBelts.size) {
      this.sim.syncTopology();
      for (const id of this.pendingBelts) {
        const b = this.sim.buildings.get(id);
        if (b) this.add(b, true);
        this.rebuilt = true;
      }
      this.pendingBelts.clear();
      // Links changed: any belt's shape may have; otherwise only the belts on the changed corners.
      const all = this.beltsStale;
      this.beltsStale = false;
      for (const b of all || d ? this.sim.buildings.values() : []) {
        if (!isBelt(b.type)) continue;
        if (!all && d && (b.x + 1 < d.i0 || b.x > d.i1 || b.z + 1 < d.j0 || b.z > d.j1)) continue;
        const was = this.beltDecks.get(b.id);
        const now = this.sim.deckOf(b, this.deck);
        if (was && was.c === now.c && was.sx === now.sx && was.sz === now.sz) continue;
        this.remove(b.id);
        this.add(b, true);
        this.rebuilt = true;
      }
    }
    return area;
  }

  /** A tree trunk or a big rock (the cameras look through them). */
  isDecor(c: RAPIER.Collider): boolean {
    return this.decorHandles.has(c.handle);
  }

  /** A building appeared or left: the trunks and rocks under it go or come back. */
  private refreshDecor(b: Building): void {
    const d = this.decor;
    if (!d) return;
    for (const [cx, cz] of this.sim.cellsFor(b.type, b.x, b.z, b.rot)) {
      for (const i of d.byCell.get(cx + cz * this.sim.width) ?? []) {
        const c = this.decorColliders.get(i);
        if (!c) continue;
        if (isCleared(d, i, this.sim.grid)) {
          c.setEnabled(false);
          this.decorPending.delete(i);
        } else this.decorPending.add(i);
      }
    }
  }

  /** The collider is the ground (the slab or the heightfield). */
  isGround(c: RAPIER.Collider): boolean {
    return c.handle === this.ground.handle;
  }

  /** Ground height (m) under (x, z). */
  heightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  /** Copies the effective ground of lattice corners [i0, i1] × [j0, j1] (array indices) into the heightfield data. */
  private fillHeights(i0: number, j0: number, i1: number, j1: number): void {
    const t = this.terrain;
    const h = this.heights!;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) h[j + i * t.nz] = t.eff[i + j * t.nx]! / 100;
  }

  /** Building id owning a collider, or null for the ground / unknown. */
  buildingOf(collider: RAPIER.Collider): number | null {
    return this.byHandle.get(collider.handle) ?? null;
  }

  /** Colliders of a building; a belt piece on the relief waits for the next flush (unless `now`). */
  private add(b: Building, now = false): void {
    if (!now && isBelt(b.type) && !this.terrain.flat) {
      this.pendingBelts.add(b.id);
      return;
    }
    const [w, h] = BUILDINGS[b.type].footprint;
    const [rw, rh] = rotatedSize(w, h, b.rot);
    const cx = (b.x + rw / 2) * FACTORY_CELL;
    const cz = (b.z + rh / 2) * FACTORY_CELL;
    const relief = !this.terrain.flat;
    // Padded buildings stand on their pad; on the relief their boxes also reach PAD_DEPTH under it.
    const y0 = relief ? (b.py ?? 0) / 100 : 0;
    const down = relief ? PAD_DEPTH : 0;
    const descs: RAPIER.ColliderDesc[] = [];
    if (b.type === 'hub') {
      descs.push(RAPIER.ColliderDesc.cuboid(1.45, 1.95, 1.45).setTranslation(cx, y0 + 1.95, cz));
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        descs.push(RAPIER.ColliderDesc.cuboid(0.25, 1.6, 0.8).setTranslation(cx + sx * 2.7, y0 + 1.6, cz + sz * 2.7));
      }
      // Crafting bench on the south face (part of the hub): taller than a step so it is walked around, not climbed.
      const bench = { x: 0, z: 0 };
      rotateLocal(0, HUB_BENCH.z, b.rot, bench);
      const [bhx, bhz] = rotatedSize(HUB_BENCH.halfW, HUB_BENCH.halfD, b.rot);
      const bhy = Math.max(HUB_BENCH.top, PLAYER.STEP_HEIGHT + 0.2) / 2;
      descs.push(RAPIER.ColliderDesc.cuboid(bhx, bhy, bhz).setTranslation(cx + bench.x, y0 + bhy, cz + bench.z));
      // A thin pickable slab over the whole footprint so the hub can be aimed at.
      descs.push(RAPIER.ColliderDesc.cuboid((rw * FACTORY_CELL) / 2, 0.02, (rh * FACTORY_CELL) / 2).setTranslation(cx, y0 + 0.02, cz));
    } else if (b.type === 'garage') {
      // Walls, door lintel and corner clutter: the bay floor is the ground collider (cars drive in and
      // out), no roof (cameras). Aiming at the floor falls back to the footprint cells (BuildController).
      for (const w of [...GARAGE_WALLS, GARAGE_LINTEL, ...Object.values(GARAGE_CLUTTER)].map((l) => rotateBox(l, b.rot))) {
        // Standing parts (bottom on the floor) reach under the pad too; the lintel hangs.
        const grounded = w.y - w.hy < 0.01;
        const hy = grounded ? w.hy + down / 2 : w.hy;
        descs.push(RAPIER.ColliderDesc.cuboid(w.hx, hy, w.hz).setTranslation(cx + w.x, y0 + w.y - (grounded ? down / 2 : 0), cz + w.z));
      }
    } else if (isBelt(b.type) && relief) {
      // On the relief a belt piece follows its deck: a hull from under the lowest corner to 0.8 m over the deck.
      const deck = this.sim.deckOf(b, { c: 0, sx: 0, sz: 0 });
      const t = this.terrain;
      const low = Math.min(t.effAt(b.x, b.z), t.effAt(b.x + 1, b.z), t.effAt(b.x, b.z + 1), t.effAt(b.x + 1, b.z + 1)) / 100 - 0.2;
      const pts = new Float32Array(24);
      let k = 0;
      for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const x = (b.x + i) * FACTORY_CELL;
        const z = (b.z + j) * FACTORY_CELL;
        pts.set([x, low, z, x, deckY(deck, b.x, b.z, x, z) + HEIGHTS[b.type], z], k);
        k += 6;
      }
      const d = RAPIER.ColliderDesc.convexHull(pts);
      if (d) descs.push(d.setCollisionGroups(CONVEYOR_GROUPS));
      this.beltDecks.set(b.id, { ...deck });
    } else {
      const half = HEIGHTS[b.type] / 2;
      const inset = isBelt(b.type) ? 0 : 0.06;
      const hy = half + down / 2;
      const d = RAPIER.ColliderDesc.cuboid((rw * FACTORY_CELL) / 2 - inset, hy, (rh * FACTORY_CELL) / 2 - inset).setTranslation(cx, y0 + half - down / 2, cz);
      // Cars drive across belt lines (splitters and mergers included).
      descs.push(isBelt(b.type) ? d.setCollisionGroups(CONVEYOR_GROUPS) : d);
    }
    const list = descs.map((d) => this.physics.world.createCollider(d.setFriction(0.8)));
    this.colliders.set(b.id, list);
    for (const c of list) this.byHandle.set(c.handle, b.id);
  }

  private remove(id: number): void {
    this.beltDecks.delete(id);
    this.pendingBelts.delete(id);
    const list = this.colliders.get(id);
    if (!list) return;
    for (const c of list) {
      this.byHandle.delete(c.handle);
      this.physics.world.removeCollider(c, false);
    }
    this.colliders.delete(id);
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.physics.dispose();
  }
}
