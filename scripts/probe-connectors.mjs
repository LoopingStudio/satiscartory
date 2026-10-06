// Connector probe: measures, for each road tile, the surface height and the
// drivable (asphalt) extent along each edge of each footprint cell.
// Output: src/data/generated/roadProbe.json (consumed by data/trackPieces tests)
// Run: node scripts/probe-connectors.mjs [--verbose]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlb, worldTriangles, castDown, readPng } from './lib/glb.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kit = join(root, 'public/assets/kenney/city-kit-roads');
const verbose = process.argv.includes('--verbose');
const png = readPng(join(kit, 'Textures/colormap.png'));

// Sides: 0 = +Z, 1 = +X, 2 = -Z, 3 = -X (rotation by +90° about Y maps side s -> s+1).
const SIDES = [
  { name: '+Z', n: [0, 1], t: [1, 0] },
  { name: '+X', n: [1, 0], t: [0, -1] },
  { name: '-Z', n: [0, -1], t: [-1, 0] },
  { name: '-X', n: [-1, 0], t: [0, 1] },
];

const PIECES = [
  'road-straight', 'road-straight-barrier', 'road-straight-half', 'road-end', 'road-end-round',
  'road-bend', 'road-bend-barrier', 'road-bend-square', 'road-curve', 'road-curve-barrier',
  'road-slant', 'road-slant-barrier', 'road-slant-high', 'road-slant-high-barrier',
  'road-slant-curve', 'road-slant-curve-barrier', 'road-slant-flat', 'road-slant-flat-high', 'road-slant-flat-curve',
  'road-bridge', 'road-crossroad', 'road-intersection', 'road-split', 'road-roundabout', 'tile-low',
];

const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');

const result = {};
for (const name of PIECES) {
  const { tris } = worldTriangles(readGlb(join(kit, `${name}.glb`)));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = -Infinity;
  for (const t of tris) for (const p of [t.a, t.b, t.c]) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
    maxY = Math.max(maxY, p[1]);
  }
  const cellsX = Math.round(maxX - minX), cellsZ = Math.round(maxZ - minZ);
  const edges = [];
  // iterate footprint cells (cell centers), probe outer edges only
  for (let cx = 0; cx < cellsX; cx++) {
    for (let cz = 0; cz < cellsZ; cz++) {
      const centerX = minX + cx + 0.5, centerZ = minZ + cz + 0.5;
      SIDES.forEach((s, si) => {
        const ex = centerX + s.n[0] * 0.5, ez = centerZ + s.n[1] * 0.5;
        const outer = ex < minX + 1e-3 || ex > maxX - 1e-3 || ez < minZ + 1e-3 || ez > maxZ - 1e-3;
        if (!outer) return;
        const samples = [];
        for (let i = -10; i <= 10; i++) {
          const off = i * 0.05;
          const px = ex - s.n[0] * 0.01 + s.t[0] * off * 0.98;
          const pz = ez - s.n[1] * 0.01 + s.t[1] * off * 0.98;
          const hit = castDown(tris, px, pz);
          if (!hit) { samples.push({ off, y: null }); continue; }
          const col = png.sample(hit.uv[0], hit.uv[1]);
          samples.push({ off, y: +hit.y.toFixed(3), col: hex(col), lum: Math.round(lum(col)) });
        }
        const center = samples[10];
        edges.push({ cell: [cx, cz], side: si, sideName: s.name, centerY: center.y, centerCol: center.col, samples });
      });
    }
  }
  result[name] = { size: [cellsX, cellsZ], min: [+minX.toFixed(3), +minZ.toFixed(3)], maxY: +maxY.toFixed(3), edges };
}

// Asphalt, gutters and lane markings are darker than sidewalks (lum ~198).
const ROAD_LUM = 170;
const asphalt = 'lum<' + ROAD_LUM;
for (const [name, r] of Object.entries(result)) {
  for (const e of r.edges) {
    const road = e.samples.filter((s) => s.y !== null && s.lum < ROAD_LUM);
    e.isRoad = road.length >= 5;
    e.roadWidth = road.length ? +(road[road.length - 1].off - road[0].off + 0.05).toFixed(2) : 0;
    e.roadY = road.length ? road[Math.floor(road.length / 2)].y : null;
    if (!verbose) delete e.samples;
  }
  const summary = r.edges.filter((e) => e.isRoad).map((e) => `cell${JSON.stringify(e.cell)} ${e.sideName} y=${e.roadY} w=${e.roadWidth}`);
  console.log(`${name.padEnd(28)} size=${r.size.join('x')} maxY=${r.maxY}  ${summary.join(' | ')}`);
}
mkdirSync(join(root, 'src/data/generated'), { recursive: true });
writeFileSync(join(root, 'src/data/generated/roadProbe.json'), JSON.stringify({ asphalt, pieces: result }, null, verbose ? 2 : 0));
console.log(`road = ${asphalt}; written src/data/generated/roadProbe.json`);
