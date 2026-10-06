import * as THREE from 'three';
import type { Game } from '../core/Game';
import { FACTORY_CELL } from '../config/constants';

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
    clickButton(text: string) {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim().startsWith(text));
      b?.click();
      return !!b;
    },
  };
  Object.assign(window, { T });
}
