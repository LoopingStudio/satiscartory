import type { ItemId } from './items';

/** Machine kinds; each value is also the building type that runs it. */
export type MachineType = 'smelter' | 'press' | 'assembler';
/** Where a recipe is made: a machine, or by hand at the crafting bench of the hub. */
export type Station = MachineType | 'bench';

export interface Stack {
  item: ItemId;
  count: number;
}

export interface Recipe {
  id: string;
  name: string;
  machine: Station;
  inputs: Stack[];
  outputs: Stack[];
  /** Duration in factory ticks (20 per second); for the bench, the time to craft by hand. */
  ticks: number;
}

/**
 * Iron goes through three steps, like in Satisfactory: ore → ingot (smelter) → plate, rod (constructor)
 * → bolts. Rates are tuned so that 1 drill = 1 smelter = 1 constructor (30 items/min each).
 * Recipe ids changed with this chain ('plate' and 'bolt' used to take ore): machines saved with an old
 * id are reset on load and their buffers go back to the hub.
 */
export const RECIPES: Recipe[] = [
  // Fonderie
  { id: 'iron_ingot', name: 'Lingot de fer', machine: 'smelter', inputs: [{ item: 'iron_ore', count: 1 }], outputs: [{ item: 'iron_ingot', count: 1 }], ticks: 40 },
  // Constructeur
  { id: 'iron_plate', name: 'Plaque', machine: 'press', inputs: [{ item: 'iron_ingot', count: 3 }], outputs: [{ item: 'plate', count: 2 }], ticks: 120 },
  { id: 'iron_rod', name: 'Tige de fer', machine: 'press', inputs: [{ item: 'iron_ingot', count: 1 }], outputs: [{ item: 'iron_rod', count: 1 }], ticks: 40 },
  { id: 'bolts', name: 'Boulons', machine: 'press', inputs: [{ item: 'iron_rod', count: 1 }], outputs: [{ item: 'bolt', count: 4 }], ticks: 40 },
  { id: 'tire', name: 'Pneu', machine: 'press', inputs: [{ item: 'latex', count: 2 }], outputs: [{ item: 'tire', count: 1 }], ticks: 60 },
  // Assembleuse
  {
    id: 'chassis', name: 'Châssis', machine: 'assembler',
    inputs: [{ item: 'plate', count: 2 }, { item: 'iron_rod', count: 2 }, { item: 'bolt', count: 4 }], outputs: [{ item: 'chassis', count: 1 }], ticks: 120,
  },
  {
    id: 'engine', name: 'Moteur', machine: 'assembler',
    inputs: [{ item: 'plate', count: 3 }, { item: 'iron_rod', count: 2 }, { item: 'bolt', count: 4 }], outputs: [{ item: 'engine', count: 1 }], ticks: 160,
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
  // Établi (à la main, au hangar) : lent, juste de quoi démarrer avant les machines.
  { id: 'hand_ingot', name: 'Lingot de fer', machine: 'bench', inputs: [{ item: 'iron_ore', count: 1 }], outputs: [{ item: 'iron_ingot', count: 1 }], ticks: 15 },
  { id: 'hand_plate', name: 'Plaque', machine: 'bench', inputs: [{ item: 'iron_ingot', count: 3 }], outputs: [{ item: 'plate', count: 2 }], ticks: 20 },
  { id: 'hand_rod', name: 'Tige de fer', machine: 'bench', inputs: [{ item: 'iron_ingot', count: 1 }], outputs: [{ item: 'iron_rod', count: 1 }], ticks: 15 },
  { id: 'hand_bolts', name: 'Boulons', machine: 'bench', inputs: [{ item: 'iron_rod', count: 1 }], outputs: [{ item: 'bolt', count: 4 }], ticks: 15 },
];

export const RECIPES_BY_ID: Record<string, Recipe> = Object.fromEntries(RECIPES.map((r) => [r.id, r]));

export function recipesFor(station: Station): Recipe[] {
  return RECIPES.filter((r) => r.machine === station);
}
