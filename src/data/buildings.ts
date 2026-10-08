import type { Inventory } from './items';
import type { MachineType } from './recipes';

/** Grid sides: 0 = +Z, 1 = +X, 2 = -Z, 3 = -X (local, before rotation). */
export type Side = 0 | 1 | 2 | 3;

/** Local side of the garage door (rotation 0: +Z, the short side). */
export const GARAGE_DOOR_SIDE: Side = 0;

export type BuildingType = 'conveyor' | 'splitter' | 'merger' | 'drill' | 'smelter' | 'press' | 'assembler' | 'garage' | 'dealer' | 'hub';

export interface PortDef {
  /** Local cell offset inside the footprint (rotation 0). */
  cell: [number, number];
  side: Side;
  dir: 'in' | 'out';
}

export interface BuildingDef {
  type: BuildingType;
  name: string;
  description: string;
  /** Footprint at rotation 0: [width along X, depth along Z] in cells. */
  footprint: [number, number];
  ports: PortDef[];
  cost: Inventory;
  /** Can the player build/dismantle it? (the hub is pre-placed) */
  buildable: boolean;
  machine?: MachineType;
  /** Drill: at least one footprint cell must lie on a resource node. */
  needsNode?: boolean;
  /** Hub: every outward-facing edge of the footprint is an input. */
  acceptsAllEdges?: boolean;
  /** Walk-in / drive-in building (garage): walls around an open floor, aim falls back to its cells. */
  hollow?: boolean;
  /** Outputs through every linked output port, in turn (splitter); others use the first one that links. */
  multiOut?: boolean;
  /** Belt-height logistics piece (conveyor, splitter, merger): walked over, driven across, no panel. */
  belt?: boolean;
}

/**
 * Machines (drill, press, assembler) are 2 cells wide and 1 deep: items cross them
 * like the tunnel of their model, in through the back long side and out through the
 * front long side. Either front cell can feed a conveyor (the first linked one wins).
 */
