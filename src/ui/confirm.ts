import { el, uiRoot } from './dom';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirm?: string;
  cancel?: string;
  /** Destructive: the confirm button is red and the pad starts on « cancel ». */
  danger?: boolean;
}

/**
 * In-page yes/no dialog (instead of window.confirm, which a gamepad cannot answer and which freezes the
 * game loop). Escape or a click on the backdrop cancels; the pad uses A / B (PadNav).
 */
/**
 * The key that answered stays held: its auto-repeat must not reach the game as a fresh press (Escape
 * would leave the track list, or reopen the editor's dialog). Its keyup goes through, so Input stays clean.
 */
function swallowUntilUp(code: string): void {
  const swallow = (e: KeyboardEvent) => {
    if (e.code !== code) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const done = (e?: Event) => {
    if (e instanceof KeyboardEvent && e.code !== code) return;
    window.removeEventListener('keydown', swallow, true);
    window.removeEventListener('keyup', done, true);
    window.removeEventListener('blur', done);
  };
  window.addEventListener('keydown', swallow, true);
  window.addEventListener('keyup', done, true);
  window.addEventListener('blur', done);
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      layer.remove();
      resolve(ok);
    };
    // Captured before Input sees it: Escape here only closes the dialog.
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // The key that opened it, still held and repeating, does not answer it.
      if (e.repeat) return;
      swallowUntilUp(e.code);
      finish(e.code !== 'Escape');
    };
    // Keyboard focus left on a button behind the dialog (Space, Enter) must not reach it.
    (document.activeElement as HTMLElement | null)?.blur?.();
    const yes = el('button', { class: opts.danger ? 'danger' : 'primary', onclick: () => finish(true), 'data-pad-default': !opts.danger }, opts.confirm ?? 'Oui');
    const no = el('button', { onclick: () => finish(false), 'data-pad-btn': 'b', 'data-pad-default': !!opts.danger }, opts.cancel ?? 'Annuler');
    const panel = el('div', { class: 'panel center confirm-panel', 'data-pad-scope': '' },
      opts.title ? el('h2', {}, opts.title) : null,
      el('p', {}, opts.message),
      el('div', { class: 'row', style: 'justify-content:flex-end' }, no, yes),
    );
    const layer = el('div', { class: 'ui-layer confirm-layer' }, panel);
    layer.addEventListener('click', (e) => e.target === layer && finish(false));
    window.addEventListener('keydown', onKey, true);
    uiRoot().appendChild(layer);
  });
}
