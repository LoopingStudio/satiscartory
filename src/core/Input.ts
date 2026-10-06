import { KEYBINDS, type Action } from '../config/keybinds';

/** Keys whose browser default behavior we always suppress while the canvas is in use. */
const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Tab', 'F3', 'PageUp', 'PageDown']);

/**
 * Keyboard/mouse state. Presses are latched with a timestamp so fixed-step
 * consumers (which may run 0 or N times per frame) never miss an edge.
 */
export class Input {
  private down = new Set<string>();
  private pressTime = new Map<string, number>();
  private framePressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  mouseX = 0;
  mouseY = 0;
  /** Normalized device coords of the cursor (-1..1). */
  ndcX = 0;
  ndcY = 0;
  private buttons = new Set<number>();
  private buttonPressed = new Set<number>();
  private buttonReleased = new Set<number>();
  private buttonPressTime = new Map<number, number>();
  /** When true, keyboard events are ignored (e.g. a text input has focus). */
  private typing = false;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    target.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    target.addEventListener('wheel', this.onWheel, { passive: false });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private isTextTarget(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.isTextTarget(e)) { this.typing = true; return; }
    this.typing = false;
    if (PREVENT.has(e.code)) e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') e.preventDefault();
    if (!this.down.has(e.code)) {
      this.pressTime.set(e.code, performance.now());
      this.framePressed.add(e.code);
    }
    this.down.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };

  private onBlur = () => {
    this.down.clear();
    this.buttons.clear();
  };

  private onMouseDown = (e: MouseEvent) => {
    this.buttons.add(e.button);
    this.buttonPressed.add(e.button);
    this.buttonPressTime.set(e.button, performance.now());
  };

  private onMouseUp = (e: MouseEvent) => {
    if (this.buttons.has(e.button)) this.buttonReleased.add(e.button);
    this.buttons.delete(e.button);
  };

  private onMouseMove = (e: MouseEvent) => {
    // Clamp spikes some browsers emit on pointer-lock transitions.
    const clamp = (v: number) => Math.max(-200, Math.min(200, v));
    this.mouseDX += clamp(e.movementX);
    this.mouseDY += clamp(e.movementY);
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    const r = this.target.getBoundingClientRect();
    this.ndcX = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.ndcY = -((e.clientY - r.top) / r.height) * 2 + 1;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.wheel += Math.sign(e.deltaY);
  };

  isKeyDown(code: string): boolean {
    return this.down.has(code);
  }

  isDown(action: Action): boolean {
    if (this.typing) return false;
    for (const code of KEYBINDS[action]) if (this.down.has(code)) return true;
    return false;
  }

  /** True if the action was pressed since the last endFrame(). */
  wasPressed(action: Action): boolean {
    if (this.typing) return false;
    for (const code of KEYBINDS[action]) if (this.framePressed.has(code)) return true;
    return false;
  }

  /**
   * Consumes a latched press (for fixed-step logic). Returns true at most once
   * per physical press, if it happened within `maxAgeMs`.
   */
  consume(action: Action, maxAgeMs = 250): boolean {
    const now = performance.now();
    for (const code of KEYBINDS[action]) {
      const t = this.pressTime.get(code);
      if (t !== undefined) {
        this.pressTime.delete(code);
        if (now - t <= maxAgeMs) return true;
      }
    }
    return false;
  }

  /** -1..1 axis from two actions. */
  axis(neg: Action, pos: Action): number {
    return (this.isDown(pos) ? 1 : 0) - (this.isDown(neg) ? 1 : 0);
  }

  isButtonDown(button: number): boolean {
    return this.buttons.has(button);
  }

  buttonWasPressed(button: number): boolean {
    return this.buttonPressed.has(button);
  }

  buttonWasReleased(button: number): boolean {
    return this.buttonReleased.has(button);
  }

  consumeButton(button: number, maxAgeMs = 250): boolean {
    const t = this.buttonPressTime.get(button);
    if (t === undefined) return false;
    this.buttonPressTime.delete(button);
    return performance.now() - t <= maxAgeMs;
  }

  /** Clears per-frame deltas/edges. Call at the end of every rendered frame. */
  endFrame(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.framePressed.clear();
    this.buttonPressed.clear();
    this.buttonReleased.clear();
  }

  /** Forget all latched presses (on mode switch). */
  reset(): void {
    this.pressTime.clear();
    this.buttonPressTime.clear();
    this.framePressed.clear();
    this.buttonPressed.clear();
    this.buttonReleased.clear();
    this.mouseDX = this.mouseDY = this.wheel = 0;
  }
}
