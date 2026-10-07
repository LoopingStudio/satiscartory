import { KEYBINDS, PADBINDS, type Action, type PadProfile } from '../config/keybinds';
import { PadGate, PadState, pickPad, type PadSnapshot, type StickSide } from './gamepad';

/** Keys whose browser default behavior we always suppress while the canvas is in use. */
const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Tab', 'F3', 'PageUp', 'PageDown']);
/** Mouse travel (px, without a pad press in between) that hands the hints back to keyboard and mouse. */
const MOUSE_SWITCH_PX = 24;

/** Which device the player used last: the hints and the cursor follow it. */
export type InputDevice = 'kbm' | 'pad';

/**
 * Keyboard/mouse state, plus the first gamepad (polled once per frame). Presses are latched with a
 * timestamp so fixed-step consumers (which may run 0 or N times per frame) never miss an edge.
 * Actions read the keys of KEYBINDS and the pad buttons of PADBINDS[padProfile].
 */
export class Input {
  private down = new Set<string>();
  private pressTime = new Map<string, number>();
  private framePressed = new Set<string>();
  private frameReleased = new Set<string>();
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

  /** Raw state of the pad in use. */
  readonly pad = new PadState();
  /** What gameplay sees of the pad (blocked while a menu owns it, and after mode switches). */
  private readonly gamePad = new PadGate(this.pad);
  /** What the menu navigator sees of the pad (PadNav). */
  readonly navPad = new PadGate(this.pad);
  /** Gameplay pad bindings of the active mode; reset to 'none' on mode switch. */
  padProfile: PadProfile = 'none';
  /** A pad-driven menu owns the pad this frame: gameplay reads nothing from it. */
  private padOwned = false;
  /** True while PadNav clicks a control (a pad press, not a mouse click: no user gesture for the browser). */
  padActivation = false;
  private padIndex: number | null = null;
  private mouseTravel = 0;
  private lastMouseMoveAt = 0;
  private _device: InputDevice = 'kbm';
  private deviceListeners = new Set<(d: InputDevice) => void>();

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    target.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    // Any click (menus included) hands the hints back to the mouse.
    window.addEventListener('pointerdown', this.onAnyPointer, true);
    target.addEventListener('wheel', this.onWheel, { passive: false });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get device(): InputDevice {
    return this._device;
  }

  private setDevice(d: InputDevice): void {
    if (d === 'pad') this.mouseTravel = 0;
    if (d === this._device) return;
    this._device = d;
    document.body.classList.toggle('pad-input', d === 'pad');
    for (const fn of this.deviceListeners) fn(d);
  }

  onDeviceChange(fn: (d: InputDevice) => void): () => void {
    this.deviceListeners.add(fn);
    return () => this.deviceListeners.delete(fn);
  }

