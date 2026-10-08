import type { Inventory } from './items';

/** Snapshot used to evaluate onboarding objectives (pure data). */
export interface ObjectiveContext {
  buildings: { type: string; recipe?: string | null; resource?: string | null }[];
  storage: Inventory;
  cars: number;
  /** Items received by the hub so far (belts only). */
  delivered: Inventory;
  /** Items produced by drills and machines (sim.crafted); hand mining and the bench never count. */
  crafted: Inventory;
  /** Blueprints of the assembled cars. */
  blueprints: string[];
  /** Finished runs with an assembled car (not the loaner). */
  racesWithOwnCar: number;
  /** Hub tiers unlocked. */
  tier: number;
  /** Cars sold (dealers and garages). */
  carsSold: number;
}

export interface Objective {
  id: string;
  text: string;
  /** Tokens such as {interact} or {hotkey2} become the key or the pad button (ui/padHints renderTokens). */
  hint: string;
  done(c: ObjectiveContext): boolean;
}

/**
 * Guided path through the whole loop, Satisfactory-style: hand mining and the bench, then the hub tiers
 * one by one, up to the car and the race. Each step also completes once the player is past it (tier),
 * so saves from before the tiers (everything unlocked) do not replay the bootstrap.
 */
export const OBJECTIVES: Objective[] = [
  {
    id: 'mine',
    text: 'Mine du minerai de fer à la main',
    hint: 'Vise les roches rouille d’un gisement, tout près, et maintiens {interact}. Le minerai va dans ton sac.',
    done: (c) => (c.storage.iron_ore ?? 0) >= 5 || c.tier >= 1,
  },
  {
    id: 'bench',
    text: 'Fabrique 10 tiges de fer à l’établi du hangar',
    hint: '{interact} sur le hangar → Établi. Minerai → lingot, puis lingot → tige : maintiens le bouton pour fabriquer.',
    done: (c) => (c.storage.iron_rod ?? 0) >= 10 || c.tier >= 1,
  },
  {
    id: 'tier1',
    text: 'Débloque le palier 1 (Extraction) au hangar',
    hint: '{interact} sur le hangar → Paliers. Le sac paie d’abord, puis le hangar.',
    done: (c) => c.tier >= 1,
  },
  {
    id: 'drill_ore',
    text: 'Pose une foreuse sur le fer',
    hint: '{buildMenu} → Foreuse {hotkey2}, {rotate} pour tourner. {buildMenu} → Convoyeur {hotkey1} : {hold} jusqu’au hangar ; en attendant, {interact} sur la foreuse → « Prendre ».',
    done: (c) => (c.crafted.iron_ore ?? 0) > 0 || (c.delivered.iron_ore ?? 0) > 0 || c.tier >= 2,
  },
  {
    id: 'tier2',
    text: 'Débloque le palier 2 (Fonderie)',
    hint: 'Plaques et tiges à l’établi, ou avec le minerai qui arrive au hangar.',
    done: (c) => c.tier >= 2,
  },
  {
    id: 'smelt',
    text: 'Fais fondre le minerai dans une fonderie',
    hint: '{buildMenu} → Fonderie {hotkey3}, reliée à la foreuse par convoyeur. Une foreuse alimente exactement une fonderie.',
    done: (c) => (c.crafted.iron_ingot ?? 0) > 0 || (c.delivered.iron_ingot ?? 0) > 0 || c.tier >= 3,
  },
  {
    id: 'tier3',
    text: 'Débloque le palier 3 (Constructeur)',
    hint: 'Les boulons se font à l’établi : tige → 4 boulons.',
    done: (c) => c.tier >= 3,
  },
  {
    id: 'plates',
    text: 'Produis des plaques avec un constructeur',
    hint: '{buildMenu} → Constructeur {hotkey4}, puis {interact} pour choisir « Plaque ». 1 foreuse → 1 fonderie → 1 constructeur.',
    done: (c) => (c.crafted.plate ?? 0) > 0 || (c.delivered.plate ?? 0) > 0 || c.tier >= 4,
  },
  {
    id: 'tires',
    text: 'Fais des pneus : foreuse sur le caoutchouc → constructeur « Pneu »',
    hint: 'Roches noires. Le palier 4 demande 10 pneus.',
    done: (c) => (c.crafted.tire ?? 0) > 0 || (c.storage.tire ?? 0) > 0 || c.tier >= 4,
  },
  {
    id: 'tier4',
    text: 'Débloque le palier 4 (Assemblage)',
    hint: '{interact} sur le hangar → Paliers.',
    done: (c) => c.tier >= 4,
  },
  {
    id: 'car_parts',
    text: 'Produis 4 roues, 1 châssis et 1 moteur',
    hint: '{buildMenu} → Assembleuse {hotkey5}. Châssis et moteur demandent plaques, tiges et boulons ; la roue, un pneu et une plaque.',
    done: (c) => c.cars > 0 || ((c.storage.wheel ?? 0) + (c.storage.wheel_racing ?? 0) >= 4 && (c.storage.chassis ?? 0) >= 1 && (c.storage.engine ?? 0) >= 1),
  },
  {
    id: 'tier5',
    text: 'Débloque le palier 5 (Garage)',
    hint: '{interact} sur le hangar → Paliers. Les pneus viennent du constructeur « Pneu ».',
    done: (c) => c.tier >= 5 || c.cars > 0,
  },
  {
    id: 'garage',
    text: 'Construis un garage',
    hint: '{buildMenu} → Garage {hotkey6}, {rotate} pour tourner : la porte (flèche bleue) doit donner sur un espace libre pour sortir en voiture.',
    done: (c) => c.buildings.some((b) => b.type === 'garage') || c.cars > 0,
  },
  {
    id: 'assembled',
    text: 'Assemble ton kart au garage',
    hint: '{interact} sur un garage, choisis le kart puis « Assembler ». Le sac paie d’abord, puis le hangar.',
    done: (c) => c.cars > 0,
  },
  {
    id: 'race',
    text: 'Termine une course avec ta voiture',
    hint: 'Menu Courses, choisis un circuit et vise une médaille !',
    done: (c) => c.racesWithOwnCar > 0,
  },
  {
    id: 'tier6',
    text: 'Débloque le palier 6 (Commerce)',
    hint: '{interact} sur le hangar → Paliers. Il se paie en pièces de voiture : 2 châssis, 2 moteurs, 8 roues, 4 panneaux.',
    done: (c) => c.tier >= 6,
  },
  {
    id: 'dealer',
    text: 'Construis une concession',
    hint: '{buildMenu} → Concession {hotkey9}. Amène-lui des pièces de voiture par convoyeur, par l’arrière : elle monte la voiture la plus chère possible et la vend.',
    done: (c) => c.buildings.some((b) => b.type === 'dealer'),
  },
  {
    id: 'sell',
    text: 'Vends une première voiture',
    hint: '{interact} sur la concession → « Charger » y met les voitures complètes de ton surplus. Au garage, « Vendre » vend la voiture garée.',
    done: (c) => c.carsSold > 0,
  },
  {
    id: 'sport',
    text: 'Bonus : assemble la Sportive (carrosserie = plaques + boulons)',
    hint: 'L’assembleuse fait des panneaux. Les roues racing et l’aileron améliorent la tenue de route.',
    done: (c) => c.blueprints.includes('sport'),
  },
];
