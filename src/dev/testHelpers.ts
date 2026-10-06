import * as THREE from 'three';
import type { Game } from '../core/Game';
import { FACTORY_CELL } from '../config/constants';
import { Bot } from '../race/bot';

/**
 * Dev-only automation helpers exposed as `window.T` (used to drive the game from
 * the browser console / automated checks with synthetic input events).
 */
export function installTestHelpers(game: Game): void {
  const canvas = game.renderer.canvas;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const mode = () => game.modes.current as unknown as Record<string, any>;
  const T = {
    sleep,
    game,
    mode,
    async key(code: string, ms = 60) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      await sleep(ms);
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      await sleep(40);
    },
    down(code: string) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    },
    up(code: string) {
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
    },
    screenOf(world: THREE.Vector3) {
      const cam = mode().camera as THREE.Camera;
      const v = world.clone().project(cam);
      const r = canvas.getBoundingClientRect();
      return { cx: r.left + ((v.x + 1) / 2) * r.width, cy: r.top + ((1 - v.y) / 2) * r.height, onScreen: Math.abs(v.x) < 1 && Math.abs(v.y) < 1 && v.z < 1 };
    },
    screenOfCell(x: number, z: number, y = 0) {
      return T.screenOf(new THREE.Vector3((x + 0.5) * FACTORY_CELL, y, (z + 0.5) * FACTORY_CELL));
    },
    move(cx: number, cy: number, dx = 0, dy = 0) {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: cy, movementX: dx, movementY: dy, bubbles: true }));
    },
    async aimCell(x: number, z: number) {
      const s = T.screenOfCell(x, z);
      T.move(s.cx, s.cy);
      await sleep(100);
      return s;
    },
    async click(button = 0, hold = 60) {
      canvas.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true }));
      await sleep(hold);
      window.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true }));
      await sleep(100);
    },
    async drag(a: [number, number], b: [number, number]) {
      await T.aimCell(a[0], a[1]);
      canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      await sleep(100);
      await T.aimCell(b[0], b[1]);
      await sleep(150);
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
      await sleep(120);
    },
    /**
     * Drives the current race car through world-space XZ waypoints with real key
     * events (W/S/A/D). Resolves when the last waypoint is reached or on timeout.
     */
    async autopilot(points: [number, number, number?][], opts: { timeoutMs?: number; latAccel?: number; braking?: number } = {}) {
      const timeout = opts.timeoutMs ?? 60000;
      const t0 = performance.now();
      const bot = new Bot(points, Math.sqrt((opts.latAccel ?? 32) / 32), opts.braking ?? 14);
      const held = new Set<string>();
      const set = (code: string, on: boolean) => {
        if (on && !held.has(code)) { T.down(code); held.add(code); }
        if (!on && held.has(code)) { T.up(code); held.delete(code); }
      };
      let last = performance.now();
      try {
        while (performance.now() - t0 < timeout) {
          const st = mode().debugState?.();
          if (!st || st.finished) break;
          const now = performance.now();
          const c = bot.controls({ x: st.pos[0], z: st.pos[2], heading: (st.heading * Math.PI) / 180, speed: st.speedKmh / 3.6 }, (now - last) / 1000);
          last = now;
          // Real key presses (digital): steer threshold, throttle/brake.
          set('KeyA', c.steer > 0.15);
          set('KeyD', c.steer < -0.15);
          set('KeyW', c.throttle > 0.5);
          set('KeyS', c.brake > 0.5);
          await sleep(25);
        }
      } finally {
        for (const code of [...held]) set(code, false);
      }
      return { reached: bot.index, of: points.length, ms: Math.round(performance.now() - t0), finished: !!mode().debugState?.().finished };
    },
    /** Starts the autopilot in the background (for tools with call timeouts); poll T.run. */
    startAutopilot(points: [number, number, number?][], opts: { timeoutMs?: number; latAccel?: number; braking?: number } = {}) {
      (T as Record<string, unknown>).run = { done: false };
      void T.autopilot(points, opts).then((r) => ((T as Record<string, unknown>).run = { done: true, ...r }));
    },
    clickButton(text: string) {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim().startsWith(text));
      b?.click();
      return !!b;
    },
  };
  Object.assign(window, { T });
}
