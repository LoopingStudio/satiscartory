import * as THREE from 'three';

/** Sky colors of the relief map (the fog uses the horizon color, so far hills melt into it). */
export const SKY = {
  zenith: 0x5d97e6,
  horizon: 0xcfe4f7,
  sunGlow: 0xfff1d0,
} as const;

/**
 * Gradient sky (zenith to horizon, a warm glow toward the sun) on a sphere that follows the camera.
 * Drawn first, without depth, inside the camera's far plane.
 */
export class SkyDome {
  readonly mesh: THREE.Mesh;

  constructor(sunDir: THREE.Vector3) {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: new THREE.Color(SKY.zenith) },
        uHorizon: { value: new THREE.Color(SKY.horizon) },
        uGlow: { value: new THREE.Color(SKY.sunGlow) },
        uSun: { value: sunDir.clone().normalize() },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uGlow;
        uniform vec3 uSun;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float up = clamp(d.y, 0.0, 1.0);
          vec3 c = mix(uHorizon, uZenith, pow(up, 0.55));
          float s = max(dot(d, uSun), 0.0);
          c += uGlow * (0.22 * pow(s, 24.0) + 0.9 * pow(s, 900.0));
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), material);
    this.mesh.name = 'sky';
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  update(camera: THREE.Vector3): void {
    this.mesh.position.copy(camera);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
