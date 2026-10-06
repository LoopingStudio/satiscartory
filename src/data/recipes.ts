import type { ItemId } from './items';

export type MachineType = 'press' | 'assembler';

export interface Stack {
  item: ItemId;
  count: number;
}

export interface Recipe {
  id: string;
  name: string;
  machine: MachineType;
  inputs: Stack[];
  outputs: Stack[];
  /** Duration in factory ticks (20 per second). */
  ticks: number;
}

export const RECIPES: Recipe[] = [
  // Presse
  { id: 'plate', name: 'Plaque', machine: 'press', inputs: [{ item: 'iron_ore', count: 1 }], outputs: [{ item: 'plate', count: 1 }], ticks: 40 },
  { id: 'bolt', name: 'Boulons', machine: 'press', inputs: [{ item: 'iron_ore', count: 1 }], outputs: [{ item: 'bolt', count: 2 }], ticks: 40 },
  { id: 'tire', name: 'Pneu', machine: 'press', inputs: [{ item: 'latex', count: 2 }], outputs: [{ item: 'tire', count: 1 }], ticks: 60 },
  // Assembleuse
  {
    id: 'chassis', name: 'Châssis', machine: 'assembler',
    inputs: [{ item: 'plate', count: 2 }, { item: 'bolt', count: 4 }], outputs: [{ item: 'chassis', count: 1 }], ticks: 120,
  },
  {
    id: 'engine', name: 'Moteur', machine: 'assembler',
    inputs: [{ item: 'plate', count: 3 }, { item: 'bolt', count: 4 }], outputs: [{ item: 'engine', count: 1 }], ticks: 160,
  },
  {
    id: 'wheel', name: 'Roue', machine: 'assembler',
    inputs: [{ item: 'tire', count: 1 }, { item: 'plate', count: 1 }], outputs: [{ item: 'wheel', count: 1 }], ticks: 80,
  },
  {
    id: 'wheel_racing', name: 'Roue racing', machine: 'assembler',
    inputs: [{ item: 'tire', count: 2 }, { item: 'plate', count: 1 }, { item: 'bolt', count: 2 }], outputs: [{ item: 'wheel_racing', count: 1 }], ticks: 100,
  },
  {
    id: 'panel', name: 'Panneau', machine: 'assembler',
    inputs: [{ item: 'plate', count: 1 }, { item: 'bolt', count: 2 }], outputs: [{ item: 'panel', count: 1 }], ticks: 80,
  },
  {
    id: 'spoiler', name: 'Aileron', machine: 'assembler',
    inputs: [{ item: 'plate', count: 2 }, { item: 'bolt', count: 1 }], outputs: [{ item: 'spoiler', count: 1 }], ticks: 60,
  },
];

export const RECIPES_BY_ID: Record<string, Recipe> = Object.fromEntries(RECIPES.map((r) => [r.id, r]));

export function recipesFor(machine: MachineType): Recipe[] {
  return RECIPES.filter((r) => r.machine === machine);
}
