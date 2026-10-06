import type { Inventory } from './items';

/** Snapshot used to evaluate onboarding objectives (pure data). */
export interface ObjectiveContext {
  buildings: { type: string; recipe?: string | null; resource?: string | null }[];
  storage: Inventory;
  cars: number;
  /** Items received by the hub so far. */
  delivered: Inventory;
  /** Blueprints of the assembled cars. */
  blueprints: string[];
  /** Finished runs with an assembled car (not the loaner). */
  racesWithOwnCar: number;
}

export interface Objective {
  id: string;
  text: string;
  hint: string;
  done(c: ObjectiveContext): boolean;
}

/** Short guided path through the whole loop (playable in a couple of minutes). */
export const OBJECTIVES: Objective[] = [
  {
    id: 'iron',
    text: 'Produis des plaques : foreuse sur le fer → presse « Plaque » → hangar',
    hint: 'Touche 2 : foreuse (R pour tourner) sur les roches rouilles. Touche 1 : convoyeurs (clic maintenu). Touche 3 : presse, puis E pour choisir « Plaque ».',
    done: (c) => (c.delivered.plate ?? 0) > 0,
  },
  {
    id: 'drill',
    text: 'Pose une foreuse sur un gisement de caoutchouc (roches noires)',
    hint: 'Le latex sert à fabriquer des pneus.',
    done: (c) => c.buildings.some((b) => b.type === 'drill' && b.resource === 'rubber'),
  },
  {
    id: 'tire',
    text: 'Pose une presse réglée sur « Pneu » et relie-la à la foreuse',
    hint: 'Touche 3 pour la presse, E pour choisir la recette, touche 1 pour tracer des convoyeurs.',
    done: (c) => c.buildings.some((b) => b.type === 'press' && b.recipe === 'tire'),
  },
  {
    id: 'assembler',
    text: 'Construis une assembleuse et règle-la sur « Roue »',
    hint: 'Les pneus arrivent par convoyeur ; les plaques se chargent depuis le hangar (E → Charger).',
    done: (c) => c.buildings.some((b) => b.type === 'assembler'),
  },
  {
    id: 'parts',
    text: 'Produis 4 roues, 1 châssis et 1 moteur',
    hint: 'Change la recette de l’assembleuse ; envoie la production au hangar (convoyeur ou « Récupérer »).',
    done: (c) => c.cars > 0 || ((c.storage.wheel ?? 0) + (c.storage.wheel_racing ?? 0) >= 4 && (c.storage.chassis ?? 0) >= 1 && (c.storage.engine ?? 0) >= 1),
  },
  {
    id: 'assembled',
    text: 'Assemble ton kart au garage',
    hint: 'Touche G (ou le hangar avec E) pour ouvrir le garage.',
    done: (c) => c.cars > 0,
  },
  {
    id: 'race',
    text: 'Termine une course avec ta voiture',
    hint: 'Menu Courses, choisis un circuit et vise une médaille !',
    done: (c) => c.racesWithOwnCar > 0,
  },
  {
    id: 'sport',
    text: 'Bonus : assemble la Sportive (carrosserie = plaques + boulons)',
    hint: 'Ajoute une presse « Boulons » ; l’assembleuse fait des panneaux. Les roues racing et l’aileron améliorent la tenue de route.',
    done: (c) => c.blueprints.includes('sport'),
  },
];
