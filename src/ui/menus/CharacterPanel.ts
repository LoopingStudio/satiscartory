import type { GameState } from '../../state/GameState';
import { SaveManager } from '../../state/SaveManager';
import { el } from '../dom';
import { html, padGlyph } from '../padHints';
import { ACCENT_COLORS, BODY_COLORS, HATS, NAME_MAX, cleanName, randomLook, type ColorDef } from '../../data/character';

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

/**
 * « Personnage » panel, docked on the right so the character stays visible on the left: name, body and
 * accent colors, hat. Every change is applied at once (`onChange`, for the 3D preview) and saved on close.
 */
export function openCharacterPanel(state: GameState, opts: { onChange?: () => void; onClose?: () => void } = {}): HTMLElement {
  const look = state.look;
  const changed = () => {
    render();
    opts.onChange?.();
  };

  const name = el('input', { type: 'text', maxlength: NAME_MAX, value: look.name, placeholder: 'Ton nom', class: 'character-name', spellcheck: 'false' }) as HTMLInputElement;
  name.addEventListener('input', () => {
    look.name = cleanName(name.value);
    opts.onChange?.();
  });
  // Commit the cleaned name when leaving the field (an empty one shows the default name again).
  name.addEventListener('change', () => (name.value = look.name));
  // Enter or Escape in the field: done typing (the game's keys work again).
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      name.blur();
    }
  });

  const swatches = el('div');
  const hats = el('div', { class: 'character-hats' });

  const swatchRow = (colors: ColorDef[], current: () => string, set: (id: string) => void) =>
    el('div', { class: 'character-swatches' },
      ...colors.map((c) =>
        el('button', {
          class: `swatch${current() === c.id ? ' selected' : ''}`,
          style: `--swatch:${hex(c.hex)}`,
          title: c.name,
          'aria-label': c.name,
          onclick: () => {
            set(c.id);
            changed();
          },
        }),
      ),
    );

  const render = () => {
    swatches.replaceChildren(
      el('h3', {}, 'Couleur de la combinaison'),
      swatchRow(BODY_COLORS, () => look.body, (id) => (look.body = id)),
      el('h3', {}, 'Couleur de la peau'),
      swatchRow(ACCENT_COLORS, () => look.accent, (id) => (look.accent = id)),
    );
    hats.replaceChildren(
      ...HATS.map((h) =>
        el('button', {
          class: `small${look.hat === h.id ? ' selected' : ''}`,
          onclick: () => {
            look.hat = h.id;
            changed();
          },
        }, h.name),
      ),
    );
  };
  render();

  const panel = el('div', { class: 'panel character-panel', 'data-pad-scope': '' },
    el('h2', {}, 'Personnage'),
    el('label', { class: 'row setting' }, el('span', {}, 'Nom'), el('span', { class: 'spacer' }), name),
    el('div', { class: 'muted small' }, 'Ton nom accompagne tes défis et les mondes que tu partages.'),
    swatches,
    el('h3', {}, 'Chapeau'),
    hats,
    el('div', { class: 'row', style: 'margin-top:14px' },
      el('button', {
        onclick: () => {
          Object.assign(look, randomLook(look.name));
          changed();
        },
      }, 'Au hasard'),
      el('span', { class: 'muted small pad-only' }, html(`${padGlyph('a')} choisir · ${padGlyph('b')} fermer`)),
      el('span', { class: 'spacer' }),
      el('button', { class: 'primary', onclick: () => close(), 'data-pad-btn': 'b start' }, 'Fermer'),
    ),
  );
  const layer = el('div', { class: 'ui-layer character-layer' }, panel);
  // Escape closes the panel (in the name field it only ends the typing, see above).
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (document.activeElement === name) name.blur();
    else close();
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey, true);
    look.name = cleanName(name.value);
    layer.remove();
    SaveManager.save(state);
    opts.onClose?.();
  };
  window.addEventListener('keydown', onKey, true);
  document.getElementById('ui-root')!.appendChild(layer);
  return panel;
}
