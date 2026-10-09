import * as THREE from 'three';
import { CAR_SCALE } from '../config/constants';
import { smokeAmount } from '../data/wear';
import type { CarModel } from './CarModel';
import { contactPoint, type CarGeometry } from './geometry';

/** Engine smoke and shock sparks of the driven car (CarFx). */
export const CAR_FX = {
  /** Puffs alive at once (the oldest is recycled when full). */
  SMOKE_CAP: 64,
  /** Puffs per second at full throttle, just above WEAR.SMOKE_ABOVE and at WEAR.MAX; idling smokes SMOKE_IDLE of it. */
  SMOKE_RATE: [5, 22],
  SMOKE_IDLE: 0.35,
  /** At most this many puffs per frame (a long frame does not dump a cloud). */
  SMOKE_PER_FRAME: 4,
  /** Life of a puff (s); × SMOKE_FAST_LIFE above SMOKE_FAST (m/s): the chase camera stays clear at speed. */
  SMOKE_LIFE: [0.9, 1.4],
  SMOKE_FAST: 15,
  SMOKE_FAST_LIFE: 0.6,
  /** Starting size (m); a puff grows to SMOKE_GROW times it, then shrinks away over its last 40 %. */
  SMOKE_SIZE: [0.12, 0.2],
  SMOKE_GROW: 2.5,
  /** Rise (m/s), spread (m/s), share of the car's speed a puff starts with, damping (1/s). */
  SMOKE_RISE: [1.2, 2],
  SMOKE_SPREAD: 0.55,
  SMOKE_CARRY: 0.25,
  SMOKE_DAMP: 1.5,
  /** Gray of a puff from just above the threshold to worn out (±10 %), and its opacity (no depth write: no sorting). */
  SMOKE_LIGHT: 0xc8c8c8,
  SMOKE_DARK: 0x5a5a5a,
  SMOKE_OPACITY: 0.6,
  /** Above this smoke amount (850 ‰), a cough of 3 dark puffs every 1 to 2 s. */
  COUGH_FROM: 0.5,
  SPARK_CAP: 96,
  /** Sparks of a shock: SPARK_BASE + SPARK_PER_PERMILLE × ‰ of its most hit part, within SPARKS. */
  SPARKS: [6, 32],
  SPARK_BASE: 6,
  SPARK_PER_PERMILLE: 0.6,
  /**
   * Speed (m/s) of a spark, fanned out along the surface hit (across the push, from side to side over the top), plus
   * SPARK_BOUNCE of it away from what was hit and SPARK_UP upward. Thrown along the push itself, they would fly through
   * the car (a head-on hit seen from the chase camera): along the wall, they spray out around it.
   */
  SPARK_SPEED: [4, 9],
  SPARK_BOUNCE: 0.35,
  SPARK_UP: 0.4,
  SPARK_LIFE: [0.25, 0.5],
  /** Thickness (m); a spark is stretched along its speed (SPARK_STRETCH s of travel). */
  SPARK_SIZE: 0.05,
  SPARK_STRETCH: 0.03,
  SPARK_GRAVITY: 20,
  SPARK_HOT: 0xfff0a0,
  SPARK_COLD: 0xff6a1a,
  /** Longest frame step (s): a hitch does not teleport the particles. */
  MAX_DT: 0.05,
} as const;

/** The last damage of a wear meter (car/wearMeter.ts WearHit), read in place. */
export interface ShockInfo {
  readonly seq: number;
  readonly cause: string;
  readonly permille: number;
  /** Direction (world, unit) the shock pushed the car: away from what was hit. */
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
}

/** A pooled particle (smoke puff or spark). Dead once age >= life. */
interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  size: number;
  color: THREE.Color;
}

