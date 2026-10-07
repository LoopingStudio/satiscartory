import { describe, expect, it } from 'vitest';
import { GRAVITY_FACTORY, GRAVITY_RACE, PLAYER_RADIUS } from '../../config/constants';
import type { CarGeometry } from '../../car/geometry';
import { tuningFromStats } from '../../car/tuning';
import { computeCarStats } from '../../car/stats';
import { SPEED_CAP_KNEE, speedCapForce } from '../../vehicle/speedCap';
import {
  CAR_GRAVITY_SCALE, FACTORY_CAR, boxOverlapsRect, carBox, carModelKey, distanceToBox, exitCandidates, insideMap,
  keepInside, poseOf, samePose, toLocal, toWorld, upYOfQuat, yawOfQuat, type CarBox,
} from './carMath';

const yawQuat = (yaw: number) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
/** 2 × 4 m car centered on its origin. */
const BOX: CarBox = { minX: -1, maxX: 1, minY: 0, maxY: 1.5, minZ: -2, maxZ: 2 };

describe('car frames', () => {
  it('yaw 0 faces +Z, local +X is the car left = world +X; toWorld inverts toLocal', () => {
    const p = { x: 10, y: 0, z: 20, yaw: 0 };
    expect(toWorld(p, 0, 1)).toEqual({ x: 10, z: 21 });
    expect(toWorld(p, 1, 0)).toEqual({ x: 11, z: 20 });
    const q = { x: 3, y: 0, z: -4, yaw: 0.7 };
    const w = toWorld(q, 1.3, -2.1);
    const l = toLocal(q, w.x, w.z);
    expect(l.x).toBeCloseTo(1.3, 9);
    expect(l.z).toBeCloseTo(-2.1, 9);
  });

  it('forward at yaw θ is (sin θ, cos θ), like Vehicle spawns', () => {
    const f = toWorld({ x: 0, y: 0, z: 0, yaw: Math.PI / 2 }, 0, 1);
    expect(f.x).toBeCloseTo(1, 9);
    expect(f.z).toBeCloseTo(0, 9);
  });

  it('yawOfQuat / upYOfQuat read a rotation back', () => {
    for (const yaw of [0, 0.5, -2, 3]) expect(yawOfQuat(yawQuat(yaw))).toBeCloseTo(yaw, 9);
    expect(upYOfQuat(yawQuat(1.2))).toBeCloseTo(1, 9);
    // Upside-down (180° around Z).
    expect(upYOfQuat({ x: 0, y: 0, z: 1, w: 0 })).toBeCloseTo(-1, 9);
  });
});

describe('car box and reach', () => {
  it('carBox spans the body and the wheels (scaled), from the ground up', () => {
    const g: CarGeometry = {
      bodyMin: [-0.4, 0.1, -0.5],
      bodyMax: [0.4, 0.7, 0.8],
      wheels: [{ name: 'wheel-front-left', center: [0.45, 0.2, 0.6], radius: 0.2, front: true, left: true }],
    };
    const b = carBox(g, 2);
    expect(b.minX).toBeCloseTo(-0.8);
    expect(b.maxX).toBeCloseTo((0.45 + 0.1) * 2); // half a radius across the wheel
    expect(b.minY).toBe(0);
    expect(b.maxY).toBeCloseTo(1.4);
    expect(b.maxZ).toBeCloseTo(1.6); // wheel front edge 0.8 = body front
    expect(b.minZ).toBeCloseTo(-1);
  });

  it('distanceToBox is 0 inside, measured to the nearest face of the rotated box', () => {
    const p = { x: 0, y: 0, z: 0, yaw: Math.PI / 2 }; // facing +X: the 4 m length lies along X
    expect(distanceToBox(p, BOX, 0.5, 0.5)).toBe(0);
    expect(distanceToBox(p, BOX, 3, 0)).toBeCloseTo(1, 9); // past the front (local z = 2)
    expect(distanceToBox(p, BOX, 0, 3)).toBeCloseTo(2, 9); // beside it (local x = -3, half width 1)
    expect(distanceToBox(p, BOX, 5, 4)).toBeCloseTo(Math.hypot(3, 3), 9); // corner
  });

  it('boxOverlapsRect: separating axes on the rotated footprint', () => {
    const p = { x: 0, y: 0, z: 0, yaw: Math.PI / 4 };
    expect(boxOverlapsRect(p, BOX, -0.5, -0.5, 0.5, 0.5)).toBe(true);
    // Inside the rotated box's AABB but off its diagonal: free.
    expect(boxOverlapsRect(p, BOX, 1.6, -2.4, 2.4, -1.6)).toBe(false);
    expect(boxOverlapsRect({ ...p, yaw: 0 }, BOX, 1, -1, 3, 1)).toBe(false); // touching the side
    expect(boxOverlapsRect({ ...p, yaw: 0 }, BOX, 0.9, -1, 3, 1)).toBe(true);
  });
});

