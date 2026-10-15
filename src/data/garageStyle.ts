/**
 * Look of a garage (pure data): the colour of its walls and the name on its sign. A garage of several places
 * (modules side by side, garage/groups.ts) shares them: setting them on one module sets the whole garage.
 */

export interface WallColor {
  id: string;
  name: string;
  /** sRGB hex. */
  hex: number;
}

/** Wall colours; the first one is the garage as it was (the kit's lavender grey). */
export const GARAGE_PAINTS: WallColor[] = [
  { id: 'lavender', name: 'Lavande', hex: 0x8585ab },
  { id: 'white', name: 'Blanc', hex: 0xd9d9e4 },
  { id: 'red', name: 'Rouge', hex: 0xb8504a },
  { id: 'orange', name: 'Orange', hex: 0xd6883e },
  { id: 'yellow', name: 'Jaune', hex: 0xd8b84a },
  { id: 'green', name: 'Vert', hex: 0x5f9e62 },
  { id: 'teal', name: 'Turquoise', hex: 0x4a9a93 },
  { id: 'blue', name: 'Bleu', hex: 0x4f73b8 },
  { id: 'graphite', name: 'Graphite', hex: 0x4d4f61 },
];

export const DEFAULT_WALL = GARAGE_PAINTS[0]!.id;
export const DEFAULT_SIGN = 'GARAGE';
/** The sign holds this many characters at most (3 m wide). */
export const SIGN_MAX = 14;

export function wallColor(id: string | undefined): WallColor {
  return GARAGE_PAINTS.find((c) => c.id === id) ?? GARAGE_PAINTS[0]!;
}

/** Sign text: printable characters only, spaces collapsed, in capitals, at most SIGN_MAX; empty → « GARAGE ». */
export function cleanSign(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_SIGN;
  const s = [...raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().toLocaleUpperCase('fr-FR')].slice(0, SIGN_MAX).join('').trim();
  return s || DEFAULT_SIGN;
}

/** A garage's look from save data: unknown colours and empty signs are dropped (the default look has no keys). */
export function sanitizeGarageLook(raw: { paint?: unknown; sign?: unknown }): { paint?: string; sign?: string } {
  const out: { paint?: string; sign?: string } = {};
  if (typeof raw.paint === 'string' && raw.paint !== DEFAULT_WALL && GARAGE_PAINTS.some((c) => c.id === raw.paint)) out.paint = raw.paint;
  if (typeof raw.sign === 'string') {
    const s = cleanSign(raw.sign);
    if (s !== DEFAULT_SIGN) out.sign = s;
  }
  return out;
}
