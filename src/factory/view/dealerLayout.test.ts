import { describe, expect, it } from 'vitest';
import { DEALER_BOXES, DEALER_DISPLAY, DEALER_HATCHES, DEALER_SHOP, DEALER_SHOWROOM, DEALER_SIGN, DEALER_STORE_FRONT, DEALER_TOP, dealerBuild } from './dealerLayout';
import { rotateBox, type LayoutBox } from './garageLayout';
import { BUILDINGS } from '../../data/buildings';
import { BLUEPRINTS } from '../../data/blueprints';
import { BELT_TOP_Y } from './portMarkers';
import { CAR_SCALE, FACTORY_CELL } from '../../config/constants';
import { rotatedSize, type Rot } from '../sim/dirs';
import { buildComplete, buildLook } from '../../garage/build';
import type { CarConfig } from '../../data/sales';
import { readGlb, worldTriangles, nodeBoxes } from '../../../scripts/lib/glb.mjs';

const ROTS: Rot[] = [0, 1, 2, 3];
const KART: CarConfig = { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } };
const FULL: CarConfig = { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' } };

function overlaps(a: LayoutBox, b: LayoutBox, eps = 1e-9): boolean {
  return Math.abs(a.x - b.x) < a.hx + b.hx - eps && Math.abs(a.y - b.y) < a.hy + b.hy - eps && Math.abs(a.z - b.z) < a.hz + b.hz - eps;
}

/** Parts installed in a build. */
const installed = (f: number, car: CarConfig) => Object.values(dealerBuild(car, f).parts).reduce((n, p) => n + p.n, 0);

describe('dealer layout', () => {
  it('fits its 3 × 2 footprint, with a hatch in front of each of its three back inputs', () => {
    const [w, d] = BUILDINGS.dealer.footprint;
    expect([w, d]).toEqual([3, 2]);
    expect(2 * (DEALER_SHOP.halfW + 0.05)).toBeCloseTo(w * FACTORY_CELL, 9);
    expect(2 * (DEALER_SHOP.halfD + 0.05)).toBeCloseTo(d * FACTORY_CELL, 9);
    expect(BUILDINGS.dealer.ports.map((p) => [p.cell, p.side, p.dir])).toEqual([[[0, 0], 2, 'in'], [[1, 0], 2, 'in'], [[2, 0], 2, 'in']]);
    expect(DEALER_HATCHES.xs).toEqual([-2, 0, 2]);
    // A belt's items (on top of it) go in through the hatch; the hatches and their frames stay apart.
    expect(DEALER_HATCHES.bottom).toBeLessThan(BELT_TOP_Y - 0.3);
    expect(DEALER_HATCHES.top).toBeGreaterThan(BELT_TOP_Y + 0.5);
    const gap = DEALER_HATCHES.xs[1]! - DEALER_HATCHES.xs[0]! - 2 * (DEALER_HATCHES.halfW + DEALER_HATCHES.frame);
    expect(gap).toBeGreaterThan(0.2);
    expect(Math.abs(DEALER_HATCHES.xs[2]!) + DEALER_HATCHES.halfW + DEALER_HATCHES.frame).toBeLessThan(DEALER_SHOP.halfW);
  });

  it('its colliders stand on the floor inside the footprint at every rotation, never overlapping', () => {
    for (const r of ROTS) {
      const [rw, rh] = rotatedSize(DEALER_SHOP.halfW + 0.05, DEALER_SHOP.halfD + 0.05, r);
      const boxes = DEALER_BOXES.map((b) => rotateBox(b, r));
      for (const b of boxes) {
        expect(b.y - b.hy).toBeCloseTo(0, 9);
        expect(Math.abs(b.x) + b.hx).toBeLessThanOrEqual(rw);
        expect(Math.abs(b.z) + b.hz).toBeLessThanOrEqual(rh);
      }
      expect(overlaps(boxes[0]!, boxes[1]!)).toBe(false);
    }
    // The store block at the back is the tallest part; the sign stands on its roof.
    expect(DEALER_SHOP.height).toBeGreaterThan(DEALER_SHOP.glassTop);
    expect(DEALER_BOXES[0]!.y + DEALER_BOXES[0]!.hy).toBe(DEALER_SHOP.height);
    expect(DEALER_BOXES[1]!.y + DEALER_BOXES[1]!.hy).toBe(DEALER_SHOP.glassTop);
    expect(DEALER_SIGN.bottom).toBe(DEALER_SHOP.height);
    expect(DEALER_SIGN.z).toBeCloseTo(DEALER_BOXES[0]!.z, 9);
    expect(DEALER_TOP).toBeGreaterThan(DEALER_SIGN.top);
    expect(DEALER_STORE_FRONT).toBeCloseTo(-DEALER_SHOP.halfD + DEALER_SHOP.storeDepth, 9);
  });

  it('the showroom holds every buildable car, measured from its model', () => {
    for (const bp of Object.values(BLUEPRINTS)) {
      if (!bp.buildable) continue;
      const boxes = nodeBoxes(worldTriangles(readGlb(`public/assets/kenney/${bp.model}.glb`)).tris).filter((b) => b.name !== 'character');
      const min = [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]!)) * CAR_SCALE);
      const max = [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i]!)) * CAR_SCALE);
      // Racing wheels stick out of the kart a little (0.056 m a side); they stay inside the Sportive's body.
      min[0]! -= 0.06;
      max[0]! += 0.06;
      // Turned a quarter (yaw π/2): the car's length along X, its width along Z.
      expect(DEALER_DISPLAY.yaw).toBe(Math.PI / 2);
      const x0 = DEALER_DISPLAY.x + min[2]!;
      const x1 = DEALER_DISPLAY.x + max[2]!;
      const z0 = DEALER_DISPLAY.z - max[0]!;
      const z1 = DEALER_DISPLAY.z - min[0]!;
      const room = 0.25;
      expect(x0, bp.id).toBeGreaterThan(-DEALER_SHOWROOM.halfW + room);
      expect(x1, bp.id).toBeLessThan(DEALER_SHOWROOM.halfW - room);
      expect(z0, bp.id).toBeGreaterThan(DEALER_SHOWROOM.back + room);
      expect(z1, bp.id).toBeLessThan(DEALER_SHOWROOM.front - room);
      expect(DEALER_DISPLAY.y + max[1]!, bp.id).toBeLessThan(DEALER_SHOWROOM.top - 0.5);
    }
  });

  it('the car on show gets its parts one after the other, and is complete for the last step', () => {
    // Kart: chassis, engine, 4 wheels = 6 parts, 7 steps.
    const at = (k: number, car = KART, steps = 7) => dealerBuild(car, (k + 0.5) / steps);
    expect(buildLook(at(0))).toEqual({ body: 'ghost', wheels: 0, wheelItem: null, engine: false, spoiler: false });
    expect(at(1).parts).toEqual({ chassis: { item: 'chassis', n: 1 } });
    expect(buildLook(at(1)).body).toBe('solid');
    expect(buildLook(at(2)).engine).toBe(true);
    for (let k = 3; k <= 6; k++) expect(buildLook(at(k)).wheels).toBe(k - 2);
    expect(buildComplete(at(6))).toBe(true);
    // Full Sportive: 11 parts, 12 steps; bare metal until the 4th panel, the spoiler last.
    const looks = [...Array(12).keys()].map((k) => buildLook(at(k, FULL, 12)));
    expect(looks.map((l) => l.body)).toEqual(['ghost', 'bare', 'bare', 'bare', 'bare', 'bare', 'bare', 'bare', 'bare', 'bare', 'solid', 'solid']);
    expect(looks.map((l) => l.spoiler)).toEqual([...Array(11).fill(false), true]);
    expect(looks[6]!.wheelItem).toBe('wheel_racing');
    // Never goes back, clamped outside 0..1.
    for (const car of [KART, FULL]) {
      let last = 0;
      for (let f = 0; f <= 1.0001; f += 0.01) {
        const n = installed(f, car);
        expect(n).toBeGreaterThanOrEqual(last);
        last = n;
      }
      expect(installed(-1, car)).toBe(0);
      expect(buildComplete(dealerBuild(car, 2))).toBe(true);
    }
  });
});