const pool = (n: number): Particle[] =>
  Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 1, life: 0, size: 0, color: new THREE.Color() }));

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Wear effects of the driven car, owned by its mode (race, factory) and freed when it leaves: smoke out of a worn
 * engine (above WEAR.SMOKE_ABOVE, thicker at full throttle) and sparks where a shock hit the body. Two InstancedMesh
 * pools of fixed size (per-instance color, MineBursts' pattern): nothing is allocated once built, nothing drawn while
 * no particle lives. See-through puffs that write no depth: one draw, nothing to sort (grays blend in any order).
 * prewarm() compiles their shaders on entering the mode, so the first puff or spark does not stall a frame (after a
 * shadows toggle, core/Renderer.ts recompileForShadows compiles them again for the new setting).
 */
export class CarFx {
  readonly smoke: THREE.InstancedMesh;
  readonly sparks: THREE.InstancedMesh;
  private readonly puffs = pool(CAR_FX.SMOKE_CAP);
  private readonly bits = pool(CAR_FX.SPARK_CAP);
  private nextPuff = 0;
  private nextBit = 0;
  /** Last meter event seen: an older one never sparks. */
  private seq = 0;
  /** Puffs owed (fractions carried over frames). */
  private owed = 0;
  /** Seconds to the next cough. */
  private cough = 0;
  private disposed = false;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly qi = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly d = new THREE.Vector3();
  private readonly u = new THREE.Vector3();
  private readonly w = new THREE.Vector3();
  private readonly hit = { x: 0, y: 0, z: 0 };
  /** Puffs tumble slowly about this axis. */
  private readonly tumble = new THREE.Vector3(0.3, 1, 0.2).normalize();
  private readonly light = new THREE.Color(CAR_FX.SMOKE_LIGHT);
  private readonly dark = new THREE.Color(CAR_FX.SMOKE_DARK);
  private readonly hot = new THREE.Color(CAR_FX.SPARK_HOT);
  private readonly cold = new THREE.Color(CAR_FX.SPARK_COLD);
  private readonly tint = new THREE.Color();

  /** `rnd`: the randomness (tests pass a seeded one). */
  constructor(parent: THREE.Object3D, private readonly rnd: () => number = Math.random) {
    this.smoke = this.pooled(
      'car-smoke',
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: CAR_FX.SMOKE_OPACITY, depthWrite: false }),
      CAR_FX.SMOKE_CAP,
    );
    this.sparks = this.pooled('car-sparks', new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), CAR_FX.SPARK_CAP);
    parent.add(this.smoke, this.sparks);
  }

  private pooled(name: string, geo: THREE.BufferGeometry, mat: THREE.Material, cap: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    // The color buffer exists from the start: the shader compiled by prewarm() is the one drawn.
    for (let i = 0; i < cap; i++) mesh.setColorAt(i, this.tint.setRGB(1, 1, 1));
    return mesh;
  }

  /**
   * Compiles both pools' shaders for `scene` (its lights and fog set up already), while they are hidden: the first
   * puff or spark then draws without compiling. `renderer`: the WebGLRenderer (its compile()).
   */
  prewarm(renderer: Pick<THREE.WebGLRenderer, 'compile'>, camera: THREE.Camera, scene: THREE.Scene): void {
    if (this.disposed) return;
    renderer.compile(this.smoke, camera, scene);
    renderer.compile(this.sparks, camera, scene);
  }

  /** Follows a wear meter (null: none): its events so far are past and make no sparks. */
  follow(last: ShockInfo | null): void {
    this.seq = last?.seq ?? 0;
  }

  /**
   * Per fixed step, after the meter's: a new shock that wore the car (WearMeter.last: 1 ‰ or more) throws sparks from
   * the side of the body it hit, the car standing at `pos` / `quat` (world). A put-back makes none.
   */
  afterStep(last: ShockInfo, pos: THREE.Vector3, quat: THREE.Quaternion, g: CarGeometry): void {
    if (last.seq === this.seq) return;
    this.seq = last.seq;
    if (last.cause !== 'shock' || !(last.permille > 0) || this.disposed) return;
    // The push in the car's frame gives the side hit, back to the world.
    const d = this.d.set(last.dx, last.dy, last.dz);
    if (!(d.lengthSq() > 1e-12)) return;
    d.applyQuaternion(this.qi.copy(quat).invert());
    const c = contactPoint(g, d.x, d.z, CAR_SCALE, this.hit);
    const o = this.p.set(c.x, c.y, c.z).applyQuaternion(quat).add(pos);
    // The push (away from what was hit), and two axes across it: u as upward as can be, w sideways.
    d.set(last.dx, last.dy, last.dz).normalize();
    this.u.set(0, 1, 0);
    if (Math.abs(d.y) > 0.9) this.u.set(1, 0, 0);
    this.w.crossVectors(d, this.u).normalize();
    this.u.crossVectors(this.w, d);
    const n = Math.round(Math.min(CAR_FX.SPARKS[1], Math.max(CAR_FX.SPARKS[0], CAR_FX.SPARK_BASE + CAR_FX.SPARK_PER_PERMILLE * last.permille)));
    for (let i = 0; i < n; i++) {
      const b = this.bits[this.nextBit]!;
      this.nextBit = (this.nextBit + 1) % CAR_FX.SPARK_CAP;
      // A fan over the upper half of the surface hit (side to side over the top), then the bounce and the lift.
      const a = this.rnd() * Math.PI;
      const ca = Math.sin(a);
      const sa = Math.cos(a);
      const k = CAR_FX.SPARK_BOUNCE * (0.5 + this.rnd());
      const speed = lerp(CAR_FX.SPARK_SPEED[0], CAR_FX.SPARK_SPEED[1], this.rnd());
      b.x = o.x;
      b.y = o.y;
      b.z = o.z;
      b.vx = (this.u.x * ca + this.w.x * sa + d.x * k) * speed;
      b.vy = (this.u.y * ca + this.w.y * sa + d.y * k + CAR_FX.SPARK_UP) * speed;
      b.vz = (this.u.z * ca + this.w.z * sa + d.z * k) * speed;
      b.age = 0;
      b.life = lerp(CAR_FX.SPARK_LIFE[0], CAR_FX.SPARK_LIFE[1], this.rnd());
      b.size = CAR_FX.SPARK_SIZE;
    }
  }

  /**
   * Per frame: the worn engine of `model` (where it stands this frame) smokes, by its wear (‰) and the throttle
   * (0..1). `vel`: the car's velocity (m/s, world), `speed` its forward speed (m/s).
   */
  engine(dt: number, model: CarModel, vel: THREE.Vector3, engineWear: number, throttle: number, speed: number): void {
    const a = smokeAmount(engineWear);
    if (a <= 0 || this.disposed) {
      this.owed = 0;
      return;
    }
    dt = Math.min(Math.max(0, dt), CAR_FX.MAX_DT);
    const t = Math.min(1, Math.max(0, throttle));
    this.owed += lerp(CAR_FX.SMOKE_RATE[0], CAR_FX.SMOKE_RATE[1], a) * (CAR_FX.SMOKE_IDLE + (1 - CAR_FX.SMOKE_IDLE) * t) * dt;
    const root = model.root;
    const at = this.p.copy(model.engineAnchor).applyQuaternion(root.quaternion).add(root.position);
    const fast = Math.abs(speed) > CAR_FX.SMOKE_FAST;
    // The puff's gray: lighter just above the threshold, darker toward worn out.
    this.tint.copy(this.light).lerp(this.dark, a);
    for (let k = 0; k < CAR_FX.SMOKE_PER_FRAME && this.owed >= 1; k++) {
      this.owed -= 1;
      this.puff(at, vel, fast, this.tint);
    }
    this.owed = Math.min(this.owed, 1);
    // Nearly worn out: it coughs.
    if (a >= CAR_FX.COUGH_FROM) {
      this.cough -= dt;
      if (this.cough <= 0) {
        this.cough = 1 + this.rnd();
        for (let k = 0; k < 3; k++) this.puff(at, vel, fast, this.dark);
      }
    } else this.cough = 0;
  }

  private puff(at: THREE.Vector3, vel: THREE.Vector3, fast: boolean, color: THREE.Color): void {
    const f = this.puffs[this.nextPuff]!;
    this.nextPuff = (this.nextPuff + 1) % CAR_FX.SMOKE_CAP;
    const r = CAR_FX.SMOKE_SPREAD;
    f.x = at.x;
    f.y = at.y;
    f.z = at.z;
    f.vx = vel.x * CAR_FX.SMOKE_CARRY + (this.rnd() * 2 - 1) * r;
    f.vy = vel.y * CAR_FX.SMOKE_CARRY + lerp(CAR_FX.SMOKE_RISE[0], CAR_FX.SMOKE_RISE[1], this.rnd());
    f.vz = vel.z * CAR_FX.SMOKE_CARRY + (this.rnd() * 2 - 1) * r;
    f.age = 0;
    f.life = lerp(CAR_FX.SMOKE_LIFE[0], CAR_FX.SMOKE_LIFE[1], this.rnd()) * (fast ? CAR_FX.SMOKE_FAST_LIFE : 1);
    f.size = lerp(CAR_FX.SMOKE_SIZE[0], CAR_FX.SMOKE_SIZE[1], this.rnd());
    f.color.copy(color).multiplyScalar(0.9 + this.rnd() * 0.2);
  }

  /** Per frame (on foot too: the last puffs and sparks fade away): moves the particles and draws the living ones. */
  update(dt: number): void {
    if (this.disposed) return;
    dt = Math.min(Math.max(0, dt), CAR_FX.MAX_DT);
    const damp = Math.exp(-CAR_FX.SMOKE_DAMP * dt);
    let n = 0;
    for (const f of this.puffs) {
      if (f.age >= f.life) continue;
      f.age += dt;
      if (f.age >= f.life) continue;
      f.vx *= damp;
      f.vz *= damp;
      f.vy = f.vy * damp + (1 - damp) * CAR_FX.SMOKE_RISE[0];
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.z += f.vz * dt;
      const k = f.age / f.life;
      // Grows to SMOKE_GROW times its size, shrinks away over the last 40 % of its life.
      const sz = f.size * (1 + (CAR_FX.SMOKE_GROW - 1) * k) * Math.min(1, (1 - k) / 0.4, k * 12);
      this.q.setFromAxisAngle(this.tumble, f.age * 0.8 + f.size * 40);
      this.p.set(f.x, f.y, f.z);
      this.s.set(sz, sz * 0.85, sz);
      this.smoke.setMatrixAt(n, this.m.compose(this.p, this.q, this.s));
      this.smoke.setColorAt(n, f.color);
      n++;
    }
    this.show(this.smoke, n);
    n = 0;
    for (const b of this.bits) {
      if (b.age >= b.life) continue;
      b.age += dt;
      if (b.age >= b.life) continue;
      b.vy -= CAR_FX.SPARK_GRAVITY * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      const k = b.age / b.life;
      const v = Math.hypot(b.vx, b.vy, b.vz);
      // Stretched along its speed, cooling from yellow to orange.
      this.d.set(b.vx / (v || 1), b.vy / (v || 1), b.vz / (v || 1));
      this.q.setFromUnitVectors(this.u.set(0, 0, 1), v > 1e-6 ? this.d : this.u);
      const thick = b.size * (1 - k * k);
      this.p.set(b.x, b.y, b.z);
      this.s.set(thick, thick, thick + v * CAR_FX.SPARK_STRETCH);
      this.sparks.setMatrixAt(n, this.m.compose(this.p, this.q, this.s));
      this.sparks.setColorAt(n, this.tint.copy(this.hot).lerp(this.cold, k));
      n++;
    }
    this.show(this.sparks, n);
  }

  private show(mesh: THREE.InstancedMesh, n: number): void {
    mesh.count = n;
    mesh.visible = n > 0;
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Every particle gone at once (the car was moved: a new attempt). */
  clear(): void {
    for (const f of this.puffs) f.age = f.life;
    for (const b of this.bits) b.age = b.life;
    this.owed = 0;
    this.cough = 0;
    this.show(this.smoke, 0);
    this.show(this.sparks, 0);
  }

  /** Detaches both pools and frees their geometries and materials. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of [this.smoke, this.sparks]) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
  }
}
