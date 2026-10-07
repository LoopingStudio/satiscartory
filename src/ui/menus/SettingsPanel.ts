import type { Game } from '../../core/Game';
import type { GameState } from '../../state/GameState';
import { SaveManager } from '../../state/SaveManager';
import { el } from '../dom';
import { html, padGlyph } from '../padHints';

/** Applies settings that live outside the modes (renderer). */
export function applySettings(game: Game, state: GameState): void {
  game.renderer.setShadows(state.settings.shadows);
}

/** Modal settings panel (sensitivity, invert Y, shadows). Calls `onClose` when dismissed. */
export function openSettings(game: Game, state: GameState, onClose?: () => void): HTMLElement {
  const s = state.settings;
  const slider = (value: number, set: (v: number) => void) => {
    const input = el('input', { type: 'range', min: 0.3, max: 3, step: 0.05, value }) as HTMLInputElement;
    const label = el('span', { class: 'mono' }, value.toFixed(2));
    input.addEventListener('input', () => {
      set(Number(input.value));
      label.textContent = Number(input.value).toFixed(2);
    });
    return [input, label] as const;
  };
  const [sens, sensVal] = slider(s.mouseSensitivity, (v) => (s.mouseSensitivity = v));
  const [padSens, padSensVal] = slider(s.padSensitivity, (v) => (s.padSensitivity = v));
  // A pad user starts on the setting that concerns them.
  padSens.setAttribute('data-pad-default', '');
  const invert = el('input', { type: 'checkbox' }) as HTMLInputElement;
  invert.checked = s.invertY;
  const shadows = el('input', { type: 'checkbox' }) as HTMLInputElement;
  shadows.checked = s.shadows;
  const panel = el('div', { class: 'panel center modal settings-panel', 'data-pad-scope': '' },
    el('h2', {}, 'Réglages'),
    el('label', { class: 'row setting' }, el('span', {}, 'Sensibilité de la souris'), el('span', { class: 'spacer' }), sens, sensVal),
    el('label', { class: 'row setting' }, el('span', {}, 'Sensibilité de la manette'), el('span', { class: 'spacer' }), padSens, padSensVal),
    el('label', { class: 'row setting' }, el('span', {}, 'Inverser l’axe vertical'), el('span', { class: 'spacer' }), invert),
    el('label', { class: 'row setting' }, el('span', {}, 'Ombres'), el('span', { class: 'spacer' }), shadows),
    el('div', { class: 'muted small' }, 'Les touches suivent la position physique : ZQSD sur un clavier AZERTY, WASD en QWERTY. La manette (Xbox, PlayStation…) se branche à tout moment.'),
    el('div', { class: 'row', style: 'margin-top:12px' },
      // Pad: how to change a value.
      el('span', { class: 'muted small pad-only' }, html(`${padGlyph('left')}${padGlyph('right')} régler · ${padGlyph('a')} cocher · ${padGlyph('b')} fermer`)),
      el('span', { class: 'spacer' }),
      el('button', { class: 'primary', onclick: () => close(), 'data-pad-btn': 'b start' }, 'Fermer'),
    ),
  );
  invert.addEventListener('change', () => (s.invertY = invert.checked));
  shadows.addEventListener('change', () => {
    s.shadows = shadows.checked;
    applySettings(game, state);
  });
  const layer = el('div', { class: 'ui-layer settings-layer' }, panel);
  const close = () => {
    // The whole layer (its backdrop would otherwise stay over the menu and eat every click).
    layer.remove();
    SaveManager.save(state);
    onClose?.();
  };
  document.getElementById('ui-root')!.appendChild(layer);
  layer.addEventListener('click', (e) => e.target === layer && close());
  return panel;
}
