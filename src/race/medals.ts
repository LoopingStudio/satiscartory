import type { Medals } from '../track/TrackData';

export type Medal = 'author' | 'gold' | 'silver' | 'bronze';

export const MEDAL_ORDER: Medal[] = ['author', 'gold', 'silver', 'bronze'];

export const MEDAL_LABEL: Record<Medal, string> = {
  author: 'Auteur',
  gold: 'Or',
  silver: 'Argent',
  bronze: 'Bronze',
};

/** Medal thresholds derived from the author time (Trackmania-like ratios). */
export const MEDAL_RATIOS = { gold: 1.07, silver: 1.18, bronze: 1.5 } as const;

export function medalsFromAuthor(authorMs: number): Medals {
  const r = (k: number) => Math.ceil((authorMs * k) / 10) * 10;
  return { author: Math.round(authorMs), gold: r(MEDAL_RATIOS.gold), silver: r(MEDAL_RATIOS.silver), bronze: r(MEDAL_RATIOS.bronze) };
}

/** Best medal earned by a time, or null. */
export function medalFor(ms: number | null | undefined, medals: Medals | null): Medal | null {
  if (ms === null || ms === undefined || !medals) return null;
  for (const m of MEDAL_ORDER) if (ms <= medals[m]) return m;
  return null;
}
