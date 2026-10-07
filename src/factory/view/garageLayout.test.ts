import { describe, expect, it } from 'vitest';
import { GARAGE, GARAGE_BAY, GARAGE_CLUTTER, GARAGE_DOOR, GARAGE_INNER, GARAGE_LINTEL, GARAGE_WALLS, rotateBox, type LayoutBox } from './garageLayout';
import { rotateLocal } from './beltPath';
import { BUILDINGS } from '../../data/buildings';
import { PLAYER } from '../../data/player';
import { FACTORY_CELL, GRAVITY_FACTORY } from '../../config/constants';
import { DX, DZ, rotateSide, rotatedSize, type Rot } from '../sim/dirs';
import { GARAGE_DOOR_SIDE, bayPose } from '../../garage/parking';

const ROTS: Rot[] = [0, 1, 2, 3];
/** Largest car (sport chassis) and the kart with its seated driver (meters). */
const SPORT = { w: 1.91, l: 3.88 };
const KART_DRIVER_HEIGHT = 2.13;

function overlaps(a: LayoutBox, b: LayoutBox, eps = 1e-9): boolean {
  return Math.abs(a.x - b.x) < a.hx + b.hx - eps && Math.abs(a.y - b.y) < a.hy + b.hy - eps && Math.abs(a.z - b.z) < a.hz + b.hz - eps;
}

