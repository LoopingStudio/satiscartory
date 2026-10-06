import { describe, expect, it } from 'vitest';
import probe from '../src/data/generated/roadProbe.json';

type Edge = { cell: number[]; side: number; isRoad: boolean; roadY: number | null };
const pieces = (probe as unknown as { pieces: Record<string, { size: number[]; edges: Edge[] }> }).pieces;
const roadSides = (name: string) =>
  pieces[name]!.edges.filter((e) => e.isRoad).map((e) => ({ cell: e.cell.join(','), side: e.side, y: e.roadY }));

// Sides: 0 = +Z, 1 = +X, 2 = -Z, 3 = -X.
describe('connector probe (measured from the GLB files)', () => {
  it('road-straight runs along X at ground level', () => {
    const s = roadSides('road-straight');
    expect(s.map((e) => e.side).sort()).toEqual([1, 3]);
    for (const e of s) expect(e.y).toBeLessThan(0.03);
  });
  it('road-bend connects +Z and -X', () => {
    expect(roadSides('road-bend').map((e) => e.side).sort()).toEqual([0, 3]);
  });
  it('road-curve is 2x2 and connects cell(0,0) -X to cell(1,1) +Z', () => {
    expect(pieces['road-curve']!.size).toEqual([2, 2]);
    const s = roadSides('road-curve');
    expect(s).toContainEqual(expect.objectContaining({ cell: '0,0', side: 3 }));
    expect(s).toContainEqual(expect.objectContaining({ cell: '1,1', side: 0 }));
  });
  it('road-slant rises one level (0.25 tile) from -X to +X', () => {
    const s = roadSides('road-slant');
    const low = s.find((e) => e.side === 3)!;
    const high = s.find((e) => e.side === 1)!;
    expect(low.y!).toBeLessThan(0.03);
    expect(high.y! - low.y!).toBeCloseTo(0.25, 1);
  });
  it('road-slant-high rises two levels', () => {
    const s = roadSides('road-slant-high');
    expect(s.find((e) => e.side === 1)!.y! - s.find((e) => e.side === 3)!.y!).toBeCloseTo(0.5, 1);
  });
});
