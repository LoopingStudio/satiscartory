import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { parseTrack } from '../../track/TrackData';
import { analyzeTrack } from '../../track/validate';

const files = readdirSync('src/data/tracks').filter((f) => f.endsWith('.json'));

describe('builtin tracks', () => {
  it.each(files)('%s is a valid, drivable track', (f) => {
    const t = parseTrack(JSON.parse(readFileSync(`src/data/tracks/${f}`, 'utf8')));
    const a = analyzeTrack(t);
    expect(a.issues).toEqual([]);
    expect(a.ok).toBe(true);
    expect(a.checkpoints.length).toBeGreaterThan(0);
  });
});
