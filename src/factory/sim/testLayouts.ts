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

/** Places a machine for free and sets its recipe. */
function machine(sim: FactorySim, type: 'smelter' | 'press', x: number, z: number, rot: Rot, recipe: string): void {
  const r = sim.place(type, x, z, rot, { free: true });
  if (r.ok) sim.setRecipe(r.building.id, recipe);
}

/**
 * Demo chains on the default map (hub at 62..64 × 62..64), 1 drill = 1 smelter = 1 constructor:
 * - iron drill → smelter → constructor (plates) → hub;
 * - iron drill → smelter → constructor (rods), merged into the plate line;
 * - iron drill → smelter → constructor (rods) → constructor (bolts) → hub;
 * - rubber drill → constructor (tires) → hub.
 */
export function spawnDemoFactory(sim: FactorySim): void {
  const free = { free: true };
  // Machines facing ±X (rot 1/3) are 1 cell wide along X and 2 along Z; items cross them,
  // in through the -X side of both cells, out through the +X side (the first linked cell wins).
  // Plates: drill on the west iron node (44..47, 61..64), east toward the hub.
  sim.place('drill', 46, 61, 1, free); // cells (46, 61..62); out → (47,62)
  conveyorLine(sim, 47, 62, 1, 3); // (47..49, 62)
  machine(sim, 'smelter', 50, 62, 1, 'iron_ingot'); // (50, 62..63); in from (49,62); out → (51,62)
  conveyorLine(sim, 51, 62, 1, 3); // (51..53, 62)
  machine(sim, 'press', 54, 62, 1, 'iron_plate'); // (54, 62..63); out → (55,62)
  conveyorLine(sim, 55, 62, 1, 7); // (55..61, 62) → hub (62,62)

  // Rods: third drill on the node's free corner, facing -Z, one row south of the plate line.
  sim.place('drill', 44, 61, 2, free); // cells (44..45, 61); out → (45,60)
  conveyorLine(sim, 45, 60, 1, 3); // (45..47, 60)
  machine(sim, 'smelter', 48, 60, 1, 'iron_ingot'); // (48, 60..61); out → (49,60)
  conveyorLine(sim, 49, 60, 1, 2); // (49..50, 60)
  machine(sim, 'press', 51, 60, 1, 'iron_rod'); // (51, 60..61); out → (52,60)
  conveyorLine(sim, 52, 60, 1, 6); // (52..57, 60)
  conveyorLine(sim, 58, 60, 0, 2); // (58, 60..61) → side of the plate line at (58,62)

  // Bolts: second drill on the same node, two rows up; rods are cut into bolts by a second constructor.
  sim.place('drill', 46, 63, 1, free); // (46, 63..64) → (47,64)
  conveyorLine(sim, 47, 64, 1, 2); // (47..48, 64)
  machine(sim, 'smelter', 49, 64, 1, 'iron_ingot'); // (49, 64..65); out → (50,64)
  conveyorLine(sim, 50, 64, 1, 2); // (50..51, 64)
  machine(sim, 'press', 52, 64, 1, 'iron_rod'); // (52, 64..65); out → (53,64)
  conveyorLine(sim, 53, 64, 1, 2); // (53..54, 64)
  machine(sim, 'press', 55, 64, 1, 'bolts'); // (55, 64..65); out → (56,64)
  conveyorLine(sim, 56, 64, 1, 6); // (56..61, 64) → hub (62,64)

  // Tires: north rubber node (61..63, 80..82) → constructor → down into the hub's +Z edge.
  sim.place('drill', 61, 80, 2, free); // cells (61..62, 80), facing -Z; out → (62,79)
  conveyorLine(sim, 62, 79, 2, 5); // (62, 79..75)
  machine(sim, 'press', 61, 74, 2, 'tire'); // (61..62, 74); in from (62,75); out → (62,73)
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
