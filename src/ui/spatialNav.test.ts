import { describe, expect, it } from 'vitest';
import { firstInReadingOrder, nearestTo, pickInDirection, type NavRect } from './spatialNav';

const r = (x: number, y: number, w = 50, h = 50): NavRect => ({ x, y, w, h });

describe('pickInDirection', () => {
  // 3×3 grid of 50 px cells, 10 px apart.
  const grid = [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => r(col * 60, row * 60)));
  const at = (row: number, col: number) => grid[row * 3 + col]!;

  it('moves to the neighbor in a grid and stops at the edges', () => {
    expect(pickInDirection(at(1, 1), grid, 'right')).toBe(grid.indexOf(at(1, 2)));
    expect(pickInDirection(at(1, 1), grid, 'left')).toBe(grid.indexOf(at(1, 0)));
    expect(pickInDirection(at(1, 1), grid, 'up')).toBe(grid.indexOf(at(0, 1)));
    expect(pickInDirection(at(1, 1), grid, 'down')).toBe(grid.indexOf(at(2, 1)));
    expect(pickInDirection(at(0, 0), grid, 'up')).toBe(-1);
    expect(pickInDirection(at(2, 2), grid, 'right')).toBe(-1);
  });

  it('prefers the same row or column over a closer diagonal', () => {
    const from = r(0, 0);
    const sameRowFar = r(300, 10);
    const diagonalNear = r(70, 80);
    expect(pickInDirection(from, [from, diagonalNear, sameRowFar], 'right')).toBe(2);
  });

  it('goes from a column to the nearest row of another column', () => {
    // A tall left list beside a right list: right goes to the row level with the source.
    const left = [r(0, 0, 100, 30), r(0, 40, 100, 30), r(0, 80, 100, 30)];
    const right = [r(200, 0, 100, 30), r(200, 40, 100, 30), r(200, 80, 100, 30)];
    const all = [...left, ...right];
    expect(pickInDirection(left[2]!, all, 'right')).toBe(5);
    expect(pickInDirection(right[0]!, all, 'left')).toBe(0);
  });

  it('reaches a wide footer button under a row of small ones', () => {
    const row = [r(0, 0), r(60, 0), r(120, 0)];
    const footer = r(0, 100, 170, 30);
    expect(pickInDirection(row[2]!, [...row, footer], 'down')).toBe(3);
    // And back up to the row (the closest one along the axis, overlapping).
    expect(pickInDirection(footer, [...row, footer], 'up')).not.toBe(-1);
  });

  it('goes down to a small control on the next row rather than an aligned one far below', () => {
    // A settings panel: a slider, a checkbox at the end of the next row, the close button at the bottom.
    const slider = r(250, 0, 150, 20);
    const checkbox = r(425, 32, 14, 14);
    const close = r(360, 140, 80, 30);
    expect(pickInDirection(slider, [slider, checkbox, close], 'down')).toBe(1);
    // An aligned control just below still wins over a misaligned one further away.
    const below = r(300, 40, 60, 20);
    expect(pickInDirection(slider, [slider, checkbox, close, below], 'down')).toBe(3);
  });

  it('goes down to the aligned row rather than another column level with the source', () => {
    const src = r(0, 100, 200, 40);
    const below = r(0, 200, 200, 40); // the next row, after a section header
    const side = r(220, 130, 100, 40); // the other column, straddling the source's bottom edge
    expect(pickInDirection(src, [src, below, side], 'down')).toBe(1);
  });

  it('ignores sub-pixel offsets of aligned controls', () => {
    // A button on the row above, its left edge 0.4 px to the right: not « to the right ».
    const star = r(719.05, 474, 174, 36);
    const above = r(719.45, 398, 191, 30);
    expect(pickInDirection(star, [star, above], 'right')).toBe(-1);
    expect(pickInDirection(star, [star, above], 'up')).toBe(1);
  });

  it('skips candidates that are not ahead', () => {
    const from = r(100, 100);
    const overlapping = r(110, 90, 50, 70); // centered to the right but overlapping the source
    expect(pickInDirection(from, [from, overlapping], 'left')).toBe(-1);
    expect(pickInDirection(from, [from, overlapping], 'right')).toBe(1);
  });
});

describe('nearestTo / firstInReadingOrder', () => {
  it('finds the closest center and the top-left element', () => {
    const cands = [r(200, 0), r(0, 100), r(0, 0, 40, 40), r(100, 2)];
    expect(nearestTo(10, 110, cands)).toBe(1);
    expect(firstInReadingOrder(cands)).toBe(2);
    expect(firstInReadingOrder([])).toBe(-1);
    expect(nearestTo(0, 0, [])).toBe(-1);
    // Same row (vertical spans overlap): leftmost wins even if slightly lower.
    expect(firstInReadingOrder([r(100, 0), r(0, 5)])).toBe(1);
  });
});
