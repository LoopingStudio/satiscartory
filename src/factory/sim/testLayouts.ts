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
 * Demo chain on the default map (hub at 62..64 × 62..64):
 * iron drill → press (plates) → hub, iron drill → press (bolts) → hub, rubber drill → press (tires) → hub.
 */
export function spawnDemoFactory(sim: FactorySim): void {
  const free = { free: true };
  // Machines facing ±X (rot 1/3) are 1 cell wide along X and 2 along Z; items cross them.
  // Plates: drill on the west iron node (44..47, 61..64), east toward the hub.
  sim.place('drill', 46, 61, 1, free); // cells (46, 61..62); out → (47,62)
  conveyorLine(sim, 47, 62, 1, 6); // (47..52, 62)
  const p1 = sim.place('press', 53, 62, 1, free); // (53, 62..63); in from (52,62); out → (54,62)
  if (p1.ok) sim.setRecipe(p1.building.id, 'plate');
  conveyorLine(sim, 54, 62, 1, 8); // (54..61, 62) → hub (62,62)

  // Bolts: second drill on the same node, two rows up.
  sim.place('drill', 46, 63, 1, free); // (46, 63..64) → (47,64)
  conveyorLine(sim, 47, 64, 1, 6); // (47..52, 64)
  const p2 = sim.place('press', 53, 64, 1, free); // (53, 64..65); out → (54,64)
  if (p2.ok) sim.setRecipe(p2.building.id, 'bolt');
  conveyorLine(sim, 54, 64, 1, 8); // (54..61, 64) → hub (62,64)

  // Tires: north rubber node (61..63, 80..82) → press → down into the hub's +Z edge.
  sim.place('drill', 61, 80, 2, free); // cells (61..62, 80), facing -Z; out → (62,79)
  conveyorLine(sim, 62, 79, 2, 5); // (62, 79..75)
  const p3 = sim.place('press', 61, 74, 2, free); // (61..62, 74); in from (62,75); out → (62,73)
  if (p3.ok) sim.setRecipe(p3.building.id, 'tire');
  conveyorLine(sim, 62, 73, 2, 9); // (62, 73..65) → hub (62,64)
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
