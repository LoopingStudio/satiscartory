import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AssetLoader } from '../core/assets/AssetLoader';
import { RAPIER, trimeshData } from '../core/physics/PhysicsWorld';
import { LEVEL_H, TRACK_CELL } from '../config/constants';
import { TRACK_PIECES, type GateKind } from '../data/trackPieces';
import { pieceSize } from './connectors';
import { pieceMatrix, ROAD_SURFACE, trackGates, trackSpawn, type Gate } from './layout';
import type { TrackData } from './TrackData';

/** Drivable road width (measured: ~0.85 tile including gutters). */
export const ROAD_WIDTH = 0.85 * TRACK_CELL;

export type { Gate };
export { ROAD_SURFACE, pieceMatrix };

export interface BuiltTrack {
  root: THREE.Group;
  /** Null when built without a physics world (editor preview). */
  road: RAPIER.Collider | null;
  ground: RAPIER.Collider | null;
  gates: Gate[];
  spawn: { position: THREE.Vector3; yaw: number };
  bounds: THREE.Box3;
  /** Lowest road surface height (for the fall-off respawn). */
  minY: number;
  dispose(): void;
}

const GATE_STYLE: Record<GateKind, { label: string; color: string; text: string }> = {
  start: { label: 'DÉPART', color: '#3ddc84', text: '#0b2a18' },
  checkpoint: { label: 'CHECKPOINT', color: '#5ad1ff', text: '#062633' },
  finish: { label: 'ARRIVÉE', color: '#ffffff', text: '#111111' },
};

function bannerTexture(kind: GateKind): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d')!;
  const s = GATE_STYLE[kind];
  if (kind === 'finish') {
    for (let x = 0; x < 512; x += 24) for (let y = 0; y < 96; y += 24) {
      g.fillStyle = ((x + y) / 24) % 2 ? '#111' : '#fff';
      g.fillRect(x, y, 24, 24);
    }
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillRect(96, 14, 320, 68);
  } else {
    g.fillStyle = s.color;
    g.fillRect(0, 0, 512, 96);
  }
  g.fillStyle = s.text;
  g.font = 'bold 54px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(s.label, 256, 50);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Builds visuals (one merged mesh), one road trimesh collider, gates and the spawn of a track. */
