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
    this.three.setSize(w, h, false);
    for (const cb of this.onResizeCbs) cb(w, h);
  };

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.three.render(scene, camera);
  }
}

export interface LightRig {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  /** Keeps the shadow camera centered on a point of interest. */
  follow(target: THREE.Vector3): void;
}

/** Sky color, fog, hemisphere + shadow-casting sun. */
export function addLightRig(
  scene: THREE.Scene,
  opts: { shadowSize?: number; sky?: number; ground?: number; fog?: [number, number] } = {},
): LightRig {
  const sky = opts.sky ?? 0x9fb4e8;
  scene.background = new THREE.Color(sky);
  if (opts.fog) scene.fog = new THREE.Fog(sky, opts.fog[0], opts.fog[1]);

  const hemi = new THREE.HemisphereLight(0xdfe6ff, opts.ground ?? 0x4a4e66, 1.6);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
  const offset = new THREE.Vector3(30, 60, 20);
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
      // Snap to shadow texels to avoid shimmering.
      const x = Math.round(target.x / texel) * texel;
      const z = Math.round(target.z / texel) * texel;
      sun.target.position.set(x, target.y, z);
      sun.position.set(x + offset.x, target.y + offset.y, z + offset.z);
    },
  };
}
