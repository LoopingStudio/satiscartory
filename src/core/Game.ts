import * as THREE from 'three';
import { Renderer } from './Renderer';
import { Input } from './Input';
import { PointerLock } from './PointerLock';
import { AssetLoader } from './assets/AssetLoader';
import { ModeManager, type ModeName } from './ModeManager';
import { Loop } from './Loop';
import { el } from '../ui/dom';
import { PadNav } from '../ui/padNav';
import type { ItemIcons } from './assets/IconRenderer';

export interface DebugMode {
  /** Called when the F3 debug flag toggles. */
  setDebug?(enabled: boolean): void;
  /** Extra lines for the debug overlay. */
  debugInfo?(): string;
}

/** Root object: owns the renderer, input, assets, mode manager and the main loop. */
export class Game {
  readonly renderer: Renderer;
  readonly input: Input;
  readonly pointer: PointerLock;
  readonly assets = new AssetLoader();
  readonly modes = new ModeManager();
  readonly loop: Loop;
  /** Gamepad menu navigation (whatever the mode). */
  readonly padNav: PadNav;
  debug = false;
  /** Item icons (rendered from the 3D models after loading). */
  icons: ItemIcons | null = null;
  private overlay: HTMLElement | null = null;
  private overlayTimer = 0;
  private readonly factoryTickers = new Set<() => void>();
  private readonly frameListeners = new Set<(dt: number) => void>();
  private readonly modeListeners = new Set<(name: ModeName) => void>();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.input = new Input(canvas);
    this.pointer = new PointerLock(canvas);
    this.padNav = new PadNav(this.input);
    this.modes.onSwitch = (name) => {
      this.input.reset();
      this.applyDebug();
      for (const fn of this.modeListeners) fn(name);
    };
    this.loop = new Loop({
      poll: () => {
        this.input.poll();
        this.padNav.update(performance.now());
      },
      physics: (dt) => this.modes.current?.fixedUpdate(dt),
      factory: () => {
        for (const t of this.factoryTickers) t();
      },
      render: (dt, alpha) => this.frame(dt, alpha),
    });
  }

  /** Registers a 20 Hz callback that runs regardless of the active mode. */
  addFactoryTicker(fn: () => void): () => void {
    this.factoryTickers.add(fn);
    return () => this.factoryTickers.delete(fn);
  }

  /** Per-frame callback independent of the active mode (e.g. autosave timers). */
  addFrameListener(fn: (dt: number) => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  onModeChange(fn: (name: ModeName) => void): () => void {
    this.modeListeners.add(fn);
    return () => this.modeListeners.delete(fn);
  }

  switchMode(name: ModeName, params?: unknown): Promise<void> {
    return this.modes.switchTo(name, params);
  }

  start(): void {
    this.loop.start();
  }

  private frame(dt: number, alpha: number): void {
    if (this.input.wasPressed('debug')) {
      this.debug = !this.debug;
      this.applyDebug();
    }
    for (const fn of this.frameListeners) fn(dt);
    const mode = this.modes.current;
    if (mode) {
      mode.update(dt, alpha);
      this.renderer.render(mode.scene, mode.camera);
    }
    this.updateOverlay(dt);
    this.input.endFrame();
  }

  private applyDebug(): void {
    (this.modes.current as DebugMode | null)?.setDebug?.(this.debug);
    if (this.debug && !this.overlay) {
      this.overlay = el('div', { id: 'debug-overlay' });
      document.body.appendChild(this.overlay);
    } else if (!this.debug && this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  private updateOverlay(dt: number): void {
    if (!this.overlay) return;
    this.overlayTimer += dt;
    if (this.overlayTimer < 0.25) return;
    this.overlayTimer = 0;
    const info = this.renderer.three.info;
    const extra = (this.modes.current as DebugMode | null)?.debugInfo?.() ?? '';
    this.overlay.textContent =
      `FPS ${this.loop.fps}  mode ${this.modes.current?.name ?? '-'}\n` +
      `draw calls ${info.render.calls}  tris ${info.render.triangles}\n` +
      `geometries ${info.memory.geometries}  textures ${info.memory.textures}` +
      (extra ? `\n${extra}` : '');
  }

  /** Shared helper: a perspective camera kept in sync with the canvas size. */
  makeCamera(fov = 60, near = 0.1, far = 2000): { camera: THREE.PerspectiveCamera; dispose: () => void } {
    const camera = new THREE.PerspectiveCamera(fov, 1, near, far);
    const dispose = this.renderer.onResize((w, h) => {
      // A collapsed/hidden view reports 0×0: keep the last valid aspect instead of a degenerate one.
      if (w <= 0 || h <= 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    return { camera, dispose };
  }
}
