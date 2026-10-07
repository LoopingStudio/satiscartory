/**
 * Gamepad state (pure: no DOM access, time injected). The Gamepad API has no button events, so Input
 * polls a snapshot once per frame and this module turns it into held states, press/release edges since
 * the last endFrame(), timestamped latches for fixed-step consumers, and deadzoned sticks and triggers.
 */

/** Standard Gamepad mapping (W3C): button indices. */
export const PAD = {
  a: 0, b: 1, x: 2, y: 3,
  lb: 4, rb: 5, lt: 6, rt: 7,
  view: 8, start: 9, l3: 10, r3: 11,
  up: 12, down: 13, left: 14, right: 15,
} as const;
export type PadButton = keyof typeof PAD;
export const PAD_BUTTONS = Object.keys(PAD) as PadButton[];
export type StickSide = 'left' | 'right';
export type NavDir = 'up' | 'down' | 'left' | 'right';
/** Face-button labels to show: Xbox (A B X Y), PlayStation (✕ ○ □ △) or Nintendo (B A Y X by position). */
export type PadStyle = 'xbox' | 'ps' | 'nintendo';

/** What Input reads from navigator.getGamepads() (a DOM Gamepad fits, so does a test literal). */
export interface PadSnapshot {
  readonly id?: string;
  readonly index?: number;
  readonly connected?: boolean;
  readonly mapping?: string;
  readonly buttons: ArrayLike<{ readonly pressed: boolean; readonly value: number } | undefined>;
  readonly axes: ArrayLike<number>;
}

export const PAD_TUNING = {
  /** Stick radius under which it reads as centered (drift), and over which it reads as full. */
  STICK_INNER: 0.18,
  STICK_OUTER: 0.95,
  /** Analog triggers as buttons: down over ON, up again under OFF (no chatter around one threshold). */
  TRIGGER_ON: 0.5,
  TRIGGER_OFF: 0.3,
  /** Analog trigger travel ignored at rest. */
  TRIGGER_DEADZONE: 0.06,
  /** Stick deflection (after the deadzone) that counts as a direction in menus, and under which it is released. */
  NAV_ON: 0.5,
  NAV_OFF: 0.3,
  /** Pad use from sticks and triggers: crossing this deflection, or moving this much in one poll. */
  ACTIVE: 0.4,
  ACTIVE_DELTA: 0.3,
  /** A blocked stick or trigger is let go once back under this (a worn stick never reads exactly 0). */
  REST: 0.2,
  /** Menu auto-repeat: first repeat after DELAY ms, then one every RATE ms. */
  NAV_DELAY_MS: 380,
  NAV_RATE_MS: 90,
} as const;

const TRIGGERS = new Set<number>([PAD.lt, PAD.rt]);

/** Radial deadzone, rescaled so that motion starts at 0 just outside it (no jump to the deadzone value). */
export function radialDeadzone(x: number, y: number, inner: number = PAD_TUNING.STICK_INNER, outer: number = PAD_TUNING.STICK_OUTER): { x: number; y: number } {
  const len = Math.hypot(x, y);
  if (!Number.isFinite(len) || len <= inner) return { x: 0, y: 0 };
  const mag = Math.min(1, (len - inner) / (outer - inner));
  return { x: (x / len) * mag, y: (y / len) * mag };
}

/** Response curve for camera sticks: fine control near the center, full speed at the edge. */
export function stickCurve(v: number, exponent = 1.8): number {
  return Math.sign(v) * Math.pow(Math.min(1, Math.abs(v)), exponent);
}

/** Which labels a pad's id calls for (vendor ids: Sony 054c, Nintendo 057e). */
export function padStyleOf(id: string): PadStyle {
  if (/xbox|045e/i.test(id)) return 'xbox';
  if (/054c|playstation|dualshock|dualsense/i.test(id)) return 'ps';
  if (/057e|nintendo|pro controller|joy-con/i.test(id)) return 'nintendo';
  return 'xbox';
}

/**
 * The pad to read among navigator.getGamepads(): the previous one while it stays connected, unless it is
 * idle and another one has a button down (a second pad picked up). Only the standard mapping: the buttons
 * and axes of other devices mean anything (a wheel's pedals resting at ±1 would walk the player and
 * pass for constant pad use).
 */
export function pickPad(pads: ArrayLike<PadSnapshot | null | undefined>, prevIndex: number | null): PadSnapshot | null {
  const list: PadSnapshot[] = [];
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (p && p.connected !== false && p.mapping === 'standard') list.push(p);
  }
  if (!list.length) return null;
  const busy = (p: PadSnapshot) => {
    for (let i = 0; i < p.buttons.length; i++) if (p.buttons[i]?.pressed) return true;
    return false;
  };
  const prev = prevIndex === null ? undefined : list.find((p) => p.index === prevIndex);
  if (prev && (busy(prev) || !list.some((p) => p !== prev && busy(p)))) return prev;
  return list.find(busy) ?? list[0]!;
}