const MACHINE_IN: PortDef[] = [
  { cell: [0, 0], side: 2, dir: 'in' },
  { cell: [1, 0], side: 2, dir: 'in' },
];
const MACHINE_OUT: PortDef[] = [
  { cell: [0, 0], side: 0, dir: 'out' },
  { cell: [1, 0], side: 0, dir: 'out' },
];

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  conveyor: {
    type: 'conveyor',
    name: 'Convoyeur',
    description: 'Transporte les objets vers l’avant (2 m/s).',
    footprint: [1, 1],
    // Inputs from back and both sides; output to the front.
    ports: [
      { cell: [0, 0], side: 2, dir: 'in' },
      { cell: [0, 0], side: 1, dir: 'in' },
      { cell: [0, 0], side: 3, dir: 'in' },
      { cell: [0, 0], side: 0, dir: 'out' },
    ],
    cost: { plate: 1 },
    buildable: true,
    belt: true,
  },
  splitter: {
    type: 'splitter',
    name: 'Répartiteur',
    description: 'Partage un convoyeur en trois : entrée à l’arrière, sorties à l’avant, à gauche et à droite, chacune à son tour.',
    footprint: [1, 1],
    ports: [
      { cell: [0, 0], side: 2, dir: 'in' },
      { cell: [0, 0], side: 0, dir: 'out' },
      { cell: [0, 0], side: 3, dir: 'out' },
      { cell: [0, 0], side: 1, dir: 'out' },
    ],
    cost: { plate: 2, iron_rod: 2 },
    buildable: true,
    multiOut: true,
    belt: true,
  },
  merger: {
    type: 'merger',
    name: 'Fusionneur',
    description: 'Réunit jusqu’à trois arrivées (arrière, gauche, droite) en un seul convoyeur vers l’avant, chacune à son tour.',
    footprint: [1, 1],
    ports: [
      { cell: [0, 0], side: 2, dir: 'in' },
      { cell: [0, 0], side: 3, dir: 'in' },
      { cell: [0, 0], side: 1, dir: 'in' },
      { cell: [0, 0], side: 0, dir: 'out' },
    ],
    cost: { plate: 2, iron_rod: 2 },
    buildable: true,
    belt: true,
  },
  drill: {
    type: 'drill',
    name: 'Foreuse',
    description: 'Extrait du minerai de fer ou du latex. À poser sur un gisement.',
    footprint: [2, 1],
    ports: MACHINE_OUT,
    cost: { plate: 6, iron_rod: 4 },
    buildable: true,
    needsNode: true,
  },
  smelter: {
    type: 'smelter',
    name: 'Fonderie',
    description: 'Fond le minerai de fer en lingots.',
    footprint: [2, 1],
    ports: [...MACHINE_IN, ...MACHINE_OUT],
    cost: { plate: 4, iron_rod: 6 },
    buildable: true,
    machine: 'smelter',
  },
  // Internal id kept as 'press' (saves); shown as « Constructeur ».
  press: {
    type: 'press',
    name: 'Constructeur',
    description: 'Façonne lingots et matières : plaques, tiges, boulons, pneus.',
    footprint: [2, 1],
    ports: [...MACHINE_IN, ...MACHINE_OUT],
    cost: { plate: 10, iron_rod: 8, bolt: 16 },
    buildable: true,
    machine: 'press',
  },
  assembler: {
    type: 'assembler',
    name: 'Assembleuse',
    description: 'Assemble plusieurs pièces en pièces de voiture.',
    footprint: [2, 1],
    ports: [...MACHINE_IN, ...MACHINE_OUT],
    cost: { plate: 20, iron_rod: 12, bolt: 40 },
    buildable: true,
    machine: 'assembler',
  },
  garage: {
    type: 'garage',
    name: 'Garage',
    description: 'Une place pour une voiture : E pour assembler, régler les pièces et choisir sa voiture. Porte à l’avant.',
    footprint: [3, 4],
    ports: [],
    cost: { plate: 40, iron_rod: 24, bolt: 80 },
    buildable: true,
    hollow: true,
  },
  dealer: {
    type: 'dealer',
    name: 'Concession',
    description: 'Reçoit les pièces de voiture par l’arrière, monte la voiture la plus chère possible et la vend contre des crédits.',
    footprint: [3, 2],
    // Three inputs on the back long side (one part line each, or an assembler pushed against it); no output.
    ports: [
      { cell: [0, 0], side: 2, dir: 'in' },
      { cell: [1, 0], side: 2, dir: 'in' },
      { cell: [2, 0], side: 2, dir: 'in' },
    ],
    cost: { plate: 60, iron_rod: 30, bolt: 120 },
    buildable: true,
  },
  hub: {
    type: 'hub',
    name: 'Hangar central',
    description: 'Stocke tout ce qu’il reçoit. Abrite l’établi et les paliers ; paie les constructions et alimente le garage.',
    footprint: [3, 3],
    ports: [],
    cost: {},
    buildable: false,
    acceptsAllEdges: true,
  },
};

/**
 * Build menu order = shortcut keys 1-9. The production chain keeps 1-6 in unlock order; splitter and merger
 * (tier 1, added later) come next as 7 and 8, the dealer (tier 6) as 9, so that the older keys did not move.
 */
export const BUILD_MENU: BuildingType[] = ['conveyor', 'drill', 'smelter', 'press', 'assembler', 'garage', 'splitter', 'merger', 'dealer'];

/** Build menu sections (the number keys follow BUILD_MENU). */
export const BUILD_CATEGORIES: { name: string; types: BuildingType[] }[] = [
  { name: 'Logistique', types: ['conveyor', 'splitter', 'merger'] },
  { name: 'Extraction', types: ['drill'] },
  { name: 'Production', types: ['smelter', 'press', 'assembler'] },
  { name: 'Véhicules', types: ['garage', 'dealer'] },
];

/** The build menu's order, which the pad's ◀ ▶ follow. */
export const BUILD_ORDER: BuildingType[] = BUILD_CATEGORIES.flatMap((c) => c.types);

/** Belt-height logistics piece (conveyor, splitter, merger). */
export function isBelt(type: BuildingType): boolean {
  return !!BUILDINGS[type].belt;
}

/**
 * Stands on a pad: on the relief, its footprint is leveled to one height (machines, drill, garage, hub).
 * Belt pieces follow the ground instead.
 */
export function isPadded(type: BuildingType): boolean {
  return !BUILDINGS[type].belt;
}
