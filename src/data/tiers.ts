import type { BuildingType } from './buildings';
import type { Inventory } from './items';

/** A milestone paid at the hub (backpack first, then hub stock), like the HUB milestones of Satisfactory. */
export interface TierDef {
  name: string;
  description: string;
  cost: Inventory;
  unlocks: BuildingType[];
}

/** In order: tier n (1-based) unlocks TIERS[n - 1]. Before tier 1, only hand mining and the bench. */
export const TIERS: TierDef[] = [
  { name: 'Extraction', description: 'Foreuses et convoyeurs : le minerai arrive tout seul.', cost: { iron_rod: 10 }, unlocks: ['drill', 'conveyor'] },
  { name: 'Fonderie', description: 'Fond le minerai en lingots, sans passer par l’établi.', cost: { plate: 10, iron_rod: 10 }, unlocks: ['smelter'] },
  { name: 'Constructeur', description: 'Plaques, tiges, boulons et pneus à la chaîne.', cost: { plate: 30, iron_rod: 20, bolt: 40 }, unlocks: ['press'] },
  { name: 'Assemblage', description: 'Assembleuse : les pièces de voiture.', cost: { plate: 60, iron_rod: 40, bolt: 120, tire: 10 }, unlocks: ['assembler'] },
];

/** Tier (1-based) that unlocks a building; 0 = always available (hub). */
export function tierOf(type: BuildingType): number {
  const i = TIERS.findIndex((t) => t.unlocks.includes(type));
  return i + 1;
}

/** `tier` = number of tiers unlocked so far. */
export function isUnlocked(type: BuildingType, tier: number): boolean {
  return tierOf(type) <= tier;
}