/** Raw pad state: held buttons, edges since endFrame(), press latches, sticks and triggers. */
export class PadState {
  connected = false;
  id = '';
  style: PadStyle = 'xbox';
  /**
   * The player used the pad during the last poll: a press, or a stick or trigger pushed (crossing ACTIVE,
   * or moving fast). A steady deflection is not use: one held still, or resting off-center, must not
   * keep the hints on the pad while the mouse is in use.
   */
  active = false;
  private readonly prevMag = [0, 0, 0, 0];
  /** A stick or trigger counts again only after coming back to rest (no flicker around ACTIVE). */
  private readonly armed = [true, true, true, true];
  private readonly down = new Array<boolean>(PAD_BUTTONS.length).fill(false);
  private readonly downAt = new Array<number>(PAD_BUTTONS.length).fill(0);
  private readonly pressedSet = new Set<number>();
  private readonly releasedSet = new Set<number>();
  /** Press time of each button not consumed yet (fixed-step consumers may run 0 or N times per frame). */
  private readonly latch = new Map<number, number>();
  private readonly sticks = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  private readonly triggers = { left: 0, right: 0 };

  poll(pad: PadSnapshot | null, now: number): void {
    this.active = false;
    if (!pad) {
      if (this.connected) this.releaseAll();
      this.connected = false;
      return;
    }
    if (!this.connected || pad.id !== this.id) {
      this.id = pad.id ?? '';
      this.style = padStyleOf(this.id);
    }
    this.connected = true;
    for (let i = 0; i < this.down.length; i++) {
      const b = pad.buttons[i];
      const value = b ? b.value : 0;
      const pressed = !!b && (TRIGGERS.has(i)
        ? value >= (this.down[i] ? PAD_TUNING.TRIGGER_OFF : PAD_TUNING.TRIGGER_ON) || (b.pressed && value === 0)
        : b.pressed || value > 0.5);
      if (pressed && !this.down[i]) {
        this.down[i] = true;
        this.downAt[i] = now;
        this.pressedSet.add(i);
        this.latch.set(i, now);
        this.active = true;
      } else if (!pressed && this.down[i]) {
        this.down[i] = false;
        this.releasedSet.add(i);
      }
    }
    const ax = (i: number) => {
      const v = pad.axes[i];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    };
    this.sticks.left = radialDeadzone(ax(0), ax(1));
    this.sticks.right = radialDeadzone(ax(2), ax(3));
    const trig = (i: number) => {
      const v = pad.buttons[i]?.value ?? 0;
      return v <= PAD_TUNING.TRIGGER_DEADZONE ? 0 : Math.min(1, (v - PAD_TUNING.TRIGGER_DEADZONE) / (1 - PAD_TUNING.TRIGGER_DEADZONE));
    };
    this.triggers.left = trig(PAD.lt);
    this.triggers.right = trig(PAD.rt);
    const mags = [Math.hypot(this.sticks.left.x, this.sticks.left.y), Math.hypot(this.sticks.right.x, this.sticks.right.y), this.triggers.left, this.triggers.right];
    mags.forEach((m, i) => {
      const prev = this.prevMag[i]!;
      if (m >= PAD_TUNING.ACTIVE && this.armed[i]) {
        this.active = true;
        this.armed[i] = false;
      } else if (m < PAD_TUNING.REST) this.armed[i] = true;
      if (Math.abs(m - prev) > PAD_TUNING.ACTIVE_DELTA) this.active = true;
      this.prevMag[i] = m;
    });
  }

  private releaseAll(): void {
    for (let i = 0; i < this.down.length; i++) {
      if (this.down[i]) this.releasedSet.add(i);
      this.down[i] = false;
    }
    this.latch.clear();
    this.sticks.left = { x: 0, y: 0 };
    this.sticks.right = { x: 0, y: 0 };
    this.triggers.left = this.triggers.right = 0;
    this.prevMag.fill(0);
    this.armed.fill(true);
  }

  isDown(b: PadButton): boolean {
    return this.down[PAD[b]]!;
  }

  pressed(b: PadButton): boolean {
    return this.pressedSet.has(PAD[b]);
  }

  released(b: PadButton): boolean {
    return this.releasedSet.has(PAD[b]);
  }

  /** How long `b` has been held (0 when up). */
  heldMs(b: PadButton, now: number): number {
    return this.down[PAD[b]] ? now - this.downAt[PAD[b]]! : 0;
  }

  /** True at most once per press, if it happened within `maxAgeMs` (like Input.consume for keys). */
  consume(b: PadButton, now: number, maxAgeMs = 250): boolean {
    const t = this.latch.get(PAD[b]);
    if (t === undefined) return false;
    this.latch.delete(PAD[b]);
    return now - t <= maxAgeMs;
  }

  clearLatches(): void {
    this.latch.clear();
  }

  stick(side: StickSide): { x: number; y: number } {
    return this.sticks[side];
  }

  trigger(side: StickSide): number {
    return this.triggers[side];
  }

