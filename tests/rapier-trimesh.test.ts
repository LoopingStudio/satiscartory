import { describe, expect, it, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { readGlb, worldTriangles } from '../scripts/lib/glb.mjs';
import { TRACK_CELL } from '../src/config/constants';

beforeAll(async () => {
  await RAPIER.init();
});

describe('Rapier headless', () => {
  it('a box dropped on the road-straight trimesh comes to rest on the surface', () => {
    const { tris } = worldTriangles(readGlb('public/assets/kenney/city-kit-roads/road-straight.glb'));
    const vertices = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => [t.a, t.b, t.c].forEach((p, k) => p.forEach((v, j) => (vertices[i * 9 + k * 3 + j] = v * TRACK_CELL))));
    const indices = Uint32Array.from({ length: tris.length * 3 }, (_, i) => i);
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES));
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), body);
    for (let i = 0; i < 60 * 4; i++) world.step();
    const y = body.translation().y;
    expect(y).toBeGreaterThan(0.5);
    expect(y).toBeLessThan(0.5 + 0.03 * TRACK_CELL + 0.05);
    expect(Math.abs(body.linvel().y)).toBeLessThan(0.05);
    world.free();
  });
});
