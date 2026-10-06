import { TRACK_PIECES } from '../data/trackPieces';
import { edgeKey, gateForwardSide, pieceCells, pieceConnectors, type WorldConnector } from './connectors';
import type { TrackData } from './TrackData';

export interface TrackIssue {
  level: 'error' | 'warning';
  code: 'noStart' | 'manyStarts' | 'noFinish' | 'overlap' | 'startBlocked' | 'finishUnreachable' | 'checkpointOffPath' | 'openEnd' | 'loopWithoutFinish';
  message: string;
  /** Indices of the pieces involved (for highlighting). */
  pieces: number[];
}

export interface TrackAnalysis {
  ok: boolean;
  issues: TrackIssue[];
  /** Piece indices from the start to the first finish reached (inclusive). */
  path: number[];
  start: number | null;
  finishes: number[];
  checkpoints: number[];
}

/**
 * Checks that a track is drivable: exactly one start, at least one finish,
 * no overlapping pieces, and a connected road from the start to a finish that
 * passes through every checkpoint.
 */
export function analyzeTrack(track: TrackData): TrackAnalysis {
  const issues: TrackIssue[] = [];
  const pieces = track.pieces;
  const starts: number[] = [];
  const finishes: number[] = [];
  const checkpoints: number[] = [];
  pieces.forEach((p, i) => {
    const gate = TRACK_PIECES[p.t]?.gate;
    if (gate === 'start') starts.push(i);
    if (gate === 'finish') finishes.push(i);
    if (gate === 'checkpoint') checkpoints.push(i);
  });
  if (starts.length === 0) issues.push({ level: 'error', code: 'noStart', message: 'Il faut un départ', pieces: [] });
  if (starts.length > 1) issues.push({ level: 'error', code: 'manyStarts', message: 'Un seul départ autorisé', pieces: starts });
  if (finishes.length === 0) issues.push({ level: 'error', code: 'noFinish', message: 'Il faut au moins une arrivée', pieces: [] });

  // 2D occupancy: one piece per cell.
  const owner = new Map<string, number>();
  const overlapping = new Set<number>();
  pieces.forEach((p, i) => {
    for (const [x, z] of pieceCells(p)) {
      const k = `${x},${z}`;
      const o = owner.get(k);
      if (o !== undefined) {
        overlapping.add(o);
        overlapping.add(i);
      } else owner.set(k, i);
    }
  });
  if (overlapping.size) issues.push({ level: 'error', code: 'overlap', message: 'Des pièces se chevauchent', pieces: [...overlapping] });

  // Connector graph: two connectors link when they face the same edge at the same level.
  const byEdge = new Map<string, WorldConnector[]>();
  const conns = pieces.map((p, i) => pieceConnectors(p, i));
  for (const list of conns) {
    for (const c of list) {
      const k = edgeKey(c.cx, c.cz, c.side, c.level);
      let arr = byEdge.get(k);
      if (!arr) byEdge.set(k, (arr = []));
      arr.push(c);
    }
  }
  const linkOf = (c: WorldConnector): WorldConnector | null => {
    const arr = byEdge.get(edgeKey(c.cx, c.cz, c.side, c.level)) ?? [];
    return arr.find((o) => o.piece !== c.piece && ((o.side + 2) & 3) === c.side) ?? null;
  };

  const path: number[] = [];
  const start = starts.length === 1 ? starts[0]! : null;
  if (start !== null) {
    const sp = pieces[start]!;
    const fwd = gateForwardSide(sp);
    let exit = conns[start]!.find((c) => c.side === fwd) ?? null;
    path.push(start);
    const visited = new Set<number>([start]);
    let reachedFinish = false;
    let current = start;
    if (!exit || !linkOf(exit)) {
      issues.push({ level: 'error', code: 'startBlocked', message: 'La sortie du départ ne mène à aucune route (tourne le départ avec R)', pieces: [start] });
    } else {
      while (exit) {
        const next = linkOf(exit);
        if (!next) {
          issues.push({ level: 'error', code: 'openEnd', message: 'La route s’arrête avant l’arrivée', pieces: [current] });
          break;
        }
        const pi = next.piece;
        if (visited.has(pi)) {
          issues.push({ level: 'error', code: 'loopWithoutFinish', message: 'La boucle revient au départ sans passer l’arrivée', pieces: [pi] });
          break;
        }
        visited.add(pi);
        path.push(pi);
        current = pi;
        if (TRACK_PIECES[pieces[pi]!.t]?.gate === 'finish') {
          reachedFinish = true;
          break;
        }
        // Leave through the other connector of this piece.
        exit = conns[pi]!.find((c) => c !== next) ?? null;
      }
    }
    if (!reachedFinish && finishes.length && !issues.some((i) => i.code === 'startBlocked')) {
      issues.push({ level: 'error', code: 'finishUnreachable', message: 'L’arrivée n’est pas reliée au départ', pieces: finishes });
    }
    if (reachedFinish) {
      const missed = checkpoints.filter((c) => !visited.has(c));
      if (missed.length) issues.push({ level: 'error', code: 'checkpointOffPath', message: 'Des checkpoints sont hors du parcours', pieces: missed });
    }
  }
  return { ok: !issues.some((i) => i.level === 'error'), issues, path, start, finishes, checkpoints };
}
