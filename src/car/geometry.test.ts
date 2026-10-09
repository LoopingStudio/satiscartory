import { describe, expect, it } from 'vitest';
import { readGlb, worldTriangles, nodeBoxes } from '../../scripts/lib/glb.mjs';
import { CAR_SCALE } from '../config/constants';
import { BLUEPRINTS } from '../data/blueprints';
import { carGeometryFromBoxes, contactPoint, engineAnchor, type CarGeometry } from './geometry';

const layout = (model: string): CarGeometry => carGeometryFromBoxes(nodeBoxes(worldTriangles(readGlb(`public/assets/kenney/${model}.glb`)).tris));
const KART = layout(BLUEPRINTS.kart.model);
const SPORT = layout(BLUEPRINTS.sport.model);
/** A 2 × 1 × 4 box (model units) with no wheels. */
const BOX: CarGeometry = { wheels: [], bodyMin: [-1, 0, -2], bodyMax: [1, 1, 2] };

describe('car geometry: engine smoke and shock points', () => {
  it('engineAnchor: the kart puffs over its rear axle just behind the seat, the Sportive through its hood', () => {
    const rear = KART.wheels.filter((w) => !w.front);
    const [x, y, z] = engineAnchor(KART, BLUEPRINTS.kart.engineMount, CAR_SCALE);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeGreaterThan(rear[0]!.center[1] * CAR_SCALE);
    expect(z).toBeLessThan(rear[0]!.center[2] * CAR_SCALE);
    // About (0 ; 0.64 ; −0.74) m.
    expect(y).toBeCloseTo(0.64, 1);
    expect(z).toBeCloseTo(-0.74, 1);

    const front = SPORT.wheels.filter((w) => w.front);
    const [sx, sy, sz] = engineAnchor(SPORT, BLUEPRINTS.sport.engineMount, CAR_SCALE);
    expect(sx).toBeCloseTo(0, 6);
    expect(sz).toBeCloseTo(front[0]!.center[2] * CAR_SCALE, 6);
    expect(sy).toBeGreaterThan(front[0]!.center[1] * CAR_SCALE);
    expect(sy).toBeLessThan(SPORT.bodyMax[1] * CAR_SCALE);
    // In model units without a scale; the middle of the body without wheels.
    expect(engineAnchor(KART, 'rear').map((v) => v * CAR_SCALE)).toEqual(engineAnchor(KART, 'rear', CAR_SCALE).map((v) => expect.closeTo(v, 9)));
    expect(engineAnchor(BOX, 'front', 2)).toEqual([0, 1, 0]);
  });

  it('contactPoint: the side of the box against the push, at mid-height', () => {
    const out = { x: 9, y: 9, z: 9 };
    // Pushed backward (hit head-on): the front face.
    expect(contactPoint(BOX, 0, -1, 2, out)).toBe(out);
    expect(out).toEqual({ x: 0, y: 1, z: 4 });
    // Pushed to the right (−X): hit on the left side (+X).
    expect(contactPoint(BOX, -3, 0, 1, out)).toEqual({ x: 1, y: 0.5, z: 0 });
    // Pushed forward: the rear.
    expect(contactPoint(BOX, 0, 0.2, 1, out)).toEqual({ x: 0, y: 0.5, z: -2 });
    // No push (or garbage): the middle.
    expect(contactPoint(BOX, 0, 0, 1, out)).toEqual({ x: 0, y: 0.5, z: 0 });
    expect(contactPoint(BOX, NaN, 1, 1, out)).toEqual({ x: 0, y: 0.5, z: 0 });
    // A corner stays on the box: pushed back-right at 45°, the front-left, on its first side reached (the left).
    contactPoint(BOX, -1, -1, 1, out);
    expect(out.x).toBeCloseTo(1, 12);
    expect(out.z).toBeCloseTo(1, 12);
    for (let a = 0; a < 2 * Math.PI; a += 0.1) {
      contactPoint(SPORT, Math.cos(a), Math.sin(a), CAR_SCALE, out);
      expect(out.x).toBeGreaterThanOrEqual(SPORT.bodyMin[0] * CAR_SCALE - 1e-9);
      expect(out.x).toBeLessThanOrEqual(SPORT.bodyMax[0] * CAR_SCALE + 1e-9);
      expect(out.z).toBeGreaterThanOrEqual(SPORT.bodyMin[2] * CAR_SCALE - 1e-9);
      expect(out.z).toBeLessThanOrEqual(SPORT.bodyMax[2] * CAR_SCALE + 1e-9);
      // On a side of the box.
      const onSide = Math.abs(Math.abs(out.x / CAR_SCALE - (SPORT.bodyMin[0] + SPORT.bodyMax[0]) / 2) - (SPORT.bodyMax[0] - SPORT.bodyMin[0]) / 2) < 1e-9 ||
        Math.abs(Math.abs(out.z / CAR_SCALE - (SPORT.bodyMin[2] + SPORT.bodyMax[2]) / 2) - (SPORT.bodyMax[2] - SPORT.bodyMin[2]) / 2) < 1e-9;
      expect(onSide).toBe(true);
    }
  });
});
