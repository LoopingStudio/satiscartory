import type { Input } from '../core/Input';
import { NavRepeat, PAD_BUTTONS, navDirection, type NavDir } from '../core/gamepad';
import { firstInReadingOrder, nearestTo, pickInDirection, type NavRect } from './spatialNav';

/**
 * Menus with the gamepad. The topmost visible `[data-pad-scope]` element owns the pad (gameplay then reads
 * nothing from it): the D-pad or the left stick moves a virtual focus (class `pad-focus`) between its
 * controls by screen position, A clicks the focused one, the right stick scrolls. Markup hooks:
 * - `data-pad-scope`: a menu, panel or dialog (the last visible one in document order wins);
 * - `data-pad-btn="b y"`: clicked by those pad buttons (B = back/close; `data-pad-prio` breaks ties, else
 *   the last one in document order);
 * - `data-pad-tab`: LB/RB cycle through these (the current one has class `selected`);
 * - `data-pad-focus`: focusable although not a button (e.g. an empty backpack slot);
 * - `data-pad-default`: focused first when the scope opens (else the primary button, the selected one…);
 * - `data-pad-autofocus`: takes the focus when the focused control disappears (e.g. the « Annuler » of a
 *   confirmation that replaced the button that asked for it);
 * - `data-pad-hold`: A sends pointerdown on press and pointerup on release (hold-to-craft);
 * - `data-pad-skip`: never focused; `title` / `data-pad-tip`: shown under the focused control;
 * - `data-pad-passive` (on a scope): opened by the game, not by the player (the race's finish panel): its
 *   first press only shows the focus, however recent the last press (a handbrake tap must not retry).
 * Range inputs and selects take left/right as a value change. A scope can also take over buttons with
 * setPadHandlers (e.g. moving backpack slots).
 */

/** Per-scope handlers; returning true means handled (the default action is skipped). */
export interface PadHandlers {
  a?(focus: HTMLElement | null): boolean;
  b?(focus: HTMLElement | null): boolean;
  x?(focus: HTMLElement | null): boolean;
  y?(focus: HTMLElement | null): boolean;
  lb?(focus: HTMLElement | null): boolean;
  rb?(focus: HTMLElement | null): boolean;
  start?(focus: HTMLElement | null): boolean;
  view?(focus: HTMLElement | null): boolean;
}
type HandledButton = keyof PadHandlers;

const handlers = new WeakMap<HTMLElement, PadHandlers>();

export function setPadHandlers(scope: HTMLElement, h: PadHandlers): void {
  handlers.set(scope, h);
}

const CANDIDATES = 'button, [data-pad-focus], input[type="range"], input[type="checkbox"], select';
const BUTTONS: Exclude<HandledButton, 'a'>[] = ['b', 'x', 'y', 'lb', 'rb', 'start', 'view'];
/** Classes that change with state: not part of an element's identity across re-renders. */
const STATE_CLASSES = new Set(['selected', 'active', 'focus', 'pad-focus', 'poor', 'drop-target', 'drag-source', 'bump', 'draggable', 'empty', 'lacking', 'pad-carry']);
const SCROLL_SPEED = 900;
/** A scope that appears this soon after a pad press was opened by it: its focus shows (and acts) at once. */
const OPENED_BY_PAD_MS = 350;
/** Presses that open menus (not the triggers and stick clicks of driving and walking). */
const MENU_BUTTONS = PAD_BUTTONS.filter((b) => b !== 'lt' && b !== 'rt' && b !== 'l3' && b !== 'r3');

