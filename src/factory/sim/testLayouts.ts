import { BELT } from '../../data/balance';
import type { Rot } from './dirs';
import type { FactorySim } from './FactorySim';
import type { ConveyorB } from './types';

/** Places a straight run of conveyors starting at (x, z) heading `rot`. */
export function conveyorLine(sim: FactorySim, x: number, z: number, rot: Rot, n: number, free = true): number[] {
  const dx = [0, 1, 0, -1][rot]!;
  const dz = [1, 0, -1, 0][rot]!;
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = sim.place('conveyor', x + dx * i, z + dz * i, rot, { free });
    if (r.ok) ids.push(r.building.id);
  }
  return ids;
}

/**
 * Demo chain on the default map (hub at 30..32 × 30..32):
 * iron drill → press (plates) → hub, iron drill → press (bolts) → hub, rubber drill → press (tires) → hub.
 */
export function spawnDemoFactory(sim: FactorySim): void {
  const free = { free: true };
  // Plates: drill on iron node (24..26, 24..26), facing +X.
  sim.place('drill', 24, 24, 1, free); // cells (24,24),(25,24); out (25,24) → (26,24)
  conveyorLine(sim, 26, 24, 1, 2); // (26..27, 24)
  const p1 = sim.place('press', 28, 24, 1, free); // (28..29, 24); out → (30,24)
  if (p1.ok) sim.setRecipe(p1.building.id, 'plate');
  conveyorLine(sim, 30, 24, 0, 6); // (30, 24..29) → hub (30,30)

  // Bolts: second iron drill on the same node, row 26.
  sim.place('drill', 24, 26, 1, free); // (24..25, 26) → (26,26)
  conveyorLine(sim, 26, 26, 1, 2);
  const p2 = sim.place('press', 28, 26, 1, free); // out → (30,26)
  if (p2.ok) sim.setRecipe(p2.building.id, 'bolt');
  conveyorLine(sim, 30, 26, 1, 1); // (30,26) facing +X → (31,26)
  conveyorLine(sim, 31, 26, 0, 4); // (31, 26..29) → hub

  // Tires: rubber node (23..25, 36..38) → press → up into the hub's +Z edge.
  sim.place('drill', 24, 37, 1, free); // (24..25, 37) → (26,37)
  conveyorLine(sim, 26, 37, 1, 3); // (26..28, 37)
  const p3 = sim.place('press', 29, 37, 1, free); // (29..30, 37) → (31,37)
  if (p3.ok) sim.setRecipe(p3.building.id, 'tire');
  conveyorLine(sim, 31, 37, 2, 5); // (31, 37..33) facing -Z → hub (31,32)
}

/** Concentric closed conveyor rings filled with items (one per tile), for performance checks. */
export function spawnStressLoops(sim: FactorySim, perTile = 1): number {
  for (let inset = 0; sim.width - 2 * inset >= 6 && sim.height - 2 * inset >= 6; inset += 2) {
    const x0 = inset;
    const z0 = inset;
    const x1 = sim.width - 1 - inset;
    const z1 = sim.height - 1 - inset;
    const w = x1 - x0 + 1;
    const h = z1 - z0 + 1;
    conveyorLine(sim, x0, z0, 1, w - 1); // bottom, +X
    conveyorLine(sim, x1, z0, 0, h - 1); // right, +Z
    conveyorLine(sim, x1, z1, 3, w - 1); // top, -X
    conveyorLine(sim, x0, z1, 2, h - 1); // left, -Z
  }
  const items = ['plate', 'bolt', 'tire', 'wheel', 'engine', 'iron_ore'] as const;
  let n = 0;
  for (const b of sim.buildings.values()) {
    if (b.type !== 'conveyor') continue;
    const c = b as ConveyorB;
    for (let k = 0; k < perTile; k++) {
      const pos = BELT.SEG - (k + 1) * BELT.SPACING;
      c.items.push({ item: items[n++ % items.length]!, pos, prev: pos, from: 2 });
    }
  }
  return n;
}
