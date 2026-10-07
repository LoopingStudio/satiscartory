import { describe, expect, it } from 'vitest';
import { NavRepeat, PAD, PAD_TUNING, PadGate, PadState, navDirection, padStyleOf, pickPad, radialDeadzone, stickCurve, type PadButton, type PadSnapshot } from './gamepad';

/** A standard-mapping snapshot with `on` buttons fully pressed, optional axes and trigger values. */
function snap(on: PadButton[] = [], axes: number[] = [0, 0, 0, 0], extra: Partial<Record<number, number>> = {}, more: Partial<PadSnapshot> = {}): PadSnapshot {
  const idx: number[] = on.map((b) => PAD[b]);
  return {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)',
    index: 0,
    connected: true,
    mapping: 'standard',
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => {
      const v = extra[i] ?? (idx.includes(i) ? 1 : 0);
      return { pressed: v > 0.5 || idx.includes(i), value: v };
    }),
    ...more,
  };
}

describe('radialDeadzone', () => {
  it('reads drift as centered and rescales from the deadzone edge', () => {
    expect(radialDeadzone(0.1, -0.1)).toEqual({ x: 0, y: 0 });
    const just = radialDeadzone(PAD_TUNING.STICK_INNER + 0.01, 0);
    expect(just.x).toBeGreaterThan(0);
    expect(just.x).toBeLessThan(0.05);
    expect(radialDeadzone(1, 0).x).toBe(1);
    // Direction kept, magnitude clamped to 1.
    const d = radialDeadzone(0.8, 0.8);
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(1);
    expect(d.x).toBeCloseTo(d.y);
    expect(radialDeadzone(NaN, 0)).toEqual({ x: 0, y: 0 });
  });

  it('curves camera input but keeps the sign and the ends', () => {
    expect(stickCurve(0)).toBe(0);
    expect(stickCurve(1)).toBe(1);
    expect(stickCurve(-1)).toBe(-1);
    expect(stickCurve(0.5)).toBeLessThan(0.5);
    expect(stickCurve(-0.5)).toBeGreaterThan(-0.5);
  });
});

