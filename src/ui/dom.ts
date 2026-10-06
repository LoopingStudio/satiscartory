type Attrs = Record<string, string | number | boolean | EventListener | undefined> & {
  class?: string;
  style?: string;
};
type Child = Node | string | number | null | undefined | false;

/** Tiny hyperscript helper: el('div', {class: 'x', onclick: fn}, 'text', child). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      node.className = String(v);
    } else if (v === true) {
      node.setAttribute(k, '');
    } else {
      node.setAttribute(k, String(v));
    }
  }
  append(node, ...children);
  return node;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function uiRoot(): HTMLElement {
  return document.getElementById('ui-root')!;
}

/** A layer inside #ui-root that is removed as a whole when the owning mode exits. */
export function createLayer(className = ''): HTMLElement {
  const layer = el('div', { class: `ui-layer ${className}` });
  uiRoot().appendChild(layer);
  return layer;
}

let toastTimer = 0;
export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info', ms = 2200): void {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div', { id: 'toast' });
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.className = `show ${kind}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('show'), ms);
}

export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '--:--.---';
  const neg = ms < 0;
  const abs = Math.abs(Math.round(ms));
  const m = Math.floor(abs / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  const milli = abs % 1000;
  return `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

export function formatDelta(ms: number): string {
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(ms));
  return `${sign}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, '0')}`;
}
