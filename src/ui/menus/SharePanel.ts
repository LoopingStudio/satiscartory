import { el, toast } from '../dom';
import { html, padGlyph } from '../padHints';
import { shareLink, type ShareKind } from '../../share/codec';

/** Modal layer shared by the share and import panels: Escape and a click outside close it. */
function modal(panel: HTMLElement, onClose?: () => void): () => void {
  const layer = el('div', { class: 'ui-layer settings-layer' }, panel);
  let closed = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey, true);
    layer.remove();
    onClose?.();
  };
  window.addEventListener('keydown', onKey, true);
  layer.addEventListener('click', (e) => e.target === layer && close());
  document.getElementById('ui-root')!.appendChild(layer);
  return close;
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copié : colle-le à ton ami`, 'success', 2200);
  } catch {
    toast('Copie refusée par le navigateur : sélectionne le code et copie-le à la main', 'error', 3000);
  }
}

/** Saves `text` as a file (the browser's download). */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = el('a', { href: url, download: fileName }) as HTMLAnchorElement;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * « Partager »: a code to send a friend, three ways: a link that opens it in the game (the code rides in the link's
 * fragment, never sent to a server), the code itself, or a file. Nothing is sent anywhere by the game.
 */
export function openSharePanel(opts: { kind: ShareKind; title: string; intro: string; code: string; fileName: string; onClose?: () => void }): void {
  const link = shareLink(opts.kind, opts.code, location.href);
  const area = el('textarea', { class: 'share-code', readonly: true, rows: 4, spellcheck: 'false' }, opts.code) as HTMLTextAreaElement;
  area.addEventListener('focus', () => area.select());
  const kb = Math.max(1, Math.round(opts.code.length / 1024));
  const panel = el('div', { class: 'panel center modal share-panel', 'data-pad-scope': '' },
    el('h2', {}, opts.title),
    el('div', { class: 'muted small' }, opts.intro),
    el('div', { class: 'row', style: 'margin-top:10px;flex-wrap:wrap;gap:6px' },
      el('button', { class: 'primary', 'data-action': 'copy-link', 'data-pad-default': true, onclick: () => void copy(link, 'Lien') }, 'Copier le lien'),
      el('button', { 'data-action': 'copy-code', onclick: () => void copy(opts.code, 'Code') }, 'Copier le code'),
      el('button', { 'data-action': 'download', onclick: () => downloadText(opts.fileName, opts.code) }, 'Télécharger le fichier'),
    ),
    el('div', { class: 'muted small', style: 'margin-top:8px' }, `Code (${kb} Ko) : ton ami le colle dans « Importer », ou ouvre le lien dans le jeu. Rien n’est envoyé sur Internet par le jeu.`),
    area,
    el('div', { class: 'row', style: 'margin-top:10px' },
      el('span', { class: 'muted small pad-only' }, html(`${padGlyph('b')} fermer`)),
      el('span', { class: 'spacer' }),
      el('button', { 'data-pad-btn': 'b', onclick: () => close() }, 'Fermer'),
    ),
  );
  const close = modal(panel, opts.onClose);
}

/**
 * « Importer »: paste a code or a link, or open a file. `onCode` decodes it; an error message (thrown) is shown and the
 * panel stays open, a success closes it.
 */
export function openImportPanel(opts: { title: string; intro: string; accept?: string; onCode: (code: string) => Promise<void>; onClose?: () => void }): void {
  const area = el('textarea', { class: 'share-code', rows: 5, spellcheck: 'false', placeholder: 'Colle ici le code ou le lien reçu' }) as HTMLTextAreaElement;
  const error = el('div', { class: 'bad small' });
  const file = el('input', { type: 'file', accept: opts.accept ?? '.satiscartory,.txt', style: 'display:none' }) as HTMLInputElement;
  let busy = false;
  const run = async (code: string) => {
    if (busy || !code.trim()) return;
    busy = true;
    error.textContent = '';
    try {
      await opts.onCode(code);
      close();
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  };
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (f) void f.text().then(run);
  });
  // Keys typed in the box are for the box (the game ignores them while a text field has the focus).
  const panel = el('div', { class: 'panel center modal share-panel', 'data-pad-scope': '' },
    el('h2', {}, opts.title),
    el('div', { class: 'muted small' }, opts.intro),
    area,
    error,
    el('div', { class: 'row', style: 'margin-top:10px;flex-wrap:wrap;gap:6px' },
      el('button', { class: 'primary', 'data-action': 'import', onclick: () => void run(area.value) }, 'Importer'),
      el('button', { 'data-action': 'open-file', onclick: () => file.click() }, 'Ouvrir un fichier…'),
      file,
      el('span', { class: 'spacer' }),
      el('button', { 'data-pad-btn': 'b', onclick: () => close() }, 'Fermer'),
    ),
  );
  const close = modal(panel, opts.onClose);
  area.focus();
}
