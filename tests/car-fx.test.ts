import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { fakeAssets } from './helpers/carAssets';
import { CAR_FX, CarFx, type ShockInfo } from '../src/car/CarFx';
import { CarModel } from '../src/car/CarModel';
import { CAR_SCALE } from '../src/config/constants';
import { recompileForShadows } from '../src/core/Renderer';
import { mulberry32 } from '../src/core/rng';
import type { CarSpec } from '../src/car/stats';

// Smoke of a worn engine and sparks of the shocks (CarFx) on fake assets: pooled, deterministic with a seeded random.

const KART: CarSpec = { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } };
const DT = 1 / 60;

function setup(seed = 7) {
  const scene = new THREE.Scene();
  const model = new CarModel(fakeAssets(), KART);
  scene.add(model.root);
  const fx = new CarFx(scene, mulberry32(seed));
  return { scene, model, fx, vel: new THREE.Vector3() };
}

const shock = (seq: number, permille: number, d: [number, number, number] = [0, 0, -1], cause = 'shock'): ShockInfo => ({ seq, cause, permille, dx: d[0], dy: d[1], dz: d[2] });
const at = (m: THREE.InstancedMesh, i: number) => new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(m.instanceMatrix.array, i * 16));

describe('car fx: engine smoke', () => {
  it('none up to 700 ‰, puffs above, more at full throttle; rising from the engine', () => {
    const { model, fx, vel } = setup();
    for (let i = 0; i < 60; i++) {
      fx.engine(DT, model, vel, 700, 1, 0);
      fx.update(DT);
    }
    expect(fx.smoke.count).toBe(0);
    expect(fx.smoke.visible).toBe(false);
    const puffs = (wear: number, throttle: number) => {
      const s = setup();
      for (let i = 0; i < 30; i++) {
        s.fx.engine(DT, s.model, s.vel, wear, throttle, 0);
        s.fx.update(DT);
      }
      return s.fx.smoke.count;
    };
    expect(puffs(760, 0)).toBeGreaterThan(0);
    expect(puffs(760, 1)).toBeGreaterThan(puffs(760, 0));
    expect(puffs(1000, 1)).toBeGreaterThan(puffs(760, 1));
    // Out of the engine anchor (car at the origin, facing +Z), then up.
    const s = setup();
    s.fx.engine(DT, s.model, s.vel, 1000, 1, 0);
    s.fx.update(DT);
    expect(s.fx.smoke.count).toBeGreaterThan(0);
    const p = at(s.fx.smoke, 0);
    expect(p.distanceTo(s.model.engineAnchor)).toBeLessThan(0.2);
    for (let i = 0; i < 20; i++) s.fx.update(DT);
    expect(at(s.fx.smoke, 0).y).toBeGreaterThan(p.y + 0.2);
  });

  it('pooled: 10 000 frames at the most never exceed the pool nor reallocate it; clear empties it', () => {
    const { model, fx, vel } = setup();
    const matrices = fx.smoke.instanceMatrix.array;
    const colors = fx.smoke.instanceColor!.array;
    vel.set(20, 0, 5);
    let most = 0;
    for (let i = 0; i < 10_000; i++) {
      model.root.position.set(i * 0.3, 0, 0);
      fx.engine(DT, model, vel, 1000, 1, 21);
      fx.update(DT);
      most = Math.max(most, fx.smoke.count);
      expect(fx.smoke.count).toBeLessThanOrEqual(CAR_FX.SMOKE_CAP);
    }
    expect(most).toBeGreaterThan(5);
    expect(fx.smoke.instanceMatrix.array).toBe(matrices);
    expect(fx.smoke.instanceColor!.array).toBe(colors);
    fx.clear();
    expect([fx.smoke.count, fx.sparks.count, fx.smoke.visible]).toEqual([0, 0, false]);
    fx.update(DT);
    expect(fx.smoke.count).toBe(0);
  });

  it('deterministic with the same random', () => {
    const run = () => {
      const s = setup(42);
      s.vel.set(3, 0, 8);
      for (let i = 0; i < 120; i++) {
        s.fx.engine(DT, s.model, s.vel, 900, i % 2, 9);
        if (i === 30) s.fx.afterStep(shock(1, 20, [0.6, 0, -0.8]), s.model.root.position, s.model.root.quaternion, s.model.geometry);
        s.fx.update(DT);
      }
      return [Array.from(s.fx.smoke.instanceMatrix.array), Array.from(s.fx.sparks.instanceMatrix.array), s.fx.smoke.count, s.fx.sparks.count];
    };
    expect(run()).toEqual(run());
  });
});