describe('exit spot candidates', () => {
  it('left of the seat first, then right, behind, in front, then the same farther away', () => {
    const p = { x: 50, y: 0, z: 50, yaw: 0 };
    const c = exitCandidates(p, BOX);
    const off = PLAYER_RADIUS + FACTORY_CAR.EXIT_GAP;
    expect(c).toHaveLength(8);
    const expected = [[50 + 1 + off, 50], [50 - 1 - off, 50], [50, 50 - 2 - off], [50, 50 + 2 + off]];
    expected.forEach(([x, z], i) => {
      expect(c[i]!.x).toBeCloseTo(x!, 9);
      expect(c[i]!.z).toBeCloseTo(z!, 9);
    });
    expect(c[4]!.x).toBeGreaterThan(c[0]!.x);
    // Every candidate leaves the capsule clear of the box.
    for (const q of c) expect(distanceToBox(p, BOX, q.x, q.z)).toBeGreaterThanOrEqual(PLAYER_RADIUS + FACTORY_CAR.EXIT_GAP - 1e-9);
  });

  it('follows the car heading (left of a car facing +X is world -Z)', () => {
    const c = exitCandidates({ x: 0, y: 0, z: 0, yaw: Math.PI / 2 }, BOX);
    expect(c[0]!.x).toBeCloseTo(0, 9);
    expect(c[0]!.z).toBeLessThan(-1);
  });
});

describe('map limits', () => {
  it('keepInside: untouched far from the edges, slowed toward a near edge, pushed back past it', () => {
    const m = FACTORY_CAR.MAP_MARGIN;
    const k = FACTORY_CAR.MAP_PUSH;
    expect(keepInside(100, -25, 256)).toBe(-25);
    expect(keepInside(100, 25, 256)).toBe(25);
    expect(keepInside(m + 2, -20, 256)).toBeCloseTo(-2 * k, 9); // 2 m left: at most 2k toward the edge
    expect(keepInside(m + 2, 20, 256)).toBe(20); // driving away is free
    expect(keepInside(m - 1, -20, 256)).toBeCloseTo(k, 9); // past it: pushed back
    expect(keepInside(256 - m + 2, 15, 256)).toBeCloseTo(-2 * k, 9);
  });

  it('keepInside never lets a car cross the edge, whatever its speed', () => {
    let x = 40;
    for (let i = 0; i < 600; i++) x += keepInside(x, -FACTORY_CAR.SPEED_CAP, 256) / 60;
    expect(x).toBeGreaterThan(FACTORY_CAR.MAP_MARGIN - 1e-6);
    expect(x).toBeLessThan(FACTORY_CAR.MAP_MARGIN + 0.1);
  });

  it('insideMap with a margin (negative = grown)', () => {
    expect(insideMap(1, 1, 10, 10)).toBe(true);
    expect(insideMap(1, 1, 10, 10, 2)).toBe(false);
    expect(insideMap(-3, 5, 10, 10, -4)).toBe(true);
  });
});

describe('physics settings', () => {
  it('a car body in the factory weighs what it weighs in the race', () => {
    expect(GRAVITY_FACTORY * CAR_GRAVITY_SCALE).toBeCloseTo(GRAVITY_RACE, 9);
  });

  it('speed cap: no force up to the knee, engine force balanced exactly at the cap', () => {
    const t = tuningFromStats(computeCarStats({ blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' } }));
    const cap = FACTORY_CAR.SPEED_CAP;
    expect(speedCapForce(t, cap, cap * SPEED_CAP_KNEE)).toBe(0);
    expect(speedCapForce(t, cap, 5)).toBe(0);
    const atCap = speedCapForce(t, cap, cap);
    expect(atCap + t.dragK * cap * cap + t.rollingK * cap).toBeCloseTo(t.engineN, 6);
    expect(speedCapForce(t, cap, cap + 5)).toBeGreaterThan(atCap);
    // A car slower than the cap is left alone.
    expect(speedCapForce({ engineN: 100, dragK: 1, rollingK: 1 }, cap, cap)).toBe(0);
  });
});

describe('pose persistence', () => {
  it('poseOf keeps x/z, the floor height and the heading', () => {
    const p = poseOf({ x: 4, z: -7 }, yawQuat(-1.1), 0.05);
    expect(p.x).toBe(4);
    expect(p.z).toBe(-7);
    expect(p.y).toBe(0.05);
    expect(p.yaw).toBeCloseTo(-1.1, 9);
    expect(samePose(p, { ...p, yaw: p.yaw + 1e-6 })).toBe(true);
    expect(samePose(p, { ...p, x: p.x + 0.01 })).toBe(false);
  });

  it('a pose survives a save round trip (JSON)', () => {
    const p = poseOf({ x: 123.456, z: 78.9 }, yawQuat(2.5), 0.02);
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it('carModelKey changes with the parts, not with their order', () => {
    const a = carModelKey({ blueprint: 'kart', parts: { chassis: 'chassis', wheels: 'wheel' } });
    expect(carModelKey({ blueprint: 'kart', parts: { wheels: 'wheel', chassis: 'chassis' } })).toBe(a);
    expect(carModelKey({ blueprint: 'kart', parts: { chassis: 'chassis', wheels: 'wheel_racing' } })).not.toBe(a);
    expect(carModelKey({ blueprint: 'sport', parts: { chassis: 'chassis', wheels: 'wheel' } })).not.toBe(a);
  });
});
