import * as THREE from 'three';

/** WebGL renderer wrapper + standard lighting rig helpers. */
export class Renderer {
  readonly three: THREE.WebGLRenderer;
  private readonly onResizeCbs = new Set<(w: number, h: number) => void>();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.three = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.three.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.three.outputColorSpace = THREE.SRGBColorSpace;
    this.three.toneMapping = THREE.ACESFilmicToneMapping;
    this.three.toneMappingExposure = 1.0;
    this.three.shadowMap.enabled = true;
    this.three.shadowMap.type = THREE.PCFShadowMap;
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  get width(): number {
    return this.canvas.clientWidth;
  }

  get height(): number {
    return this.canvas.clientHeight;
  }

  onResize(cb: (w: number, h: number) => void): () => void {
    this.onResizeCbs.add(cb);
    cb(this.width, this.height);
    return () => this.onResizeCbs.delete(cb);
  }

  private resize = () => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (w <= 0 || h <= 0) return;
    this.three.setSize(w, h, false);
    for (const cb of this.onResizeCbs) cb(w, h);
  };

  /** Toggles shadow rendering (materials recompile on the next frame). */
  setShadows(enabled: boolean): void {
    if (this.three.shadowMap.enabled === enabled) return;
    this.three.shadowMap.enabled = enabled;
    this.shadowsChanged = true;
  }

  private shadowsChanged = false;

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.shadowsChanged) {
      this.shadowsChanged = false;
      scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
        else if (m) m.needsUpdate = true;
      });
    }
    this.three.render(scene, camera);
  }
}

export interface LightRig {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  /** Keeps the shadow camera centered on a point of interest. */
  follow(target: THREE.Vector3): void;
  /** Removes the lights and frees the sun's shadow map (each mode builds its own rig on enter). */
  dispose(): void;
}

export interface LightRigOptions {
  shadowSize?: number;
  /** Background and fog color. */
  sky?: number;
  /** Hemisphere light: sky and ground bounce colors, intensity. */
  hemiSky?: number;
  ground?: number;
  hemiIntensity?: number;
  sunColor?: number;
  sunIntensity?: number;
  /** Sun position relative to the followed point. */
  sunOffset?: THREE.Vector3;
  fog?: [number, number];
}

/** Sky color, fog, hemisphere + shadow-casting sun. */
export function addLightRig(scene: THREE.Scene, opts: LightRigOptions = {}): LightRig {
  const sky = opts.sky ?? 0x9fb4e8;
  scene.background = new THREE.Color(sky);
  if (opts.fog) scene.fog = new THREE.Fog(sky, opts.fog[0], opts.fog[1]);

  const hemi = new THREE.HemisphereLight(opts.hemiSky ?? 0xdfe6ff, opts.ground ?? 0x4a4e66, opts.hemiIntensity ?? 1.6);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(opts.sunColor ?? 0xfff2dd, opts.sunIntensity ?? 2.2);
  const offset = opts.sunOffset?.clone() ?? new THREE.Vector3(30, 60, 20);
  sun.position.copy(offset);
  sun.castShadow = true;
  const size = opts.shadowSize ?? 40;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -size;
  sun.shadow.camera.right = size;
  sun.shadow.camera.top = size;
  sun.shadow.camera.bottom = -size;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 200;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);

  const texel = (size * 2) / 2048;
  return {
    sun,
    hemi,
    follow(target: THREE.Vector3) {
      // Snap to shadow texels to avoid shimmering (height too: walking up and down hills).
      const x = Math.round(target.x / texel) * texel;
      const y = Math.round(target.y / texel) * texel;
      const z = Math.round(target.z / texel) * texel;
      sun.target.position.set(x, y, z);
      sun.position.set(x + offset.x, y + offset.y, z + offset.z);
    },
    dispose() {
      scene.remove(hemi, sun, sun.target);
      sun.dispose();
      hemi.dispose();
    },
  };
}