  private isTextTarget(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.isTextTarget(e)) { this.typing = true; return; }
    this.typing = false;
    this.setDevice('kbm');
    if (PREVENT.has(e.code)) e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') e.preventDefault();
    if (!this.down.has(e.code)) {
      this.pressTime.set(e.code, performance.now());
      this.framePressed.add(e.code);
    }
    this.down.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (this.down.has(e.code)) this.frameReleased.add(e.code);
    this.down.delete(e.code);
  };

  private onBlur = () => {
    this.down.clear();
    this.buttons.clear();
  };

  /** Real clicks only: PadNav synthesizes pointer events for hold-buttons. */
  private onAnyPointer = (e: PointerEvent) => {
    if (e.isTrusted) this.setDevice('kbm');
  };

  private onMouseDown = (e: MouseEvent) => {
    this.setDevice('kbm');
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
    // A bumped mouse does not take the hints away from the pad; a real move does (bumps far apart do not add up).
    if (this._device === 'pad') {
      const now = performance.now();
      if (now - this.lastMouseMoveAt > 250) this.mouseTravel = 0;
      this.lastMouseMoveAt = now;
      this.mouseTravel += Math.abs(clamp(e.movementX)) + Math.abs(clamp(e.movementY));
      if (this.mouseTravel > MOUSE_SWITCH_PX) this.setDevice('kbm');
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.setDevice('kbm');
    this.wheel += Math.sign(e.deltaY);
  };

  /** Reads the gamepad (call once at the start of every frame, before the fixed steps). */
  poll(now = performance.now()): void {
    let pads: ArrayLike<PadSnapshot | null> = [];
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') pads = navigator.getGamepads();
    } catch {
      // getGamepads throws in some sandboxed/insecure contexts: no pad.
    }
    const pad = pickPad(pads, this.padIndex);
    this.padIndex = pad?.index ?? null;
    const style = this.pad.style;
    this.pad.poll(pad, now);
    this.gamePad.update();
    this.navPad.update();
    if (this.pad.style !== style || !document.body.dataset.pad) document.body.dataset.pad = this.pad.style;
    if (this.pad.active) this.setDevice('pad');
  }

  /**
   * PadNav: whether a menu drives the pad this frame. While it does, gameplay reads nothing from the pad,
   * and the buttons and sticks held when it lets go stay ignored until released. Not the analog triggers:
   * menus do not use them, and a throttle held through « Réessayer » must launch the car at GO.
   */
  setPadOwned(owned: boolean): void {
    if (owned) {
      this.gamePad.blockHeld(false);
      this.pad.clearLatches();
    }
    this.padOwned = owned;
  }

  /** Gameplay ignores the pad buttons and sticks held now until they are let go (car in/out, …). */
  blockPadHeld(): void {
    this.gamePad.blockHeld();
    this.pad.clearLatches();
  }

  private padButtons(action: Action) {
    return this.padOwned ? undefined : PADBINDS[this.padProfile][action];
  }

  isKeyDown(code: string): boolean {
    return this.down.has(code);
  }

  isDown(action: Action): boolean {
    if (!this.typing) for (const code of KEYBINDS[action]) if (this.down.has(code)) return true;
    const pad = this.padButtons(action);
    return !!pad && pad.some((b) => this.gamePad.isDown(b));
  }

  /** True if the action was pressed since the last endFrame(). */
  wasPressed(action: Action): boolean {
    if (!this.typing) for (const code of KEYBINDS[action]) if (this.framePressed.has(code)) return true;
    const pad = this.padButtons(action);
    return !!pad && pad.some((b) => this.gamePad.pressed(b));
  }

  /** True if the action was released since the last endFrame(). */
  wasReleased(action: Action): boolean {
    for (const code of KEYBINDS[action]) if (this.frameReleased.has(code)) return true;
    const pad = this.padButtons(action);
    return !!pad && pad.some((b) => this.gamePad.released(b));
  }

  /** The action was last pressed on the pad (not on the keyboard). */
  padHas(action: Action): boolean {
    const pad = this.padButtons(action);
    return !!pad && pad.some((b) => this.gamePad.isDown(b));
  }

  /**
   * Consumes a latched press (for fixed-step logic). Returns true at most once per physical press, if it
   * happened within `maxAgeMs`.
   */
  consume(action: Action, maxAgeMs = 250): boolean {
    const now = performance.now();
    let hit = false;
    for (const code of KEYBINDS[action]) {
      const t = this.pressTime.get(code);
      if (t !== undefined) {
        this.pressTime.delete(code);
        if (now - t <= maxAgeMs) hit = true;
      }
    }
    const pad = this.padButtons(action);
    if (pad) for (const b of pad) if (this.gamePad.consume(b, now, maxAgeMs)) hit = true;
    return hit;
  }

  /** -1..1 axis from two actions (keys and digital pad buttons; sticks are read with padStick). */
  axis(neg: Action, pos: Action): number {
    return (this.isDown(pos) ? 1 : 0) - (this.isDown(neg) ? 1 : 0);
  }

  /** Deadzoned stick (-1..1, +y = down/back), zero while a menu owns the pad. */
  padStick(side: StickSide): { x: number; y: number } {
    return this.padOwned || this.padProfile === 'none' ? { x: 0, y: 0 } : this.gamePad.stick(side);
  }

  /** Analog trigger (0..1), zero while a menu owns the pad. */
  padTrigger(side: StickSide): number {
    return this.padOwned || this.padProfile === 'none' ? 0 : this.gamePad.trigger(side);
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
    this.frameReleased.clear();
    this.buttonPressed.clear();
    this.buttonReleased.clear();
    this.pad.endFrame();
  }

  /** Forget all latched presses (on mode switch); pad buttons held now are ignored until released. */
  reset(): void {
    this.pressTime.clear();
    this.buttonPressTime.clear();
    this.framePressed.clear();
    this.frameReleased.clear();
    this.buttonPressed.clear();
    this.buttonReleased.clear();
    this.mouseDX = this.mouseDY = this.wheel = 0;
    this.padProfile = 'none';
    this.gamePad.blockHeld();
    this.navPad.blockHeld();
    this.pad.clearLatches();
  }
}