export function buildTrack(track: TrackData, assets: AssetLoader, world: RAPIER.World | null, opts: { ground?: boolean } = {}): BuiltTrack {
  const root = new THREE.Group();
  root.name = 'track';
  const disposables: { dispose(): void }[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  const bounds = new THREE.Box3();
  let minY = Infinity;

  for (const p of track.pieces) {
    const def = TRACK_PIECES[p.t];
    if (!def) continue;
    const pm = pieceMatrix(p, m);
    const g = assets.mergedGeometry(def.model).clone();
    g.applyMatrix4(pm);
    geos.push(g);
    g.computeBoundingBox();
    bounds.union(g.boundingBox!);
    for (const ex of def.extras ?? []) {
      const eg = assets.mergedGeometry(ex.model).clone();
      if (ex.rot) eg.applyMatrix4(new THREE.Matrix4().makeRotationY(ex.rot * (Math.PI / 2)));
      eg.applyMatrix4(pm);
      geos.push(eg);
    }
    minY = Math.min(minY, p.y * LEVEL_H + ROAD_SURFACE);
  }
  if (!Number.isFinite(minY)) minY = 0;

  let road: RAPIER.Collider | null = null;
  if (geos.length) {
    const merged = mergeGeometries(geos, false)!;
    for (const g of geos) g.dispose();
    const mesh = new THREE.Mesh(merged, assets.material('city-kit-roads'));
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.name = 'road';
    root.add(mesh);
    disposables.push(merged);
    if (world) {
      const { vertices, indices } = trimeshData(merged);
      road = world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(1));
    }
  }

  // Pillars under elevated pieces (visual only).
  const pillarGeo = assets.mergedGeometry('city-kit-roads/bridge-pillar-wide');
  const pillarMat = assets.material('city-kit-roads');
  const pillars: THREE.Matrix4[] = [];
  for (const p of track.pieces) {
    if (p.y <= 0 || !TRACK_PIECES[p.t]) continue;
    const [rw, rh] = pieceSize(p);
    const h = p.y * LEVEL_H;
    for (let dx = 0; dx < rw; dx++) for (let dz = 0; dz < rh; dz++) {
      const mm = new THREE.Matrix4().compose(
        new THREE.Vector3((p.x + dx + 0.5) * TRACK_CELL, 0, (p.z + dz + 0.5) * TRACK_CELL),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (p.r % 2) * (Math.PI / 2)),
        new THREE.Vector3(TRACK_CELL * 0.6, h / 0.5, TRACK_CELL * 0.6),
      );
      pillars.push(mm);
    }
  }
  if (pillars.length) {
    const inst = new THREE.InstancedMesh(pillarGeo, pillarMat, pillars.length);
    pillars.forEach((mm, i) => inst.setMatrixAt(i, mm));
    inst.castShadow = true;
    inst.receiveShadow = true;
    root.add(inst);
  }

  // Gates (layout from track/layout.ts) + posts and banners.
  const gates = trackGates(track);
  const postGeo = new THREE.BoxGeometry(0.9, 7, 0.9);
  disposables.push(postGeo);
  const postMat = new THREE.MeshStandardMaterial({ color: 0x3a3e63, roughness: 0.6 });
  disposables.push(postMat);
  for (const gate of gates) {
    const { center, forward, halfWidth, kind } = gate;
    const lateral = new THREE.Vector3(-forward.z, 0, forward.x);
    const g = new THREE.Group();
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.copy(center).addScaledVector(lateral, s * (halfWidth - 0.2)).add(new THREE.Vector3(0, 3.5, 0));
      post.castShadow = true;
      g.add(post);
      world?.createCollider(RAPIER.ColliderDesc.cuboid(0.45, 3.5, 0.45).setTranslation(post.position.x, post.position.y, post.position.z));
    }
    const tex = bannerTexture(kind);
    disposables.push(tex);
    const bannerMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, emissive: 0xffffff, emissiveIntensity: 0.25, emissiveMap: tex });
    disposables.push(bannerMat);
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_CELL - 0.4, 1.6), bannerMat);
    disposables.push(banner.geometry);
    banner.position.copy(center).add(new THREE.Vector3(0, 6.2, 0));
    // Face the oncoming car (banner normal = -forward), readable from both sides.
    banner.rotation.y = Math.atan2(-forward.x, -forward.z);
    bannerMat.side = THREE.DoubleSide;
    g.add(banner);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(TRACK_CELL - 0.2, 0.25, 0.3), postMat);
    disposables.push(beam.geometry);
    beam.position.copy(center).add(new THREE.Vector3(0, 7.05, 0));
    beam.rotation.y = Math.atan2(lateral.x, lateral.z) - Math.PI / 2;
    g.add(beam);
    root.add(g);
  }
  const spawn = trackSpawn(track, gates);

  // Ground ("grass"): drivable but slow, see RaceMode.
  const size = Math.max(400, bounds.isEmpty() ? 0 : bounds.getSize(new THREE.Vector3()).length() * 2);
  const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
  const groundGeo = new THREE.PlaneGeometry(size * 2, size * 2);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x6b7a5a, roughness: 1 });
  disposables.push(groundGeo, groundMat);
  if (opts.ground !== false) {
    const groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.position.set(center.x, -0.02, center.z);
    groundMesh.receiveShadow = true;
    root.add(groundMesh);
  }
  const ground = world ? world.createCollider(RAPIER.ColliderDesc.cuboid(size, 1, size).setTranslation(center.x, -1.02, center.z).setFriction(0.8)) : null;

  return {
    root,
    road,
    ground,
    gates,
    spawn,
    bounds,
    minY,
    dispose() {
      root.removeFromParent();
      for (const d of disposables) d.dispose();
    },
  };
}