  /** Clears the edges (call at the end of every rendered frame). */
  endFrame(): void {
    this.pressedSet.clear();
    this.releasedSet.clear();
  }
}

/**
 * One consumer's view of the pad (gameplay, or the menu navigator): it can ignore everything currently
 * held until it is let go, so a press that opened a menu, closed it or switched modes never acts twice.
 */
export class PadGate {
  private readonly blocked = new Set<PadButton>();
  /** Unblocked by this poll's release: that release edge belongs to the ignored press. */
  private readonly freed = new Set<PadButton>();
  private readonly blockedSticks = new Set<StickSide>();
  private readonly blockedTriggers = new Set<StickSide>();

  constructor(readonly pad: PadState) {}

  /**
   * Ignore what is held now: buttons until released, sticks until centered, analog triggers (unless
   * `triggers` is false) until let go.
   */
  blockHeld(triggers = true): void {
    for (const b of PAD_BUTTONS) if (this.pad.isDown(b)) this.blocked.add(b);
    for (const s of ['left', 'right'] as const) {
      const v = this.pad.stick(s);
      if (Math.hypot(v.x, v.y) >= PAD_TUNING.REST) this.blockedSticks.add(s);
      if (triggers && this.pad.trigger(s) >= PAD_TUNING.REST) this.blockedTriggers.add(s);
    }
  }

  /** After each poll: lift the blocks on inputs that came back to rest. */
  update(): void {
    this.freed.clear();
    for (const b of this.blocked) {
      if (this.pad.isDown(b)) continue;
      this.blocked.delete(b);
      this.freed.add(b);
    }
    for (const s of this.blockedSticks) {
      const v = this.pad.stick(s);
      if (Math.hypot(v.x, v.y) < PAD_TUNING.REST) this.blockedSticks.delete(s);
    }
    for (const s of this.blockedTriggers) if (this.pad.trigger(s) < PAD_TUNING.REST) this.blockedTriggers.delete(s);
  }

  isBlocked(b: PadButton): boolean {
    return this.blocked.has(b);
  }

  isDown(b: PadButton): boolean {
    return !this.blocked.has(b) && this.pad.isDown(b);
  }

  pressed(b: PadButton): boolean {
    return !this.blocked.has(b) && this.pad.pressed(b);
  }

  released(b: PadButton): boolean {
    return !this.blocked.has(b) && !this.freed.has(b) && this.pad.released(b);
  }

  consume(b: PadButton, now: number, maxAgeMs = 250): boolean {
    return !this.blocked.has(b) && this.pad.consume(b, now, maxAgeMs);
  }

  stick(side: StickSide): { x: number; y: number } {
    return this.blockedSticks.has(side) ? { x: 0, y: 0 } : this.pad.stick(side);
  }

  trigger(side: StickSide): number {
    return this.blockedTriggers.has(side) ? 0 : this.pad.trigger(side);
  }
}

/** Menu direction from the D-pad or the left stick (dominant axis, with hysteresis). */
export function navDirection(gate: PadGate, prev: NavDir | null): NavDir | null {
  if (gate.isDown('up')) return 'up';
  if (gate.isDown('down')) return 'down';
  if (gate.isDown('left')) return 'left';
  if (gate.isDown('right')) return 'right';
  const s = gate.stick('left');
  const ax = Math.abs(s.x);
  const ay = Math.abs(s.y);
  // Keep the held direction until the stick comes back under NAV_OFF on that axis.
  if (prev === 'left' && s.x < -PAD_TUNING.NAV_OFF) return 'left';
  if (prev === 'right' && s.x > PAD_TUNING.NAV_OFF) return 'right';
  if (prev === 'up' && s.y < -PAD_TUNING.NAV_OFF) return 'up';
  if (prev === 'down' && s.y > PAD_TUNING.NAV_OFF) return 'down';
  if (Math.max(ax, ay) < PAD_TUNING.NAV_ON) return null;
  return ax > ay ? (s.x < 0 ? 'left' : 'right') : s.y < 0 ? 'up' : 'down';
}

/** Turns a held direction into steps: one on press, then auto-repeat after a delay. */
export class NavRepeat {
  private dir: NavDir | null = null;
  private next = 0;
  /** Steps fired since the direction was pressed (lets sliders speed up on a long hold). */
  count = 0;

  update(dir: NavDir | null, now: number): NavDir | null {
    if (dir !== this.dir) {
      this.dir = dir;
      this.count = 0;
      if (!dir) return null;
      this.next = now + PAD_TUNING.NAV_DELAY_MS;
      this.count = 1;
      return dir;
    }
    if (!dir || now < this.next) return null;
    this.next = now + PAD_TUNING.NAV_RATE_MS;
    this.count++;
    return dir;
  }

  /** The current hold must not step (e.g. a direction already held when a menu opens). */
  hold(dir: NavDir | null): void {
    this.dir = dir;
    this.next = Infinity;
    this.count = 0;
  }

  get current(): NavDir | null {
    return this.dir;
  }
}
