import type { Game } from '../../core/Game';
import type { GameState } from '../../state/GameState';
import { SaveManager } from '../../state/SaveManager';
import { el } from '../dom';

/** Applies settings that live outside the modes (renderer). */
export function applySettings(game: Game, state: GameState): void {
  game.renderer.setShadows(state.settings.shadows);
}

/** Modal settings panel (sensitivity, invert Y, shadows). Calls `onClose` when dismissed. */
export function openSettings(game: Game, state: GameState, onClose?: () => void): HTMLElement {
  const s = state.settings;
  const sens = el('input', { type: 'range', min: 0.3, max: 3, step: 0.05, value: s.mouseSensitivity }) as HTMLInputElement;
  const sensVal = el('span', { class: 'mono' }, s.mouseSensitivity.toFixed(2));
  const invert = el('input', { type: 'checkbox' }) as HTMLInputElement;
  invert.checked = s.invertY;
  const shadows = el('input', { type: 'checkbox' }) as HTMLInputElement;
  shadows.checked = s.shadows;
  const panel = el('div', { class: 'panel center modal settings-panel' },
    el('h2', {}, 'Réglages'),
    el('label', { class: 'row setting' }, el('span', {}, 'Sensibilité de la souris'), el('span', { class: 'spacer' }), sens, sensVal),
    el('label', { class: 'row setting' }, el('span', {}, 'Inverser l’axe vertical'), el('span', { class: 'spacer' }), invert),
    el('label', { class: 'row setting' }, el('span', {}, 'Ombres'), el('span', { class: 'spacer' }), shadows),
    el('div', { class: 'muted small' }, 'Les touches suivent la position physique : ZQSD sur un clavier AZERTY, WASD en QWERTY.'),
    el('div', { class: 'row', style: 'margin-top:12px;justify-content:flex-end' },
      el('button', { class: 'primary', onclick: () => close() }, 'Fermer'),
    ),
  );
  sens.addEventListener('input', () => {
    s.mouseSensitivity = Number(sens.value);
    sensVal.textContent = s.mouseSensitivity.toFixed(2);
  });
  invert.addEventListener('change', () => (s.invertY = invert.checked));
  shadows.addEventListener('change', () => {
    s.shadows = shadows.checked;
    applySettings(game, state);
  });
  const close = () => {
    panel.remove();
    SaveManager.save(state);
    onClose?.();
  };
  document.getElementById('ui-root')!.appendChild(el('div', { class: 'ui-layer settings-layer' }, panel));
  panel.parentElement!.addEventListener('click', (e) => e.target === panel.parentElement && close());
  return panel;
}
