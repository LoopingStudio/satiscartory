/**
 * Player character customization (pure data): a name, a body color (the hooded suit), an accent color
 * (the creature's skin: face and tentacles) and a hat. Saved with the game and kept by « Nouvelle partie »,
 * like the settings.
 */

export interface ColorDef {
  id: string;
  name: string;
  /** sRGB hex. */
  hex: number;
}

export type HatId = 'none' | 'cap' | 'helmet' | 'beanie' | 'tophat' | 'crown' | 'cone';

export interface HatDef {
  id: HatId;
  name: string;
}

export interface CharacterLook {
  name: string;
  body: string;
  accent: string;
  hat: HatId;
}

/** The mascot's own colors come first: the default look is the model as Kenney made it. */
export const BODY_COLORS: ColorDef[] = [
  { id: 'white', name: 'Blanc', hex: 0xdcdce9 },
  { id: 'red', name: 'Rouge', hex: 0xe0524f },
  { id: 'orange', name: 'Orange', hex: 0xf09a3e },
  { id: 'yellow', name: 'Jaune', hex: 0xf2d04b },
  { id: 'green', name: 'Vert', hex: 0x6cc76a },
  { id: 'blue', name: 'Bleu', hex: 0x5a8ee6 },
  { id: 'purple', name: 'Violet', hex: 0x9a6ee0 },
  { id: 'pink', name: 'Rose', hex: 0xef8fc4 },
  { id: 'graphite', name: 'Graphite', hex: 0x585c70 },
];

export const ACCENT_COLORS: ColorDef[] = [
  { id: 'teal', name: 'Turquoise', hex: 0x4fa593 },
  { id: 'red', name: 'Rouge', hex: 0xd8433f },
  { id: 'orange', name: 'Orange', hex: 0xf08a2c },
  { id: 'yellow', name: 'Jaune', hex: 0xf2c53a },
  { id: 'blue', name: 'Bleu', hex: 0x3f78d8 },
  { id: 'purple', name: 'Violet', hex: 0x8a5ad6 },
  { id: 'pink', name: 'Rose', hex: 0xe56fb0 },
  { id: 'white', name: 'Blanc', hex: 0xeeeef4 },
  { id: 'black', name: 'Noir', hex: 0x2a2b36 },
];

export const HATS: HatDef[] = [
  { id: 'none', name: 'Aucun' },
  { id: 'cap', name: 'Casquette' },
  { id: 'helmet', name: 'Casque de chantier' },
  { id: 'beanie', name: 'Bonnet' },
  { id: 'tophat', name: 'Haut-de-forme' },
  { id: 'crown', name: 'Couronne' },
  { id: 'cone', name: 'Cône' },
];

export const NAME_MAX = 16;
export const DEFAULT_NAME = 'Oopi';

export const DEFAULT_LOOK: CharacterLook = { name: DEFAULT_NAME, body: 'white', accent: 'teal', hat: 'none' };

export function bodyColor(id: string): ColorDef {
  return BODY_COLORS.find((c) => c.id === id) ?? BODY_COLORS[0]!;
}

export function accentColor(id: string): ColorDef {
  return ACCENT_COLORS.find((c) => c.id === id) ?? ACCENT_COLORS[0]!;
}

/** A display name: printable characters only, spaces collapsed, at most NAME_MAX; empty → the default name. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_NAME;
  // Control characters out (a pasted name could carry line breaks or tabs).
  const s = [...raw.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('').trim();
  return s || DEFAULT_NAME;
}

/** A look from a save (or a shared code): unknown colors and hats fall back to the default ones. */
export function sanitizeLook(raw: unknown): CharacterLook {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof CharacterLook, unknown>>;
  return {
    name: cleanName(r.name),
    body: BODY_COLORS.some((c) => c.id === r.body) ? (r.body as string) : DEFAULT_LOOK.body,
    accent: ACCENT_COLORS.some((c) => c.id === r.accent) ? (r.accent as string) : DEFAULT_LOOK.accent,
    hat: HATS.some((h) => h.id === r.hat) ? (r.hat as HatId) : DEFAULT_LOOK.hat,
  };
}

/** A random look (« Au hasard »), keeping the name. `rng` returns [0, 1). */
export function randomLook(name: string, rng: () => number = Math.random): CharacterLook {
  const pick = <T>(list: T[]) => list[Math.floor(rng() * list.length) % list.length]!;
  return { name: cleanName(name), body: pick(BODY_COLORS).id, accent: pick(ACCENT_COLORS).id, hat: pick(HATS).id };
}
