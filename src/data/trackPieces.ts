import type { ModelKey } from '../core/assets/manifest.gen';
import type { Side } from './buildings';

export type GateKind = 'start' | 'checkpoint' | 'finish';

export interface Connector {
  /** Local footprint cell (rotation 0). */
  cell: [number, number];
  side: Side;
  /** Height level relative to the piece base (1 level = 0.25 tile). */
  level: number;
}

export interface PieceDef {
  id: string;
  name: string;
  /** Road surface model. */
  model: ModelKey;
  /** Extra models drawn on top (barriers), with an optional extra quarter-turn rotation. */
  extras?: { model: ModelKey; rot?: number }[];
  /** [cells along X, cells along Z] at rotation 0. */
  footprint: [number, number];
  connectors: Connector[];
  /** Highest level reached by the road surface (for pillars/occupancy). */
  topLevel: number;
  gate?: GateKind;
  /** Shown in the editor palette. */
  palette: boolean;
  category: 'route' | 'virage' | 'pente' | 'spécial';
}

/**
 * Road pieces measured from the GLB files (see scripts/probe-connectors.mjs and
 * tests/roadProbe.test.ts). Sides: 0 = +Z, 1 = +X, 2 = -Z, 3 = -X.
 * `road-straight` runs along X; gate pieces cross it at the tile center, forward = +X.
 */
const straightConn: Connector[] = [
  { cell: [0, 0], side: 3, level: 0 },
  { cell: [0, 0], side: 1, level: 0 },
];

export const TRACK_PIECES: Record<string, PieceDef> = {
  straight: { id: 'straight', name: 'Ligne droite', model: 'city-kit-roads/road-straight', footprint: [1, 1], connectors: straightConn, topLevel: 0, palette: true, category: 'route' },
  // The barrier models contain only the barriers; road-straight-barrier is authored along Z, hence rot 1.
  'straight-barrier': {
    id: 'straight-barrier', name: 'Droite à barrières', model: 'city-kit-roads/road-straight', extras: [{ model: 'city-kit-roads/road-straight-barrier', rot: 1 }],
    footprint: [1, 1], connectors: straightConn, topLevel: 0, palette: true, category: 'route',
  },
  bend: {
    id: 'bend', name: 'Virage serré', model: 'city-kit-roads/road-bend', footprint: [1, 1],
    connectors: [{ cell: [0, 0], side: 3, level: 0 }, { cell: [0, 0], side: 0, level: 0 }], topLevel: 0, palette: true, category: 'virage',
  },
  'bend-barrier': {
    id: 'bend-barrier', name: 'Virage serré à barrières', model: 'city-kit-roads/road-bend', extras: [{ model: 'city-kit-roads/road-bend-barrier' }], footprint: [1, 1],
    connectors: [{ cell: [0, 0], side: 3, level: 0 }, { cell: [0, 0], side: 0, level: 0 }], topLevel: 0, palette: true, category: 'virage',
  },
  curve: {
    id: 'curve', name: 'Grand virage', model: 'city-kit-roads/road-curve', footprint: [2, 2],
    connectors: [{ cell: [0, 0], side: 3, level: 0 }, { cell: [1, 1], side: 0, level: 0 }], topLevel: 0, palette: true, category: 'virage',
  },
  'curve-barrier': {
    id: 'curve-barrier', name: 'Grand virage à barrières', model: 'city-kit-roads/road-curve', extras: [{ model: 'city-kit-roads/road-curve-barrier' }], footprint: [2, 2],
    connectors: [{ cell: [0, 0], side: 3, level: 0 }, { cell: [1, 1], side: 0, level: 0 }], topLevel: 0, palette: true, category: 'virage',
  },
  slope: {
    id: 'slope', name: 'Pente douce', model: 'city-kit-roads/road-slant', footprint: [1, 1],
    connectors: [{ cell: [0, 0], side: 3, level: 0 }, { cell: [0, 0], side: 1, level: 1 }], topLevel: 1, palette: true, category: 'pente',
  },
  'slope-barrier': {
    id: 'slope-barrier', name: 'Pente douce à barrières', model: 'city-kit-roads/road-slant', extras: [{ model: 'city-kit-roads/road-slant-barrier' }], footprint: [1, 1],
    connectors: [{ cell: [0, 0], side: 3, level: 0 }, { cell: [0, 0], side: 1, level: 1 }], topLevel: 1, palette: true, category: 'pente',
  },
  'slope-high-barrier': {
    id: 'slope-high-barrier', name: 'Pente raide à barrières', model: 'city-kit-roads/road-slant-high', extras: [{ model: 'city-kit-roads/road-slant-high-barrier' }], footprint: [1, 1],
    connectors: [{ cell: [0, 0], side: 3, level: 0 }, { cell: [0, 0], side: 1, level: 2 }], topLevel: 2, palette: true, category: 'pente',
  },
  'slope-long-barrier': {
    id: 'slope-long-barrier', name: 'Longue rampe à barrières', model: 'city-kit-roads/road-slant-curve', extras: [{ model: 'city-kit-roads/road-slant-curve-barrier' }], footprint: [2, 1],
    connectors: [{ cell: [0, 0], side: 3, level: 0 }, { cell: [1, 0], side: 1, level: 2 }], topLevel: 2, palette: true, category: 'pente',
  },
  'slope-high': {
    id: 'slope-high', name: 'Pente raide', model: 'city-kit-roads/road-slant-high', footprint: [1, 1],
    connectors: [{ cell: [0, 0], side: 3, level: 0 }, { cell: [0, 0], side: 1, level: 2 }], topLevel: 2, palette: true, category: 'pente',
  },
  'slope-long': {
    id: 'slope-long', name: 'Longue rampe', model: 'city-kit-roads/road-slant-curve', footprint: [2, 1],
    connectors: [{ cell: [0, 0], side: 3, level: 0 }, { cell: [1, 0], side: 1, level: 2 }], topLevel: 2, palette: true, category: 'pente',
  },
  start: { id: 'start', name: 'Départ', model: 'city-kit-roads/road-straight', footprint: [1, 1], connectors: straightConn, topLevel: 0, gate: 'start', palette: true, category: 'spécial' },
  checkpoint: { id: 'checkpoint', name: 'Checkpoint', model: 'city-kit-roads/road-straight', footprint: [1, 1], connectors: straightConn, topLevel: 0, gate: 'checkpoint', palette: true, category: 'spécial' },
  finish: { id: 'finish', name: 'Arrivée', model: 'city-kit-roads/road-straight', footprint: [1, 1], connectors: straightConn, topLevel: 0, gate: 'finish', palette: true, category: 'spécial' },
};

export const PIECE_IDS = Object.keys(TRACK_PIECES);