describe('car fx: shock sparks', () => {
  it('a new shock throws 6 to 32 sparks from the side it hit; old events, put-backs and empty shocks none', () => {
    const { model, fx } = setup();
    const pos = model.root.position;
    const quat = model.root.quaternion;
    const g = model.geometry;
    // An event seen when the meter was followed is past.
    fx.follow(shock(3, 50));
    fx.afterStep(shock(3, 50), pos, quat, g);
    fx.update(DT);
    expect(fx.sparks.count).toBe(0);
    fx.afterStep(shock(4, 40, [0, 0, 0], 'flip'), pos, quat, g);
    fx.afterStep(shock(5, 0), pos, quat, g);
    fx.update(DT);
    expect(fx.sparks.count).toBe(0);
    // Head-on (pushed backward): out of the front of the body.
    fx.afterStep(shock(6, 1), pos, quat, g);
    fx.update(1e-4);
    expect(fx.sparks.count).toBe(CAR_FX.SPARKS[0] + 1);
    const front = g.bodyMax[2] * CAR_SCALE;
    for (let i = 0; i < fx.sparks.count; i++) expect(at(fx.sparks, i).z).toBeGreaterThanOrEqual(front - 0.01);
    fx.clear();
    // A big one: at most 32. The same seq again: nothing more.
    fx.afterStep(shock(7, 300), pos, quat, g);
    fx.afterStep(shock(7, 300), pos, quat, g);
    fx.update(1e-4);
    expect(fx.sparks.count).toBe(CAR_FX.SPARKS[1]);
    // They fall and die out.
    const y0 = at(fx.sparks, 0).y;
    for (let i = 0; i < 40; i++) fx.update(DT);
    expect(fx.sparks.count).toBe(0);
    expect(fx.sparks.visible).toBe(false);
    expect(y0).toBeGreaterThan(0);
  });

  it('turns with the car: hit on its left side, the sparks start there in the world', () => {
    const { model, fx } = setup();
    model.root.position.set(10, 2, -4);
    model.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    // The car's left (+X local) faces world −Z at a quarter turn; pushed away from it: world +Z.
    fx.afterStep(shock(1, 10, [0, 0, 1]), model.root.position, model.root.quaternion, model.geometry);
    fx.update(1e-4);
    const left = model.geometry.bodyMax[0] * CAR_SCALE;
    for (let i = 0; i < fx.sparks.count; i++) expect(at(fx.sparks, i).z).toBeCloseTo(-4 - left, 1);
  });
});

describe('car fx: lifetime', () => {
  it('prewarm compiles both pools for the scene; dispose detaches and frees them, twice without harm', () => {
    const { scene, fx } = setup();
    const compiled: THREE.Object3D[] = [];
    const camera = new THREE.PerspectiveCamera();
    fx.prewarm({ compile: (o, c, target) => (compiled.push(o), expect([c, target]).toEqual([camera, scene]), new Set()) }, camera, scene);
    expect(compiled).toEqual([fx.smoke, fx.sparks]);
    expect(scene.getObjectByName('car-smoke')).toBe(fx.smoke);
    expect(scene.getObjectByName('car-sparks')).toBe(fx.sparks);
    const freed: string[] = [];
    for (const m of [fx.smoke, fx.sparks]) {
      m.geometry.addEventListener('dispose', () => freed.push(`${m.name} geometry`));
      (m.material as THREE.Material).addEventListener('dispose', () => freed.push(`${m.name} material`));
    }
    fx.dispose();
    expect(freed.sort()).toEqual(['car-smoke geometry', 'car-smoke material', 'car-sparks geometry', 'car-sparks material']);
    expect(scene.getObjectByName('car-smoke')).toBeUndefined();
    expect(scene.getObjectByName('car-sparks')).toBeUndefined();
    expect(() => fx.dispose()).not.toThrow();
    expect(freed).toHaveLength(4);
    // Once freed, nothing more happens.
    expect(() => {
      fx.update(DT);
      fx.clear();
    }).not.toThrow();
  });

  it('a shadows toggle compiles the hidden pools again at once, not at the first puff (recompileForShadows)', () => {
    const { scene, fx } = setup();
    const camera = new THREE.PerspectiveCamera();
    const pools = [fx.smoke, fx.sparks].map((m) => m.material as THREE.Material);
    const before = pools.map((m) => m.version);
    expect([fx.smoke.visible, fx.sparks.visible]).toEqual([false, false]);
    const calls: [THREE.Object3D, THREE.Camera][] = [];
    let flagged: number[] = [];
    recompileForShadows(
      {
        compile: (o, c) => {
          calls.push([o, c]);
          // Flagged before compiling: the programs built now are the ones drawn.
          flagged = pools.map((m) => m.version);
          return new Set();
        },
      },
      scene,
      camera,
    );
    // The whole scene (three's compile() goes through hidden objects, unlike a render), once.
    expect(calls).toEqual([[scene, camera]]);
    expect(flagged).toEqual(before.map((v) => v + 1));
    expect(pools.map((m) => m.version)).toEqual(flagged);
  });
});
