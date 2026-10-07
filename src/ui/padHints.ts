import { KEY_LABELS, PADBINDS, type Action, type PadProfile } from '../config/keybinds';
import type { PadButton, PadStyle } from '../core/gamepad';
import type { InputDevice } from '../core/Input';

/**
 * Key and pad-button labels for hints. A pad glyph is a styled <kbd> whose text comes from CSS
 * (body[data-pad] = xbox / ps / nintendo), so a hint built once follows the pad in use. Text rebuilt
 * every frame picks the device in use (keyFor); text built once carries both (dual, CSS-switched by
 * body.pad-input).
 */

/** Glyph of a pad button, or of a stick (`ls`, `rs`). */
export function padGlyph(b: PadButton | 'ls' | 'rs'): string {
  return `<kbd class="pad-btn pad-${b}"></kbd>`;
}

const TEXT: Record<PadStyle, Partial<Record<PadButton, string>>> = {
  xbox: { a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', view: 'View', start: 'Menu' },
  ps: { a: '✕', b: '○', x: '□', y: '△', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', view: 'Share', start: 'Options' },
  nintendo: { a: 'B', b: 'A', x: 'Y', y: 'X', lb: 'L', rb: 'R', lt: 'ZL', rt: 'ZR', view: '−', start: '+' },
};
const DPAD: Partial<Record<PadButton, string>> = { up: '↑', down: '↓', left: '←', right: '→', l3: 'L3', r3: 'R3' };

/** Plain-text name of a pad button (toasts, which are not HTML). */
export function padText(b: PadButton, style: PadStyle): string {
  return TEXT[style][b] ?? DPAD[b] ?? b;
}

export function keyCap(label: string): string {
  return `<kbd>${label}</kbd>`;
}

/** The (AZERTY) key of an action. */
export function keyLabel(action: Action): string {
  return keyCap(KEY_LABELS[action] ?? action);
}

/** The pad button of an action in a context ('' if it has none). */
export function padLabel(action: Action, profile: PadProfile): string {
  const b = PADBINDS[profile][action]?.[0];
  return b ? padGlyph(b) : '';
}

/** Keyboard and pad versions, each shown only while its device is in use. */
export function dual(kbm: string, pad: string): string {
  return `<span class="kbm-only">${kbm}</span><span class="pad-only">${pad}</span>`;
}

/** Both labels of an action (CSS-switched). */
export function dualKey(action: Action, profile: PadProfile): string {
  return dual(keyLabel(action), padLabel(action, profile) || keyLabel(action));
}

/** The label of an action for the device in use. */
export function keyFor(device: InputDevice, action: Action, profile: PadProfile): string {
  return device === 'pad' ? padLabel(action, profile) || keyLabel(action) : keyLabel(action);
}

/** HTML string → nodes, for el() children. */
export function html(markup: string): DocumentFragment {
  const t = document.createElement('template');
  t.innerHTML = markup;
  return t.content;
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Hint text with tokens, for static data (objectives): `{interact}` (any action) becomes its key and its
 * pad button; `{hotkeyN}` becomes « (touche N) » on the keyboard (the pad picks buildings with ◀ ▶);
 * `{click}` is « clic » or the pad's place trigger, `{hold}` « clic maintenu » or that trigger held.
 */
export function renderTokens(text: string, profile: PadProfile = 'foot'): string {
  return escape(text).replace(/\{(\w+)\}/g, (m, name: string) => {
    const hot = /^hotkey(\d)$/.exec(name);
    if (hot) return dual(`(touche ${hot[1]})`, `(${padGlyph('left')}${padGlyph('right')})`);
    if (name === 'click') return dual('clic', padGlyph('rt'));
    if (name === 'hold') return dual('clic maintenu', `${padGlyph('rt')} maintenu`);
    if (name in PADBINDS[profile] || name in KEY_LABELS) return dualKey(name as Action, profile);
    return m;
  });
}
