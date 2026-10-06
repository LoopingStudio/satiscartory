import type * as THREE from 'three';

export type ModeName = 'menu' | 'gallery' | 'factory' | 'garage' | 'editor' | 'race';

export interface Mode {
  readonly name: ModeName;
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  enter(params?: unknown): void | Promise<void>;
  exit(): void;
  /** 60 Hz fixed step. */
  fixedUpdate(dt: number): void;
  /** Per rendered frame. */
  update(dt: number, alpha: number): void;
}

export type ModeFactory = () => Mode;

/** Owns the active mode; modes are created fresh on each switch and disposed on exit. */
export class ModeManager {
  private factories = new Map<ModeName, ModeFactory>();
  current: Mode | null = null;
  private switching: Promise<void> | null = null;
  onSwitch: ((name: ModeName) => void) | null = null;

  register(name: ModeName, factory: ModeFactory): void {
    this.factories.set(name, factory);
  }

  has(name: ModeName): boolean {
    return this.factories.has(name);
  }

  async switchTo(name: ModeName, params?: unknown): Promise<void> {
    if (this.switching) await this.switching;
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Unknown mode ${name}`);
    this.switching = (async () => {
      const prev = this.current;
      this.current = null;
      prev?.exit();
      const next = factory();
      await next.enter(params);
      this.current = next;
      this.onSwitch?.(name);
    })();
    try {
      await this.switching;
    } finally {
      this.switching = null;
    }
  }
}
