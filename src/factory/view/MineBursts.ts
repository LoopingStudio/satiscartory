import * as THREE from 'three';

/** Pool size (chunks alive at once); a new burst recycles the oldest chunks when full. */
const CAP = 96;
const PER_BURST = 9;
const GRAVITY = 14;

interface Chunk {
  x: number;
  y: number;
  /** Ground height it bounces on. */
  floor: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds since the burst; dead once age >= life. */
  age: number;
  life: number;
  size: number;
  spinX: number;
  spinY: number;
  color: THREE.Color;
}

/**
 * Rock chunks popping out of a resource node at each hand-mined ore: one InstancedMesh with a fixed pool
 * (per-instance color, no material per burst). Chunks jump, bounce once or twice and shrink away in ~0.5 s.
 */
export class MineBursts {
  readonly mesh: THREE.InstancedMesh;
  private readonly chunks: Chunk[] = [];
  private next = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();

  constructor(parent: THREE.Object3D) {
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.85 });
    this.mesh = new THREE.InstancedMesh(geo, mat, CAP);
    this.mesh.name = 'mine-bursts';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    for (let i = 0; i < CAP; i++) {
      this.chunks.push({ x: 0, y: 0, floor: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 1, life: 0, size: 0, spinX: 0, spinY: 0, color: new THREE.Color() });
      this.mesh.setColorAt(i, this.chunks[i]!.color);
    }
    parent.add(this.mesh);
  }

  /**
   * Spawns one burst at (x, y, z) in the given color (chunks get small shade variations); its chunks
   * bounce on the ground at `floor`.
   */
  burst(x: number, y: number, z: number, color: number, floor = 0): void {
    for (let n = 0; n < PER_BURST; n++) {
      const c = this.chunks[this.next]!;
      this.next = (this.next + 1) % CAP;
      const a = Math.random() * Math.PI * 2;
      const speed = 1.2 + Math.random() * 1.6;
      c.x = x + Math.cos(a) * 0.25;
      c.y = y;
      c.floor = floor;
      c.z = z + Math.sin(a) * 0.25;
      c.vx = Math.cos(a) * speed;
      c.vz = Math.sin(a) * speed;
      c.vy = 3.2 + Math.random() * 2;
      c.age = 0;
      c.life = 0.45 + Math.random() * 0.15;
      c.size = 0.07 + Math.random() * 0.08;
      c.spinX = (Math.random() - 0.5) * 16;
      c.spinY = (Math.random() - 0.5) * 16;
      c.color.setHex(color).multiplyScalar(0.8 + Math.random() * 0.45);
    }
  }

  update(dt: number): void {
    dt = Math.min(dt, 0.05);
    let n = 0;
    for (const c of this.chunks) {
      if (c.age >= c.life) continue;
      c.age += dt;
      if (c.age >= c.life) continue;
      c.vy -= GRAVITY * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.z += c.vz * dt;
      if (c.y < c.floor + c.size && c.vy < 0) {
        // Bounce on the ground, losing most of the energy.
        c.y = c.floor + c.size;
        c.vy *= -0.35;
        c.vx *= 0.6;
        c.vz *= 0.6;
      }
      const k = c.age / c.life;
      // Pops in fast, keeps its size, then shrinks away at the end of its life.
      const s = c.size * Math.min(1, k * 10) * (1 - k * k * k);
      this.e.set(c.age * c.spinX, c.age * c.spinY, 0);
      this.q.setFromEuler(this.e);
      this.s.set(s, s * 0.75, s);
      this.p.set(c.x, c.y, c.z);
      this.mesh.setMatrixAt(n, this.m.compose(this.p, this.q, this.s));
      this.mesh.setColorAt(n, c.color);
      n++;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
