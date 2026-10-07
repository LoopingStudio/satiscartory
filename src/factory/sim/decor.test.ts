import { describe, expect, it } from 'vitest';
import { decorLayout } from './decor';
import { Terrain } from './terrain';
import { FACTORY_MAP } from '../../data/factoryMap';
import { TERRAINS } from '../../data/factoryTerrain';
import { FACTORY_CELL } from '../../config/constants';

const t = Terrain.create('vallonne-1', 128, 128, FACTORY_MAP.nodes);
const spawn = { x: FACTORY_MAP.spawn.x * FACTORY_CELL, z: FACTORY_MAP.spawn.z * FACTORY_CELL };
const plateau = TERRAINS['vallonne-1'].plateau;
const layout = decorLayout(t, FACTORY_MAP.nodes, spawn, plateau);
const solids = layout.items.filter((i) => i.solid);

describe('decor layout', () => {
  it('is the same every time, with forests, rocks, pebbles and far pines', () => {
    const again = decorLayout(t, FACTORY_MAP.nodes, spawn, plateau);
    expect(again.items).toEqual(layout.items);
    const count = (k: string) => layout.items.filter((i) => i.kind === k).length;
    expect(count('pine') + count('oak') + count('birch')).toBeGreaterThan(300);
    expect(count('rock')).toBeGreaterThan(20);
    expect(count('pebble')).toBeGreaterThan(200);
    expect(count('farPine')).toBeGreaterThan(300);
  });

  it('keeps the plateau, the nodes, the lake shore, the spawn and the cliff band clear of solid items', () => {
    const lake = t.lake!;
    for (const it of solids) {
      const dc = Math.hypot(it.x / FACTORY_CELL - plateau.x, it.z / FACTORY_CELL - plateau.z);
      expect(dc, `${it.kind}@${it.x},${it.z}`).toBeGreaterThanOrEqual(22);
      for (const n of FACTORY_MAP.nodes) {
        const inside = it.x > (n.x - 3) * FACTORY_CELL && it.x < (n.x + n.w + 3) * FACTORY_CELL && it.z > (n.z - 3) * FACTORY_CELL && it.z < (n.z + n.h + 3) * FACTORY_CELL;
        expect(inside, `${it.kind}@${it.x},${it.z}`).toBe(false);
      }
      expect(t.waterDepthAt(it.x, it.z)).toBe(0);
      const ex = (it.x / FACTORY_CELL - lake.x) / lake.rx;
      const ez = (it.z / FACTORY_CELL - lake.z) / lake.rz;
      if (ex * ex + ez * ez < 3.2) expect(t.heightAt(it.x, it.z)).toBeGreaterThanOrEqual(lake.level / 100 + 1.4);
      expect(Math.hypot(it.x - spawn.x, it.z - spawn.z)).toBeGreaterThanOrEqual(8);
      // In the grid: no step up the cliff band.
      expect(it.x).toBeGreaterThanOrEqual(0);
      expect(it.z).toBeGreaterThanOrEqual(0);
      expect(it.x).toBeLessThanOrEqual(256);
      expect(it.z).toBeLessThanOrEqual(256);
    }
  });

  it('indexes every cell a clear disc touches, both ways', () => {
    layout.items.forEach((it, i) => {
      for (const key of layout.cells[i]!) expect(layout.byCell.get(key)).toContain(i);
      if (!it.clear || it.x < 0 || it.z < 0 || it.x >= 256 || it.z >= 256) return;
      // The item's own cell is always among them.
      const own = Math.floor(it.x / FACTORY_CELL) + Math.floor(it.z / FACTORY_CELL) * 128;
      expect(layout.cells[i]).toContain(own);
    });
  });

  it('a flat map has no scenery', () => {
    expect(decorLayout(Terrain.flat(32, 32), [], spawn, plateau).items).toEqual([]);
  });
});