function visible(el: Element): boolean {
  return el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function disabled(el: Element): boolean {
  return (el as HTMLButtonElement).disabled === true;
}

function rectOf(el: Element): NavRect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Identity of a control across re-renders: its data attributes, else its tag, classes and text. */
function keyOf(el: HTMLElement): string {
  if (el.dataset.padKey) return el.dataset.padKey;
  const data = Object.entries(el.dataset).filter(([k]) => !k.startsWith('pad')).map(([k, v]) => `${k}=${v}`).join(',');
  if (data) return `${el.tagName}|${data}`;
  const cls = [...el.classList].filter((c) => !STATE_CLASSES.has(c)).sort().join('.');
  // Counts change all the time (« Prendre (3) »): digits are not identity.
  const text = (el.textContent ?? '').replace(/[\d\s]+/g, ' ').trim().slice(0, 48);
  return `${el.tagName}|${cls}|${text}`;
}

export class PadNav {
  private scope: HTMLElement | null = null;
  private focus: HTMLElement | null = null;
  private lastKey = '';
  private lastCenter: { x: number; y: number } | null = null;
  private readonly repeat = new NavRepeat();
  /** A `[data-pad-hold]` control pressed with A (released with A). */
  private hold: HTMLElement | null = null;
  private holdKey = '';
  private readonly tip: HTMLElement;
  private lastNow = 0;
  private lastPressAt = -Infinity;
  /**
   * The pad user sees the focus ring: a press acts. Otherwise the first press only shows it: after the
   * keyboard or the mouse, and in a scope the game opened by itself (the race's finish panel), where a
   * handbrake or respawn tap must not click « Réessayer » or « Circuits ».
   */
  private revealed = false;
  /** Where the focus was in a scope covered by another one (settings over the pause menu, a confirm…). */
  private readonly covered = new WeakMap<HTMLElement, { key: string; center: { x: number; y: number } | null }>();
  /** Re-renders put the focus back at once (before the frame is drawn: no blinking ring, no lost press). */
  private readonly observer = new MutationObserver(() => {
    const scope = this.scope;
    if (scope && this.focus && !this.focus.isConnected && scope.isConnected && this.input.device === 'pad') this.restore(scope);
  });

  constructor(private readonly input: Input) {
    this.tip = document.createElement('div');
    this.tip.className = 'pad-tip';
    document.body.appendChild(this.tip);
  }

  /** The control the pad points at (null without an active menu). */
  get focused(): HTMLElement | null {
    return this.focus;
  }

  /** Call once per frame, after Input.poll() and before the fixed steps. */
  update(now: number): void {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    if (MENU_BUTTONS.some((b) => this.input.pad.pressed(b))) this.lastPressAt = now;
    const scope = this.findScope();
    if (scope !== this.scope) this.enter(scope, now);
    this.input.setPadOwned(!!scope);
    if (!scope || this.input.device !== 'pad') {
      // Keyboard and mouse: keep the remembered control, but never scroll or hover for them.
      this.tip.classList.remove('show');
      this.endHold();
      this.setRevealed(false);
      return;
    }
    const gate = this.input.navPad;
    if (!this.focus || !this.isCandidate(this.focus, scope)) this.restore(scope);
    if (this.hold) {
      if (!gate.isDown('a')) this.endHold();
      else if (!this.hold.isConnected && this.focus && keyOf(this.focus) === this.holdKey) {
        // Re-rendered while held (the bench re-renders after each item): the hold goes on.
        this.hold = this.focus;
      } else if (this.hold !== this.focus) this.endHold();
    }

    const dir = this.repeat.update(navDirection(gate, this.repeat.current), now);
    const pressed = !!dir || gate.pressed('a') || BUTTONS.some((b) => gate.pressed(b));
    // Presses that act on the focused control (B, Start, View, LB/RB act on the scope).
    const onFocus = !!dir || gate.pressed('a') || gate.pressed('x') || gate.pressed('y');
    const hidden = this.focus ? this.hiddenBy(this.focus, scope) : null;
    if (pressed && !this.revealed) this.setRevealed(true);
    else if (onFocus && hidden) {
      // A focus scrolled away comes back to what is visible first.
      const back = this.nearestVisible(hidden, scope);
      if (back && back !== this.focus) this.setFocus(back);
      else this.focus?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else if (pressed) {
      if (dir && this.focus) this.step(dir, scope);
      if (gate.pressed('a')) this.activate(scope);
      for (const b of BUTTONS) if (gate.pressed(b)) this.press(b, scope);
    }

    const rs = gate.stick('right');
    if (rs.y) this.scroll(rs.y * SCROLL_SPEED * dt, scope);

    const shown = this.revealed && this.focus?.isConnected && !this.hiddenBy(this.focus, scope);
    if (this.focus?.isConnected) {
      const r = this.remember(this.focus);
      if (shown) this.updateTip(r);
      else this.tip.classList.remove('show');
    } else this.tip.classList.remove('show');
  }

  private setRevealed(on: boolean): void {
    this.revealed = on;
    this.focus?.classList.toggle('pad-focus', on);
  }

  /** The scrolling container that hides `el` (scrolled out of its visible area), or null. */
  private hiddenBy(el: HTMLElement, scope: HTMLElement): HTMLElement | null {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.scrollHeight > p.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(p).overflowY)) {
        const c = p.getBoundingClientRect();
        if (cy < c.top || cy > c.bottom || cx < c.left || cx > c.right) return p;
      }
      if (p === scope) break;
    }
    return null;
  }

  /** The control of `container` closest to the focus among those in view. */
  private nearestVisible(container: HTMLElement, scope: HTMLElement): HTMLElement | undefined {
    const inside = this.candidates(scope).filter((c) => container.contains(c) && !this.hiddenBy(c, scope));
    if (!inside.length || !this.lastCenter) return inside[0];
    return inside[nearestTo(this.lastCenter.x, this.lastCenter.y, inside.map(rectOf))];
  }

  /** Identity and position of the focused control, to find it again after a re-render. */
  private remember(el: HTMLElement): DOMRect {
    const r = el.getBoundingClientRect();
    this.lastKey = keyOf(el);
    this.lastCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    return r;
  }

  private findScope(): HTMLElement | null {
    const all = document.querySelectorAll<HTMLElement>('[data-pad-scope]');
    for (let i = all.length - 1; i >= 0; i--) if (visible(all[i]!)) return all[i]!;
    return null;
  }

  private enter(scope: HTMLElement | null, now: number): void {
    this.endHold();
    // Covered, not closed (settings over the pause menu): its focus comes back when it is on top again.
    if (this.scope && this.focus && visible(this.scope)) this.covered.set(this.scope, { key: this.lastKey, center: this.lastCenter });
    this.setFocus(null);
    this.observer.disconnect();
    this.scope = scope;
    const back = scope ? this.covered.get(scope) : undefined;
    if (scope) this.covered.delete(scope);
    this.lastKey = back?.key ?? '';
    this.lastCenter = back?.center ?? null;
    // Shown at once when the player opened it with the pad, or comes back to it.
    const byPad = !scope?.hasAttribute('data-pad-passive') && now - this.lastPressAt < OPENED_BY_PAD_MS;
    this.revealed = (!!back || byPad) && this.input.device === 'pad';
    if (scope) this.observer.observe(scope, { childList: true, subtree: true });
    // What was held to open it (a stick turning the camera, the button that opened it) does nothing here.
    this.input.navPad.blockHeld();
    this.repeat.hold(null);
  }

  private candidates(scope: HTMLElement): HTMLElement[] {
    return [...scope.querySelectorAll<HTMLElement>(CANDIDATES)].filter((el) => !el.closest('[data-pad-skip]') && el.getClientRects().length > 0);
  }

  private isCandidate(el: HTMLElement, scope: HTMLElement): boolean {
    return el.isConnected && scope.contains(el) && el.matches(CANDIDATES) && !el.closest('[data-pad-skip]') && el.getClientRects().length > 0;
  }

  /**
   * Focus lost (re-render, the control went away): the same control again, else a control asking for the
   * focus, else the nearest, else the default.
   */
  private restore(scope: HTMLElement): void {
    const cands = this.candidates(scope);
    if (!cands.length) return this.setFocus(null);
    let pick: HTMLElement | undefined;
    if (this.lastKey) {
      const same = cands.filter((c) => keyOf(c) === this.lastKey);
      if (same.length === 1 || (same.length && !this.lastCenter)) pick = same[0];
      else if (same.length) pick = same[nearestTo(this.lastCenter!.x, this.lastCenter!.y, same.map(rectOf))];
    }
    // The same control re-rendered keeps the list where the player scrolled it (no scrollIntoView).
    const same = !!pick;
    pick ??= cands.find((c) => c.hasAttribute('data-pad-autofocus') && !disabled(c));
    if (!pick && this.lastCenter) pick = cands[nearestTo(this.lastCenter.x, this.lastCenter.y, cands.map(rectOf))];
    pick ??= this.defaultOf(cands);
    this.setFocus(pick ?? null, !same);
  }

  private defaultOf(cands: HTMLElement[]): HTMLElement | undefined {
    const enabled = cands.filter((c) => !disabled(c));
    // Not « Fermer » (often the topmost control): a first A must not close what just opened.
    const content = enabled.filter((c) => !c.matches('[data-pad-btn~="b"]'));
    return (
      enabled.find((c) => c.hasAttribute('data-pad-default')) ??
      enabled.find((c) => c.classList.contains('primary')) ??
      enabled.find((c) => c.classList.contains('selected')) ??
      content[firstInReadingOrder(content.map(rectOf))] ??
      enabled[firstInReadingOrder(enabled.map(rectOf))] ??
      cands[firstInReadingOrder(cands.map(rectOf))]
    );
  }

  private setFocus(el: HTMLElement | null, scroll = true): void {
    if (el === this.focus) {
      el?.classList.toggle('pad-focus', this.revealed);
      return;
    }
    const prev = this.focus;
    if (prev) {
      prev.classList.remove('pad-focus');
      if (prev.isConnected) {
        prev.dispatchEvent(new PointerEvent('pointerleave'));
        prev.dispatchEvent(new MouseEvent('mouseleave'));
      }
    }
    this.focus = el;
    if (!el) return;
    el.classList.toggle('pad-focus', this.revealed);
    if (scroll) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // Remembered now: a press in the same frame may re-render it away before the end of update().
    this.remember(el);
    // Hover-driven details (the build menu's card) follow the pad focus.
    el.dispatchEvent(new PointerEvent('pointerenter'));
    el.dispatchEvent(new MouseEvent('mouseenter'));
  }

  private step(dir: NavDir, scope: HTMLElement): void {
    const f = this.focus!;
    if ((dir === 'left' || dir === 'right') && this.adjust(f, dir === 'right' ? 1 : -1)) return;
    const cands = this.candidates(scope);
    const rects = cands.map(rectOf);
    const from = cands.indexOf(f);
    const fromRect = from >= 0 ? rects[from]! : rectOf(f);
    const i = pickInDirection(fromRect, from >= 0 ? rects : [...rects, fromRect], dir);
    if (i >= 0 && cands[i]) this.setFocus(cands[i]!);
  }

  /** Left/right on a slider or a select changes its value. */
  private adjust(el: HTMLElement, sign: 1 | -1): boolean {
    if (el instanceof HTMLInputElement && el.type === 'range') {
      if (el.disabled) return true;
      const step = Number(el.step) || 1;
      const min = el.min === '' ? 0 : Number(el.min);
      const max = el.max === '' ? 100 : Number(el.max);
      const mult = this.repeat.count > 8 ? 4 : 1;
      const decimals = (String(step).split('.')[1] ?? '').length;
      const v = Math.min(max, Math.max(min, Number(el.value) + sign * step * mult));
      const next = v.toFixed(decimals);
      if (next !== el.value) {
        el.value = next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }
    if (el instanceof HTMLSelectElement) {
      if (el.disabled) return true;
      const i = Math.min(el.options.length - 1, Math.max(0, el.selectedIndex + sign));
      if (i !== el.selectedIndex) {
        el.selectedIndex = i;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }
    return false;
  }

  private activate(scope: HTMLElement): void {
    const f = this.focus;
    if (handlers.get(scope)?.a?.(f)) return;
    if (!f || disabled(f)) return;
    if (f.hasAttribute('data-pad-hold')) {
      f.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1 }));
      this.hold = f;
      this.holdKey = keyOf(f);
      return;
    }
    if (f instanceof HTMLSelectElement) return void this.adjust(f, 1);
    if (f instanceof HTMLInputElement && f.type === 'range') return;
    this.click(f);
  }

  /** A click from the pad: the game can tell it from a mouse click (no pointer lock to ask for). */
  private click(el: HTMLElement): void {
    this.input.padActivation = true;
    try {
      el.click();
    } finally {
      this.input.padActivation = false;
      // What it opens may take a while (a mode switch builds a world): it was still opened by this press.
      this.lastPressAt = performance.now();
    }
  }

  private endHold(): void {
    if (!this.hold) return;
    this.hold = null;
    window.dispatchEvent(new PointerEvent('pointerup', { button: 0 }));
  }

  private press(b: Exclude<HandledButton, 'a'>, scope: HTMLElement): void {
    if (handlers.get(scope)?.[b]?.(this.focus)) return;
    if (b === 'lb' || b === 'rb') {
      const tabs = [...scope.querySelectorAll<HTMLElement>('[data-pad-tab]')].filter((t) => visible(t) && !disabled(t));
      if (tabs.length < 2) return;
      const cur = tabs.findIndex((t) => t.classList.contains('selected'));
      const next = tabs[(Math.max(0, cur) + (b === 'rb' ? 1 : tabs.length - 1)) % tabs.length]!;
      // A focused tab follows the selection (the tabs are re-rendered by the click).
      if (this.focus?.hasAttribute('data-pad-tab')) {
        this.lastKey = keyOf(next);
        this.setFocus(next);
      }
      this.click(next);
      return;
    }
    const targets = [...scope.querySelectorAll<HTMLElement>(`[data-pad-btn~="${b}"]`)].filter((t) => visible(t) && !disabled(t));
    let best: HTMLElement | undefined;
    for (const t of targets) if (!best || Number(t.dataset.padPrio ?? 0) >= Number(best.dataset.padPrio ?? 0)) best = t;
    if (best) this.click(best);
  }

  /**
   * Right stick: the scrolling area around the focus, else the scope's scrolling area closest to it (a list
   * with nothing to focus, like finished hub tiers, must still be readable).
   */
  private scroll(dy: number, scope: HTMLElement): void {
    const scrollable = (el: HTMLElement) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);
    for (let el: HTMLElement | null = this.focus; el; el = el === scope ? null : el.parentElement) {
      if (scrollable(el)) return void (el.scrollTop += dy);
    }
    const areas = [...scope.querySelectorAll<HTMLElement>('*')].filter((el) => el.getClientRects().length > 0 && scrollable(el));
    if (!areas.length) return;
    const c = this.lastCenter;
    const area = c ? areas[nearestTo(c.x, c.y, areas.map(rectOf))]! : areas[0]!;
    area.scrollTop += dy;
  }

  private updateTip(r: DOMRect): void {
    const f = this.focus!;
    const text = f.dataset.padTip ?? f.title ?? '';
    if (!text) return void this.tip.classList.remove('show');
    if (this.tip.textContent !== text) this.tip.textContent = text;
    this.tip.classList.add('show');
    const tw = this.tip.offsetWidth;
    const th = this.tip.offsetHeight;
    const x = Math.max(6, Math.min(window.innerWidth - tw - 6, r.left + r.width / 2 - tw / 2));
    const below = r.bottom + 6 + th < window.innerHeight;
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${below ? r.bottom + 6 : r.top - th - 6}px`;
  }
}
