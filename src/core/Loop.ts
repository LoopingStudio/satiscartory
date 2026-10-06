import { FACTORY_DT, MAX_FRAME_DT, MAX_PHYS_STEPS_PER_FRAME, PHYS_DT } from '../config/constants';

export interface LoopCallbacks {
  /** 60 Hz fixed step (physics, character, vehicle, race timer). */
  physics(dt: number): void;
  /** 20 Hz fixed step (factory simulation). */
  factory(): void;
  /** Once per rendered frame; alphas interpolate between previous and current fixed states. */
  render(dt: number, physAlpha: number, factoryAlpha: number): void;
}

/** requestAnimationFrame loop with two independent fixed-step accumulators. */
export class Loop {
  private physAcc = 0;
  private factoryAcc = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  /** Multiplier applied to the factory clock (dev fast-forward). */
  factorySpeed = 1;
  fps = 0;
  /** Interpolation factor between the last two factory ticks (0..1). */
  factoryAlpha = 0;
  private fpsFrames = 0;
  private fpsTime = 0;

  constructor(private readonly cb: LoopCallbacks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      this.frame(now);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private frame(now: number): void {
    // Time spent in a background tab is dropped rather than caught up.
    const dt = Math.min((now - this.last) / 1000, MAX_FRAME_DT);
    this.last = now;

    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsTime);
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }

    this.physAcc += dt;
    let steps = 0;
    while (this.physAcc >= PHYS_DT && steps < MAX_PHYS_STEPS_PER_FRAME) {
      this.cb.physics(PHYS_DT);
      this.physAcc -= PHYS_DT;
      steps++;
    }
    if (steps >= MAX_PHYS_STEPS_PER_FRAME) this.physAcc = 0;

    this.factoryAcc += dt * this.factorySpeed;
    let fsteps = 0;
    while (this.factoryAcc >= FACTORY_DT && fsteps < 64) {
      this.cb.factory();
      this.factoryAcc -= FACTORY_DT;
      fsteps++;
    }
    if (fsteps >= 64) this.factoryAcc = 0;

    this.factoryAlpha = Math.min(1, this.factoryAcc / FACTORY_DT);
    this.cb.render(dt, this.physAcc / PHYS_DT, this.factoryAlpha);
  }
}
