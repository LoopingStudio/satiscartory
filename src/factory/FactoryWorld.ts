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
  private readonly deck: DeckPlane = { c: 0, sx: 0, sz: 0 };
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
    this.unsub.push(
      sim.events.on('placed', (b) => this.add(b)),
      sim.events.on('removed', (b) => this.remove(b.id)),
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
    }
    if (d || this.beltsStale) {
      this.sim.syncTopology();
      // Links changed: any belt's shape may have; otherwise only the belts on the changed corners.
      const all = this.beltsStale;
      this.beltsStale = false;
      for (const b of this.sim.buildings.values()) {
        if (!isBelt(b.type)) continue;
        if (!all && d && (b.x + 1 < d.i0 || b.x > d.i1 || b.z + 1 < d.j0 || b.z > d.j1)) continue;
        const was = this.beltDecks.get(b.id);
        const now = this.sim.deckOf(b, this.deck);
        if (was && was.c === now.c && was.sx === now.sx && was.sz === now.sz) continue;
        this.remove(b.id);
        this.add(b);
      }
    }
    return area;
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

  private add(b: Building): void {
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
