import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FactorySim } from '../src/factory/sim/FactorySim';
import { FactoryWorld } from '../src/factory/FactoryWorld';
import { Terrain } from '../src/factory/sim/terrain';
import { CharacterController } from '../src/player/CharacterController';
import { GRAVITY_FACTORY, PHYS_DT } from '../src/config/constants';
import { mulberry32 } from '../src/core/rng';
import { buildTerrainGeometry } from '../src/factory/view/terrain/TerrainMesh';

beforeAll(async () => {
  await RAPIER.init();
});

/** Ground hit straight down from high above (x, z), or null. */
function groundY(fw: FactoryWorld, x: number, z: number): number | null {
  const hit = fw.physics.world.castRay(new RAPIER.Ray({ x, y: 200, z }, { x: 0, y: -1, z: 0 }), 400, true, undefined, undefined, undefined, undefined, (c) => fw.isGround(c));
  return hit ? 200 - hit.timeOfImpact : null;
}

/** A 24×24 fixture (margin 4) rising `deg` degrees along +x from x = 8 cells, flat before. */
function rampSim(deg: number): FactorySim {
  const M = 4;
  const n = 24 + 2 * M + 1;
  const rise = Math.tan((deg * Math.PI) / 180) * 200; // cm per 2 m cell
  const cm: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) cm.push(Math.max(0, i - M - 8) * rise);
  return new FactorySim({ width: 24, height: 24, terrain: Terrain.fromHeights(24, 24, M, cm) });
}

