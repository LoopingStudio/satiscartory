import type { Side } from '../data/buildings';
import { TRACK_PIECES } from '../data/trackPieces';
import { DX, DZ, rotateCell, rotateSide, rotatedSize, type Rot } from '../factory/sim/dirs';
import type { TrackPiece } from './TrackData';

export interface WorldConnector {
  piece: number;
  cx: number;
  cz: number;
  side: Side;
  /** Absolute height level. */
  level: number;
}

export function pieceSize(p: TrackPiece): [number, number] {
  const def = TRACK_PIECES[p.t]!;
  return rotatedSize(def.footprint[0], def.footprint[1], p.r as Rot);
}

/** World cells covered by a piece. */
export function pieceCells(p: TrackPiece): [number, number][] {
  const [rw, rh] = pieceSize(p);
  const cells: [number, number][] = [];
  for (let dz = 0; dz < rh; dz++) for (let dx = 0; dx < rw; dx++) cells.push([p.x + dx, p.z + dz]);
  return cells;
}

export function pieceConnectors(p: TrackPiece, index: number): WorldConnector[] {
  const def = TRACK_PIECES[p.t]!;
  const [w, h] = def.footprint;
  return def.connectors.map((c) => {
    const [rx, rz] = rotateCell(c.cell[0], c.cell[1], p.r as Rot, w, h);
    return { piece: index, cx: p.x + rx, cz: p.z + rz, side: rotateSide(c.side, p.r as Rot), level: p.y + c.level };
  });
}

/** Key of the cell edge a connector faces, shared by the two connectors that link. */
export function edgeKey(cx: number, cz: number, side: Side, level: number): string {
  // Normalize to the cell on the -X/-Z side of the edge.
  if (side === 1) return `${cx},${cz},x,${level}`;
  if (side === 3) return `${cx - 1},${cz},x,${level}`;
  if (side === 0) return `${cx},${cz},z,${level}`;
  return `${cx},${cz - 1},z,${level}`;
}

/** The connector of a neighbor piece facing `c`, if the two match (same edge, opposite sides, same level). */
export function facingCell(c: WorldConnector): [number, number] {
  return [c.cx + DX[c.side], c.cz + DZ[c.side]];
}

/** Gate pieces cross the road at the tile center; their forward is local +X (side 1). */
export function gateForwardSide(p: TrackPiece): Side {
  return rotateSide(1, p.r as Rot);
}