describe('garage layout', () => {
  it('matches the footprint, and the door is the local +Z side (parking GARAGE_DOOR_SIDE)', () => {
    const [w, h] = BUILDINGS.garage.footprint;
    expect(GARAGE.halfW * 2).toBe(w * FACTORY_CELL);
    expect(GARAGE.halfD * 2).toBe(h * FACTORY_CELL);
    expect(GARAGE_DOOR_SIDE).toBe(0);
  });

  it('walls and lintel are thin, inside the footprint, never overlapping each other', () => {
    for (const r of ROTS) {
      const [rw, rh] = rotatedSize(GARAGE.halfW, GARAGE.halfD, r);
      const walls = [...GARAGE_WALLS, GARAGE_LINTEL].map((b) => rotateBox(b, r));
      for (const b of walls) {
        expect(Math.min(b.hx, b.hz) * 2).toBeLessThanOrEqual(0.35);
        expect(Math.abs(b.x) + b.hx).toBeLessThanOrEqual(rw);
        expect(Math.abs(b.z) + b.hz).toBeLessThanOrEqual(rh);
        expect(b.y + b.hy).toBe(GARAGE.height);
      }
      for (const b of walls.slice(0, GARAGE_WALLS.length)) expect(b.y - b.hy).toBe(0);
      for (let i = 0; i < walls.length; i++) for (let j = i + 1; j < walls.length; j++) expect(overlaps(walls[i]!, walls[j]!)).toBe(false);
    }
  });

  it('walls cannot be climbed from the ground, a conveyor laid along them or the clutter', () => {
    const jump = PLAYER.JUMP_SPEED ** 2 / (2 * -GRAVITY_FACTORY);
    // Rapier's autostep also works in the air: jump + step, from the 0.8 m conveyor collider.
    expect(GARAGE.height).toBeGreaterThan(0.8 + jump + PLAYER.STEP_HEIGHT + 0.1);
    for (const b of GARAGE_WALLS) expect(b.y + b.hy).toBe(GARAGE.height);
    for (const c of Object.values(GARAGE_CLUTTER)) expect(c.y + c.hy + jump + PLAYER.STEP_HEIGHT).toBeLessThan(GARAGE.height);
  });

  it('the clutter stands on the floor inside the walls, clear of the walls and of the bay', () => {
    const bay: LayoutBox = { x: 0, y: 1, z: 0, hx: GARAGE_BAY.halfW + 0.3, hy: 1, hz: GARAGE_BAY.halfD + 0.3 };
    for (const c of Object.values(GARAGE_CLUTTER)) {
      expect(c.y - c.hy).toBe(0);
      expect(Math.abs(c.x) + c.hx).toBeLessThanOrEqual(GARAGE_INNER.halfW);
      expect(c.z - c.hz).toBeGreaterThanOrEqual(GARAGE_INNER.back);
      expect(overlaps(c, bay)).toBe(false);
      for (const w of GARAGE_WALLS) expect(overlaps(c, w)).toBe(false);
    }
  });

  it('the front is open over the whole inner width and lets every car through', () => {
    const door: LayoutBox = { x: 0, y: GARAGE_DOOR.height / 2, z: GARAGE_DOOR.z - GARAGE.wall / 2, hx: GARAGE_DOOR.halfWidth, hy: GARAGE_DOOR.height / 2, hz: GARAGE.wall / 2 };
    for (const b of [...GARAGE_WALLS, GARAGE_LINTEL]) expect(overlaps(b, door)).toBe(false);
    expect(GARAGE_LINTEL.y - GARAGE_LINTEL.hy).toBe(GARAGE_DOOR.height);
    expect(GARAGE_LINTEL.hx).toBe(GARAGE_DOOR.halfWidth);
    expect(GARAGE_DOOR.halfWidth).toBe(GARAGE_INNER.halfW);
    expect(GARAGE_DOOR.halfWidth * 2).toBeGreaterThan(SPORT.w + 2);
    expect(GARAGE_DOOR.height).toBeGreaterThan(KART_DRIVER_HEIGHT + 0.3);
    expect(GARAGE_DOOR.height).toBeLessThan(GARAGE.height);
  });

  it('the painted bay holds the sport car and is clear of the walls', () => {
    expect(GARAGE_BAY.halfW * 2).toBeGreaterThan(SPORT.w + 0.4);
    expect(GARAGE_BAY.halfD * 2).toBeGreaterThan(SPORT.l + 0.4);
    const bay: LayoutBox = { x: 0, y: 1, z: 0, hx: GARAGE_BAY.halfW, hy: 1, hz: GARAGE_BAY.halfD };
    for (const b of GARAGE_WALLS) expect(overlaps(b, bay)).toBe(false);
    expect(GARAGE_BAY.halfW).toBeLessThan(GARAGE_INNER.halfW);
    expect(-GARAGE_BAY.halfD).toBeGreaterThan(GARAGE_INNER.back);
  });

  it('rotateBox turns boxes like rotateLocal turns points', () => {
    const box: LayoutBox = { x: 1.2, y: 0.5, z: -2.3, hx: 0.4, hy: 0.5, hz: 1.1 };
    for (const r of ROTS) {
      const rb = rotateBox(box, r);
      const p = { x: 0, z: 0 };
      const xs: number[] = [];
      const zs: number[] = [];
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        rotateLocal(box.x + sx! * box.hx, box.z + sz! * box.hz, r, p);
        xs.push(p.x);
        zs.push(p.z);
      }
      expect(rb.x - rb.hx).toBeCloseTo(Math.min(...xs), 9);
      expect(rb.x + rb.hx).toBeCloseTo(Math.max(...xs), 9);
      expect(rb.z - rb.hz).toBeCloseTo(Math.min(...zs), 9);
      expect(rb.z + rb.hz).toBeCloseTo(Math.max(...zs), 9);
      expect(rb.y).toBe(box.y);
    }
  });

  it('the bay pose stands at the layout origin and faces the door for every rotation', () => {
    for (const r of ROTS) {
      const g = { x: 10, z: 20, rot: r };
      const pose = bayPose(g);
      const [rw, rh] = rotatedSize(...BUILDINGS.garage.footprint, r);
      expect(pose.x).toBeCloseTo((g.x + rw / 2) * FACTORY_CELL, 9);
      expect(pose.z).toBeCloseTo((g.z + rh / 2) * FACTORY_CELL, 9);
      // Local +Z (the open side) turned like the building faces the same way as the car.
      const door = { x: 0, z: 0 };
      rotateLocal(0, 1, r, door);
      const side = rotateSide(GARAGE_DOOR_SIDE, r);
      expect(door.x).toBeCloseTo(DX[side], 9);
      expect(door.z).toBeCloseTo(DZ[side], 9);
      expect(Math.sin(pose.yaw)).toBeCloseTo(door.x, 9);
      expect(Math.cos(pose.yaw)).toBeCloseTo(door.z, 9);
    }
  });
});