describe('pad style and choice', () => {
  it('names the face buttons after the vendor', () => {
    expect(padStyleOf('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')).toBe('xbox');
    expect(padStyleOf('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe('ps');
    expect(padStyleOf('054c-09cc-Wireless Controller')).toBe('ps');
    expect(padStyleOf('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)')).toBe('nintendo');
    expect(padStyleOf('')).toBe('xbox');
  });

  it('keeps the pad in use, follows a second pad that gets pressed, skips disconnected ones', () => {
    const a = snap([], undefined, {}, { index: 0 });
    const b = snap([], undefined, {}, { index: 1 });
    expect(pickPad([], null)).toBeNull();
    expect(pickPad([null, b], null)).toBe(b); // a pad reconnected at index 1
    expect(pickPad([a, b], 1)).toBe(b);
    const bPressed = snap(['a'], undefined, {}, { index: 1 });
    expect(pickPad([a, bPressed], 0)).toBe(bPressed);
    expect(pickPad([{ ...a, connected: false }, b], 0)).toBe(b);
    // Only the standard mapping: a wheel or a throttle (axes resting at ±1) is not a pad.
    const odd = snap(['a'], [0, 1, 1, 0], {}, { index: 0, mapping: '' });
    expect(pickPad([odd, b], null)).toBe(b);
    expect(pickPad([odd], null)).toBeNull();
  });
});

describe('PadState', () => {
  it('turns polls into held states, edges until endFrame, and latches consumed once', () => {
    const p = new PadState();
    p.poll(snap(), 0);
    expect(p.connected).toBe(true);
    p.poll(snap(['a']), 16);
    expect(p.isDown('a')).toBe(true);
    expect(p.pressed('a')).toBe(true);
    expect(p.active).toBe(true);
    p.endFrame();
    expect(p.pressed('a')).toBe(false);
    expect(p.isDown('a')).toBe(true);
    // The latch survives frames until a fixed step consumes it, once.
    expect(p.consume('a', 40)).toBe(true);
    expect(p.consume('a', 41)).toBe(false);
    expect(p.heldMs('a', 116)).toBe(100);
    p.poll(snap(), 133);
    expect(p.released('a')).toBe(true);
    expect(p.isDown('a')).toBe(false);
    expect(p.heldMs('a', 140)).toBe(0);
  });

  it('drops stale latches', () => {
    const p = new PadState();
    p.poll(snap(['b']), 0);
    expect(p.consume('b', 1000)).toBe(false);
  });

  it('reads analog triggers as buttons with hysteresis', () => {
    const p = new PadState();
    const rt = (v: number) => snap([], undefined, { [PAD.rt]: v });
    p.poll(rt(0.4), 0);
    expect(p.isDown('rt')).toBe(false);
    p.poll(rt(0.6), 16);
    expect(p.isDown('rt')).toBe(true);
    p.endFrame();
    p.poll(rt(0.4), 33); // under ON but over OFF: still held, no new press
    expect(p.isDown('rt')).toBe(true);
    p.poll(rt(0.6), 50);
    expect(p.pressed('rt')).toBe(false);
    p.poll(rt(0.2), 66);
    expect(p.released('rt')).toBe(true);
    expect(p.trigger('right')).toBeGreaterThan(0.1);
    p.poll(rt(0.03), 83);
    expect(p.trigger('right')).toBe(0);
  });

  it('counts pushing a stick as pad use, not holding it still', () => {
    const p = new PadState();
    p.poll(snap([], [0.9, 0, 0, 0]), 0);
    expect(p.active).toBe(true);
    p.poll(snap([], [0.9, 0, 0, 0]), 16);
    expect(p.active).toBe(false);
    p.poll(snap([], [0.9, 0, 0, 0], { [PAD.rt]: 0.9 }), 33);
    expect(p.active).toBe(true);
    p.poll(snap([], [0, 0, 0, 0]), 50); // let go fast: still use
    expect(p.active).toBe(true);
    p.poll(snap([], [0, 0, 0, 0]), 66);
    expect(p.active).toBe(false);
  });

  it('does not flicker for a stick resting right at the threshold', () => {
    const p = new PadState();
    let n = 0;
    // Raw 0.49 ± noise: around ACTIVE after the deadzone.
    for (let i = 0; i < 100; i++) {
      p.poll(snap([], [i % 2 ? 0.487 : 0.495, 0, 0, 0]), i * 16);
      if (p.active) n++;
    }
    expect(n).toBe(1);
  });

  it('marks moving sticks as activity and releases everything on disconnect', () => {
    const p = new PadState();
    p.poll(snap([], [0.9, 0, 0, 0]), 0);
    expect(p.active).toBe(true);
    expect(p.stick('left').x).toBeGreaterThan(0.8);
    p.poll(snap(['x'], [0.9, 0, 0, 0]), 16);
    p.endFrame();
    p.poll(null, 33);
    expect(p.connected).toBe(false);
    expect(p.isDown('x')).toBe(false);
    expect(p.released('x')).toBe(true);
    expect(p.stick('left')).toEqual({ x: 0, y: 0 });
    expect(p.consume('x', 34)).toBe(false);
  });

  it('switches labels when another kind of pad is used', () => {
    const p = new PadState();
    p.poll(snap(), 0);
    expect(p.style).toBe('xbox');
    p.poll(snap([], undefined, {}, { id: 'DualSense Wireless Controller (Vendor: 054c)' }), 16);
    expect(p.style).toBe('ps');
  });
});

describe('PadGate', () => {
  it('ignores what was held when blocked until it is let go', () => {
    const p = new PadState();
    const g = new PadGate(p);
    p.poll(snap(['a'], [0, 0.9, 0, 0], { [PAD.rt]: 1 }), 0);
    g.blockHeld();
    expect(g.isDown('a')).toBe(false);
    expect(g.pressed('a')).toBe(false);
    expect(g.consume('a', 1)).toBe(false);
    expect(g.stick('left')).toEqual({ x: 0, y: 0 });
    expect(g.trigger('right')).toBe(0);
    p.endFrame();
    // Still held: still ignored, and releasing it is no "release" edge for this consumer.
    p.poll(snap(['a'], [0, 0.9, 0, 0], { [PAD.rt]: 1 }), 16);
    g.update();
    expect(g.isDown('a')).toBe(false);
    p.endFrame();
    p.poll(snap([], [0, 0, 0, 0]), 33);
    g.update();
    expect(g.released('a')).toBe(false);
    p.endFrame();
    // Pressed again: seen.
    p.poll(snap(['a'], [0, 0.9, 0, 0]), 50);
    g.update();
    expect(g.pressed('a')).toBe(true);
    expect(g.stick('left').y).toBeGreaterThan(0.8);
  });

  it('lets a worn stick or trigger go although it never reads exactly 0 at rest', () => {
    const p = new PadState();
    const g = new PadGate(p);
    p.poll(snap([], [0.9, 0, 0, 0], { [PAD.rt]: 1 }), 0);
    g.blockHeld();
    // Back to a resting drift just outside the deadzone (0.2 raw), trigger resting at 0.08.
    p.poll(snap([], [0.2, 0, 0, 0], { [PAD.rt]: 0.08 }), 16);
    g.update();
    p.poll(snap([], [1, 0, 0, 0], { [PAD.rt]: 1 }), 33);
    g.update();
    expect(g.stick('left').x).toBeGreaterThan(0.9);
    expect(g.trigger('right')).toBeGreaterThan(0.9);
    // A stick resting there is not blocked in the first place.
    const h = new PadGate(p);
    p.poll(snap([], [0.2, 0, 0, 0]), 50);
    h.blockHeld();
    p.poll(snap([], [1, 0, 0, 0]), 66);
    h.update();
    expect(h.stick('left').x).toBeGreaterThan(0.9);
  });

  it('two gates block independently', () => {
    const p = new PadState();
    const game = new PadGate(p);
    const menu = new PadGate(p);
    p.poll(snap(['down']), 0);
    game.blockHeld();
    expect(game.isDown('down')).toBe(false);
    expect(menu.isDown('down')).toBe(true);
  });
});

describe('menu directions', () => {
  it('reads the D-pad first, then the stick with hysteresis', () => {
    const p = new PadState();
    const g = new PadGate(p);
    p.poll(snap(['left'], [0, 0.9, 0, 0]), 0);
    expect(navDirection(g, null)).toBe('left');
    p.poll(snap([], [0, 0.75, 0, 0]), 16);
    expect(navDirection(g, null)).toBe('down');
    // A slightly diagonal stick keeps its direction until it drops under NAV_OFF.
    p.poll(snap([], [0.3, 0.45, 0, 0]), 33);
    expect(navDirection(g, null)).toBeNull();
    expect(navDirection(g, 'down')).toBe('down');
    p.poll(snap([], [0, 0.2, 0, 0]), 50);
    expect(navDirection(g, 'down')).toBeNull();
  });

  it('steps once on press, then repeats after a delay', () => {
    const r = new NavRepeat();
    expect(r.update('down', 0)).toBe('down');
    expect(r.update('down', 100)).toBeNull();
    expect(r.update('down', PAD_TUNING.NAV_DELAY_MS)).toBe('down');
    expect(r.update('down', PAD_TUNING.NAV_DELAY_MS + 10)).toBeNull();
    expect(r.update('down', PAD_TUNING.NAV_DELAY_MS + PAD_TUNING.NAV_RATE_MS)).toBe('down');
    expect(r.count).toBe(3);
    expect(r.update(null, 1000)).toBeNull();
    expect(r.update('up', 1001)).toBe('up');
    // A direction held when a menu opens never steps until released.
    r.hold('left');
    expect(r.update('left', 5000)).toBeNull();
    expect(r.update(null, 5001)).toBeNull();
    expect(r.update('left', 5002)).toBe('left');
  });
});