describe('terrain heightfield', () => {
  it('matches terrain.heightAt everywhere (layout, orientation and triangle split)', () => {
    const sim = FactorySim.newGame({ terrain: 'vallonne-1' });
    const fw = new FactoryWorld(sim);
    fw.physics.step(0);
    const rng = mulberry32(5);
    for (let k = 0; k < 300; k++) {
      const x = -30 + rng() * 316;
      const z = -30 + rng() * 316;
      expect(groundY(fw, x, z), `${x},${z}`).toBeCloseTo(sim.terrain.heightAt(x, z), 3);
    }
    fw.dispose();
  });

  it('the rendered mesh is the same surface (same corners, same triangle split)', () => {
    const sim = FactorySim.newGame({ terrain: 'vallonne-1' });
    const mesh = new THREE.Mesh(buildTerrainGeometry(sim.terrain), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.updateMatrixWorld();
    const ray = new THREE.Raycaster();
    const rng = mulberry32(9);
    for (let k = 0; k < 300; k++) {
      const x = -30 + rng() * 316;
      const z = -30 + rng() * 316;
      ray.set(new THREE.Vector3(x, 200, z), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(mesh)[0];
      expect(hit, `${x},${z}`).toBeDefined();
      expect(hit!.point.y).toBeCloseTo(sim.terrain.heightAt(x, z), 3);
    }
  });

  it('keeps the flat slab for a flat terrain', () => {
    const fw = new FactoryWorld(new FactorySim({ width: 16, height: 16 }));
    fw.physics.step(0);
    expect(fw.ground.shape.type).toBe(RAPIER.ShapeType.Cuboid);
    expect(groundY(fw, 10, 10)).toBeCloseTo(0, 6);
    fw.dispose();
  });
});

describe('character controller on the relief', () => {
  it('a fall through the ground comes back on the surface (safety)', () => {
    const sim = rampSim(20);
    const fw = new FactoryWorld(sim);
    fw.physics.step(0);
    const safe = new THREE.Vector3(30, sim.terrain.heightAt(30, 20) + 0.5, 20);
    const cc = new CharacterController(fw.physics, new THREE.Vector3(30, -5, 20), { minY: sim.terrain.minY - 10, respawn: (_c, out) => out.copy(safe) });
    for (let s = 0; s < 120; s++) {
      cc.step(PHYS_DT, { dirX: 0, dirZ: 0, sprint: false, jump: false }, GRAVITY_FACTORY);
      fw.physics.step(PHYS_DT);
    }
    expect(cc.grounded).toBe(true);
    expect(cc.cur.y).toBeCloseTo(sim.terrain.heightAt(30, 20), 0);
    cc.dispose();
    fw.dispose();
  });

  function walk(sim: FactorySim, from: THREE.Vector3, dir: [number, number], sprint: boolean, seconds: number) {
    const fw = new FactoryWorld(sim);
    fw.physics.step(0);
    const cc = new CharacterController(fw.physics, from);
    let airborne = 0;
    for (let s = 0; s < seconds / PHYS_DT; s++) {
      cc.step(PHYS_DT, { dirX: dir[0], dirZ: dir[1], sprint, jump: false }, GRAVITY_FACTORY);
      fw.physics.step(PHYS_DT);
      if (s > 10 && !cc.grounded) airborne++;
    }
    const end = cc.cur.clone();
    cc.dispose();
    fw.dispose();
    return { end, airborne };
  }

  it.each([20, 35])('climbs a %i° slope', (deg) => {
    const { end } = walk(rampSim(deg), new THREE.Vector3(12, 0.1, 24), [1, 0], false, 4);
    expect(end.x).toBeGreaterThan(26);
    expect(end.y).toBeGreaterThan(Math.tan((deg * Math.PI) / 180) * (end.x - 16) - 0.3);
  });

  it.each([
    [25, false],
    [35, true],
  ] as const)('walks down a %i° slope along a lattice line without leaving the ground (sprint %s)', (deg, sprint) => {
    const sim = rampSim(deg);
    const top = sim.terrain.heightAt(44, 24);
    const { end, airborne } = walk(sim, new THREE.Vector3(44, top + 0.05, 24), [-1, 0], sprint, 2.5);
    expect(end.x).toBeLessThan(30);
    expect(airborne).toBe(0);
  });
});

describe('buildings on the relief (physics)', () => {
  /** Ray straight down at (x, z), first collider of any kind (buildings included). */
  function topY(fw: FactoryWorld, x: number, z: number, filter?: (c: RAPIER.Collider) => boolean): number | null {
    const hit = fw.physics.world.castRay(new RAPIER.Ray({ x, y: 50, z }, { x: 0, y: -1, z: 0 }), 100, true, undefined, undefined, undefined, undefined, filter);
    return hit ? 50 - hit.timeOfImpact : null;
  }

  it('a pad levels the heightfield (same collider), its belt rides from the port edge at pad + 0.8, removal gives the ground back', () => {
    const sim = rampSim(10);
    const fw = new FactoryWorld(sim);
    fw.physics.step(0);
    const handle = fw.ground.handle;
    const before = groundY(fw, 25, 21);
    const r = sim.place('smelter', 12, 10, 0, { free: true }); // cells (12..13, 10), outputs toward +Z
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const belt = sim.place('conveyor', 12, 11, 0, { free: true });
    expect(belt.ok).toBe(true);
    expect(fw.flush()).not.toBeNull();
    fw.physics.step(0);
    expect(fw.ground.handle).toBe(handle);
    const py = r.building.py! / 100;
    // The ground under the smelter is its pad.
    expect(groundY(fw, 25, 21)).toBeCloseTo(py, 3);
    expect(groundY(fw, 25, 21)).not.toBeCloseTo(before!, 1);
    // The belt's top at the middle of its back edge (the smelter's port) is the pad + 0.8 m.
    const isBeltCollider = (c: RAPIER.Collider) => fw.buildingOf(c) === (belt.ok ? belt.building.id : -1);
    expect(topY(fw, 25, 22.01, isBeltCollider)).toBeCloseTo(py + 0.8, 1);
    // Dismantling gives the natural ground back.
    sim.remove(belt.ok ? belt.building.id : -1);
    sim.remove(r.building.id);
    fw.flush();
    fw.physics.step(0);
    expect(groundY(fw, 25, 21)).toBeCloseTo(before!, 3);
    expect(fw.ground.handle).toBe(handle);
    fw.dispose();
  });

  it('padded colliders stand on their pad and reach under it', () => {
    const sim = rampSim(10);
    const fw = new FactoryWorld(sim);
    const r = sim.place('press', 14, 6, 0, { free: true });
    expect(r.ok).toBe(true);
    fw.flush();
    fw.physics.step(0);
    const py = r.ok ? r.building.py! / 100 : 0;
    // Top of the press: pad + 2.1 m.
    expect(topY(fw, 30, 13, (c) => !fw.isGround(c))).toBeCloseTo(py + 2.1, 2);
    fw.dispose();
  });
});
