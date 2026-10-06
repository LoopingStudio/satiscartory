import type { Inventory } from './items';
import type { MachineType } from './recipes';

/** Grid sides: 0 = +Z, 1 = +X, 2 = -Z, 3 = -X (local, before rotation). */
export type Side = 0 | 1 | 2 | 3;

export type BuildingType = 'conveyor' | 'drill' | 'press' | 'assembler' | 'hub';

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
}

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
  },
  drill: {
    type: 'drill',
    name: 'Foreuse',
    description: 'Extrait du minerai de fer ou du latex. À poser sur un gisement.',
    footprint: [1, 2],
    ports: [{ cell: [0, 1], side: 0, dir: 'out' }],
    cost: { plate: 5, bolt: 4 },
    buildable: true,
    needsNode: true,
  },
  press: {
    type: 'press',
    name: 'Presse',
    description: 'Transforme une matière en pièce simple (plaques, boulons, pneus).',
    footprint: [1, 2],
    ports: [
      { cell: [0, 0], side: 2, dir: 'in' },
      { cell: [0, 0], side: 1, dir: 'in' },
      { cell: [0, 0], side: 3, dir: 'in' },
      { cell: [0, 1], side: 0, dir: 'out' },
    ],
    cost: { plate: 6, bolt: 4 },
    buildable: true,
    machine: 'press',
  },
  assembler: {
    type: 'assembler',
    name: 'Assembleuse',
    description: 'Assemble plusieurs pièces en pièces de voiture.',
    footprint: [1, 2],
    ports: [
      { cell: [0, 0], side: 2, dir: 'in' },
      { cell: [0, 0], side: 1, dir: 'in' },
      { cell: [0, 0], side: 3, dir: 'in' },
      { cell: [0, 1], side: 0, dir: 'out' },
    ],
    cost: { plate: 8, bolt: 8 },
    buildable: true,
    machine: 'assembler',
  },
  hub: {
    type: 'hub',
    name: 'Hangar central',
    description: 'Stocke tout ce qu’il reçoit. Paie les constructions et alimente le garage.',
    footprint: [3, 3],
    ports: [],
    cost: {},
    buildable: false,
    acceptsAllEdges: true,
  },
};

export const BUILD_MENU: BuildingType[] = ['conveyor', 'drill', 'press', 'assembler'];
