import { PhysicsWorld, RAPIER } from '../core/physics/PhysicsWorld';
import { FACTORY_CELL, GRAVITY_FACTORY } from '../config/constants';
import { BUILDINGS } from '../data/buildings';
import { PLAYER } from '../data/player';
import { rotatedSize } from './sim/dirs';
import { HUB_BENCH } from './view/hubBench';
import { rotateLocal } from './view/beltPath';
import type { FactorySim } from './sim/FactorySim';
import type { Building } from './sim/types';

/** Collider heights per building type (meters). Conveyors are low enough to step onto. */
const HEIGHTS = { conveyor: 0.8, drill: 3.6, smelter: 2.1, press: 2.1, assembler: 2.1 } as const;

/** Rapier world of the factory: ground + one static collider set per building, kept in sync with the sim. */
export class FactoryWorld {
  readonly physics = new PhysicsWorld(GRAVITY_FACTORY);
  private colliders = new Map<number, RAPIER.Collider[]>();
  private byHandle = new Map<number, number>();
  readonly ground: RAPIER.Collider;
  private unsub: (() => void)[] = [];

  constructor(sim: FactorySim) {
    const w = sim.width * FACTORY_CELL;
    const h = sim.height * FACTORY_CELL;
    this.ground = this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(w * 2, 0.5, h * 2).setTranslation(w / 2, -0.5, h / 2).setFriction(1),
    );
    for (const b of sim.buildings.values()) this.add(b);
    this.unsub.push(
      sim.events.on('placed', (b) => this.add(b)),
      sim.events.on('removed', (b) => this.remove(b.id)),
    );
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
    const descs: RAPIER.ColliderDesc[] = [];
    if (b.type === 'hub') {
      descs.push(RAPIER.ColliderDesc.cuboid(1.45, 1.95, 1.45).setTranslation(cx, 1.95, cz));
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        descs.push(RAPIER.ColliderDesc.cuboid(0.25, 1.6, 0.8).setTranslation(cx + sx * 2.7, 1.6, cz + sz * 2.7));
      }
      // Crafting bench on the south face (part of the hub): taller than a step so it is walked around, not climbed.
      const bench = { x: 0, z: 0 };
      rotateLocal(0, HUB_BENCH.z, b.rot, bench);
      const [bhx, bhz] = rotatedSize(HUB_BENCH.halfW, HUB_BENCH.halfD, b.rot);
      const bhy = Math.max(HUB_BENCH.top, PLAYER.STEP_HEIGHT + 0.2) / 2;
      descs.push(RAPIER.ColliderDesc.cuboid(bhx, bhy, bhz).setTranslation(cx + bench.x, bhy, cz + bench.z));
      // A thin pickable slab over the whole footprint so the hub can be aimed at.
      descs.push(RAPIER.ColliderDesc.cuboid((rw * FACTORY_CELL) / 2, 0.02, (rh * FACTORY_CELL) / 2).setTranslation(cx, 0.02, cz));
    } else {
      const half = HEIGHTS[b.type] / 2;
      const inset = b.type === 'conveyor' ? 0 : 0.06;
      descs.push(RAPIER.ColliderDesc.cuboid((rw * FACTORY_CELL) / 2 - inset, half, (rh * FACTORY_CELL) / 2 - inset).setTranslation(cx, half, cz));
    }
    const list = descs.map((d) => this.physics.world.createCollider(d.setFriction(0.8)));
    this.colliders.set(b.id, list);
    for (const c of list) this.byHandle.set(c.handle, b.id);
  }

  private remove(id: number): void {
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
