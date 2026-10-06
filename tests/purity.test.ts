import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Pure modules: gameplay logic that must stay testable in Node without rendering/physics.
const PURE = [
  'src/data',
  'src/factory/sim',
  'src/car/stats.ts',
  'src/car/tuning.ts',
  'src/garage/assembly.ts',
  'src/track/connectors.ts',
  'src/track/validate.ts',
  'src/track/TrackData.ts',
  'src/race/RaceSession.ts',
  'src/race/crossing.ts',
  'src/race/medals.ts',
];
const FORBIDDEN = /from\s+['"](three|three\/.*|@dimforge\/.*)['"]/;

function files(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((f) => files(join(path, f))).filter((f) => f.endsWith('.ts'));
}

describe('pure modules', () => {
  const all = PURE.flatMap(files);
  it.each(all.length ? all : ['<none yet>'])('%s does not import three or Rapier', (file) => {
    if (file === '<none yet>') return;
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(FORBIDDEN);
  });
});
