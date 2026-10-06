/** Pointer-lock helper with safe re-lock handling (browsers reject quick re-locks). */
export class PointerLock {
  private listeners = new Set<(locked: boolean) => void>();

  constructor(private readonly element: HTMLElement) {
    document.addEventListener('pointerlockchange', this.onChange);
  }

  get locked(): boolean {
    return document.pointerLockElement === this.element;
  }

  async request(): Promise<boolean> {
    if (this.locked) return true;
    try {
      // unadjustedMovement is not supported everywhere: fall back to plain lock.
      await (this.element.requestPointerLock as (o?: unknown) => Promise<void>).call(this.element, { unadjustedMovement: true });
    } catch {
      try {
        await (this.element.requestPointerLock as () => Promise<void> | void).call(this.element);
      } catch {
        return false;
      }
    }
    return this.locked;
  }

  release(): void {
    if (this.locked) document.exitPointerLock();
  }

  subscribe(fn: (locked: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private onChange = () => {
    for (const fn of this.listeners) fn(this.locked);
  };
}
