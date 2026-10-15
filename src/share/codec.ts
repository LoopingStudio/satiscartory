/*
 * Sharing without a server (pure: no three, no Rapier): a JSON payload, deflated (CompressionStream, in every browser
 * the game runs in and in Node), as base64url text: a code to paste, a link fragment (#defi=…, #monde=…) or a file.
 * Every code starts with a kind prefix and a version (« SC1D. » a challenge, « SC1M. » a world), so a code of the
 * wrong kind is refused with a clear message rather than garbage.
 */

export type ShareKind = 'defi' | 'monde';

const PREFIX: Record<ShareKind, string> = { defi: 'SC1D.', monde: 'SC1M.' };

/** Largest code accepted (a world with a big factory is a few hundred KB at most). */
export const MAX_CODE = 4_000_000;

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** JSON → deflate → base64url, with the kind's prefix. */
export async function encodeShare(kind: ShareKind, payload: unknown): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const packed = await pipe(json, new CompressionStream('deflate-raw'));
  return PREFIX[kind] + toBase64Url(packed);
}

/** The kind of a code (its prefix), null for anything else. Spaces and line breaks (a pasted code) are ignored. */
export function shareKindOf(code: string): ShareKind | null {
  const c = code.trim();
  return (Object.keys(PREFIX) as ShareKind[]).find((k) => c.startsWith(PREFIX[k])) ?? null;
}

/**
 * A code back to its JSON payload. Throws a French message for the player: wrong kind, cut or damaged code, too big.
 * A whole link works too (the code after « #defi= » or « #monde= »).
 */
export async function decodeShare(kind: ShareKind, input: string): Promise<unknown> {
  let code = input.trim();
  const hash = code.indexOf(`#${kind}=`);
  if (hash >= 0) code = code.slice(hash + kind.length + 2);
  code = code.replace(/\s+/g, '');
  if (code.length > MAX_CODE) throw new Error('Ce code est trop long');
  const other = shareKindOf(code);
  if (other && other !== kind) throw new Error(other === 'defi' ? 'C’est le code d’un défi, pas d’un monde' : 'C’est le code d’un monde, pas d’un défi');
  if (!code.startsWith(PREFIX[kind])) throw new Error(kind === 'defi' ? 'Ce n’est pas un code de défi Satiscartory' : 'Ce n’est pas un code de monde Satiscartory');
  try {
    const bytes = await pipe(fromBase64Url(code.slice(PREFIX[kind].length)), new DecompressionStream('deflate-raw'));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Code incomplet ou abîmé : recopie-le en entier');
  }
}

/** The link that opens a code in the game (the page's own address, the code in the fragment: never sent to a server). */
export function shareLink(kind: ShareKind, code: string, base: string): string {
  return `${base.split('#')[0]}#${kind}=${code}`;
}
