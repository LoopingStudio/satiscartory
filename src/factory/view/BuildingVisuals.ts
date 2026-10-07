import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AssetLoader } from '../../core/assets/AssetLoader';
import { BUILDINGS, isBelt, type BuildingType } from '../../data/buildings';
import { DX, DZ } from '../sim/dirs';
import { BELT_TOP_Y, PORT_COLORS, smallArrowGeometry } from './portMarkers';
import { ITEMS } from '../../data/items';
import { RECIPES_BY_ID } from '../../data/recipes';
import { FACTORY_CELL } from '../../config/constants';
import { rotatedSize, type Rot } from '../sim/dirs';
import type { FactorySim } from '../sim/FactorySim';
import type { DeckPlane } from '../sim/terrain';
import { deckShear } from './terrain/deck';
import { isMachine, type Building } from '../sim/types';
import type { ModelKey } from '../../core/assets/manifest.gen';
import { HUB_BENCH } from './hubBench';
import { GARAGE, GARAGE_BAY, GARAGE_CLUTTER, GARAGE_DOOR, GARAGE_INNER, GARAGE_LINTEL, GARAGE_WALLS } from './garageLayout';

const STATUS_COLORS = { working: 0x3ddc84, idle: 0xffb347, blocked: 0xff5d5d, noRecipe: 0x8a8fb5 } as const;
const statusMaterials = new Map<string, THREE.MeshStandardMaterial>();
function statusMaterial(status: keyof typeof STATUS_COLORS): THREE.MeshStandardMaterial {
  let m = statusMaterials.get(status);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: STATUS_COLORS[status], emissive: STATUS_COLORS[status], emissiveIntensity: 0.8 });
    statusMaterials.set(status, m);
  }
  return m;
}
const lampGeometry = new THREE.SphereGeometry(0.22, 12, 8);

/** Tinted materials for icons of items that reuse a generic model (shared, never disposed). */
const tintMaterials = new Map<number, THREE.MeshStandardMaterial>();
function tintMaterial(color: number): THREE.MeshStandardMaterial {
  let m = tintMaterials.get(color);
  if (!m) tintMaterials.set(color, (m = new THREE.MeshStandardMaterial({ color, roughness: 0.8 })));
  return m;
}

/** Floating output icon: height above the ground and size of its largest dimension (meters). */
const ICON_Y = 4.1;
const ICON_SIZE = 0.9;

/** Molten core of the smelter (unit cylinder standing on y = 0). Live visuals clone the material to pulse it. */
const glowGeometry = new THREE.CylinderGeometry(1, 1, 1, 24).translate(0, 0.5, 0);
const glowMaterial = new THREE.MeshStandardMaterial({ color: 0x4a2a1c, emissive: 0xff6a1a, emissiveIntensity: 0.15, roughness: 0.5 });
const GLOW_NAME = 'smelter-glow';

/** Garage materials (kit palette; shared by every garage, never disposed). */
const garageMats = {
  wall: new THREE.MeshStandardMaterial({ color: 0x8585ab, roughness: 0.85 }),
  trim: new THREE.MeshStandardMaterial({ color: 0x494971, roughness: 0.8 }),
  frame: new THREE.MeshStandardMaterial({ color: 0xf0b36a, roughness: 0.7 }),
  beam: new THREE.MeshStandardMaterial({ color: 0x55557c, roughness: 0.7 }),
  paint: new THREE.MeshStandardMaterial({ color: 0xe4a35e, roughness: 0.9 }),
};
type GarageMat = keyof typeof garageMats;
/** Height of the floor slab (over resource patches, under the wheels' contact by little) and of the paint on it. */
const GARAGE_FLOOR_Y = 0.025;
const GARAGE_PAINT_Y = 0.037;
/** Console on the back wall: center height, half size of the display, depth of its frame. */
const GARAGE_SCREEN = { y: 1.75, halfW: 0.62, halfH: 0.35, depth: 0.08 } as const;
/** Sign on the outer face of the lintel over the door. */
const GARAGE_SIGN = { halfW: 1.5, bottom: 2.9, top: 3.42, depth: 0.06 } as const;
const signGeometry = new THREE.BoxGeometry(GARAGE_SIGN.halfW * 2, GARAGE_SIGN.top - GARAGE_SIGN.bottom, GARAGE_SIGN.depth);
const screenPlane = new THREE.PlaneGeometry(1, 1);

/** Static boxes and paint of the garage merged per material (built once from the shared layout, shared by every garage and ghost). */
let garageGeometries: Record<GarageMat, THREE.BufferGeometry> | null = null;
function garageGeometry(): Record<GarageMat, THREE.BufferGeometry> {
  if (garageGeometries) return garageGeometries;
  const parts: Record<GarageMat, THREE.BufferGeometry[]> = { wall: [], trim: [], frame: [], beam: [], paint: [] };
  const box = (mat: GarageMat, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
    parts[mat].push(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
  const paint = (x0: number, x1: number, z0: number, z1: number) =>
    parts.paint.push(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, GARAGE_PAINT_Y, (z0 + z1) / 2));
  const { height: H, post } = GARAGE;
  // Walls = the colliders, except that the side walls end at the door posts (Kenney trusses). Dark
  // skirting and cap bands stand 2 cm proud; at the back corners the back wall's bands cover the
  // corner and the side bands start after them (no coplanar faces).
  const e = 0.02;
  GARAGE_WALLS.forEach((w, i) => {
    const back = i === 0;
    const x0 = w.x - w.hx;
    const x1 = w.x + w.hx;
    const z0 = w.z - w.hz;
    const z1 = w.z + w.hz - (back ? 0 : post);
    box('wall', x0, x1, 0, H, z0, z1);
    for (const [y0, y1] of [[0, 0.4], [H - 0.15, H]] as const) {
      if (back) box('trim', x0 - e, x1 + e, y0, y1, z0 - e, z1 + e);
      else box('trim', x0 - e, x1 + e, y0, y1, z0 + e, z1);
    }
  });
  // Yellow lintel over the door (its front face recessed behind the sign), two roof beams (visual
  // only: no roof, open to the cameras).
  const li = GARAGE_LINTEL;
  box('frame', li.x - li.hx, li.x + li.hx, li.y - li.hy, li.y + li.hy, li.z - li.hz, li.z + li.hz - GARAGE_SIGN.depth);
  const dw = GARAGE_DOOR.halfWidth;
  for (const bz of [-1.3, 1.3]) box('beam', -dw, dw, H - 0.2, H - 0.05, bz - 0.08, bz + 0.08);
  // Console frame on the back wall.
  const { y: sy, halfW: shw, halfH: shh, depth: sd } = GARAGE_SCREEN;
  box('trim', -shw - 0.08, shw + 0.08, sy - shh - 0.08, sy + shh + 0.08, GARAGE_INNER.back, GARAGE_INNER.back + sd);
  // Painted bay outline (centered on the parking pose).
  const l = 0.1;
  const { halfW: bw, halfD: bd } = GARAGE_BAY;
  paint(-bw, -bw + l, -bd, bd);
  paint(bw - l, bw, -bd, bd);
  paint(-bw + l, bw - l, -bd, -bd + l);
  paint(-bw + l, bw - l, bd - l, bd);
  garageGeometries = Object.fromEntries(
    Object.entries(parts).map(([k, list]) => [k, mergeGeometries(list, false) ?? new THREE.BufferGeometry()]),
  ) as Record<GarageMat, THREE.BufferGeometry>;
  return garageGeometries;
}

/** Canvas texture (shared, never disposed); null outside a browser. */
function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  draw(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** « GARAGE » on a dark panel between hazard stripes. */
let garageSignMaterial: THREE.Material | null = null;
function signMaterial(): THREE.Material {
  garageSignMaterial ??= new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.6,
    // 576 × 100 px for the 3 × 0.52 m panel.
    map: canvasTexture(576, 100, (c) => {
      c.fillStyle = '#2f2f45';
      c.fillRect(0, 0, 576, 100);
      for (const x0 of [0, 516]) {
        c.save();
        c.beginPath();
        c.rect(x0, 0, 60, 100);
        c.clip();
        c.fillStyle = '#f0b36a';
        c.fillRect(x0, 0, 60, 100);
        c.fillStyle = '#2f2f45';
        for (let k = -100; k < 60; k += 32) {
          c.beginPath();
          c.moveTo(x0 + k, 100);
          c.lineTo(x0 + k + 16, 100);
          c.lineTo(x0 + k + 16 + 100, 0);
          c.lineTo(x0 + k + 100, 0);
          c.fill();
        }
        c.restore();
      }
      c.fillStyle = '#f0b36a';
      c.font = 'bold 66px system-ui, -apple-system, "Segoe UI", sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('GARAGE', 288, 54);
    }),
  });
  return garageSignMaterial;
}

/** Console display: a car profile on a blueprint grid (unlit, reads as a lit screen). */
let garageScreenMaterial: THREE.Material | null = null;
function screenMaterial(): THREE.Material {
  garageScreenMaterial ??= new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: canvasTexture(256, 144, (c) => {
      c.fillStyle = '#1b2340';
      c.fillRect(0, 0, 256, 144);
      c.strokeStyle = 'rgba(90, 209, 255, 0.18)';
      c.lineWidth = 1;
      c.beginPath();
      for (let x = 16; x < 256; x += 16) {
        c.moveTo(x + 0.5, 0);
        c.lineTo(x + 0.5, 144);
      }
      for (let y = 16; y < 144; y += 16) {
        c.moveTo(0, y + 0.5);
        c.lineTo(256, y + 0.5);
      }
      c.stroke();
      // Car profile (body, cabin, wheels).
      c.strokeStyle = '#5ad1ff';
      c.lineWidth = 4;
      c.lineJoin = 'round';
      c.beginPath();
      c.moveTo(40, 92);
      c.lineTo(40, 76);
      c.lineTo(78, 70);
      c.lineTo(104, 48);
      c.lineTo(160, 48);
      c.lineTo(188, 70);
      c.lineTo(216, 74);
      c.lineTo(216, 92);
      c.stroke();
      for (const x of [76, 180]) {
        c.beginPath();
        c.arc(x, 96, 14, 0, Math.PI * 2);
        c.stroke();
      }
      // Status bars.
      const bars: [number, string][] = [[0.8, '#3ddc84'], [0.55, '#ffb347'], [0.9, '#5ad1ff']];
      bars.forEach(([f, col], i) => {
        c.fillStyle = 'rgba(255, 255, 255, 0.12)';
        c.fillRect(24, 118 + i * 8 - 4, 208, 4);
        c.fillStyle = col;
        c.fillRect(24, 118 + i * 8 - 4, 208 * f, 4);
      });
    }),
  });
  return garageScreenMaterial;
}

/** Arrows painted on splitter / merger tops (shared, never disposed). */
const topArrowMaterial = new THREE.MeshBasicMaterial({ color: PORT_COLORS.out, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

/** Height of a building's model (highlight boxes, marks floated over it). */
export function buildingHeight(type: BuildingType): number {
  return isBelt(type) ? 1.0 : type === 'hub' || type === 'smelter' ? 4.2 : type === 'drill' ? 4.1 : type === 'garage' ? GARAGE.height + 0.05 : 3.0;
}

/** World position of the center of a footprint. */
export function footprintCenter(type: BuildingType, x: number, z: number, rot: Rot, out = new THREE.Vector3()): THREE.Vector3 {
  const [w, h] = BUILDINGS[type].footprint;
  const [rw, rh] = rotatedSize(w, h, rot);
  return out.set((x + rw / 2) * FACTORY_CELL, 0, (z + rh / 2) * FACTORY_CELL);
}

/** Builds the static model group of a building type (also used for build ghosts). */
export function buildModel(assets: AssetLoader, type: BuildingType): THREE.Group {
  const g = new THREE.Group();
  // Kenney machines are tunnels open on their long sides (native ±X). Machines are 2 cells
  // wide along X with items crossing along Z, so their parts are added in a quarter-turned frame
  // (frame x = building -Z, frame z = building +X).
  const machine = type === 'smelter' || type === 'press' || type === 'assembler';
  const body = machine ? new THREE.Group() : g;
  if (machine) {
    body.rotation.y = Math.PI / 2;
    g.add(body);
  }
  const add = (key: ModelKey, pos: [number, number, number], scale: [number, number, number] | number, name?: string) => {
    const o = assets.instantiate(key);
    o.position.set(...pos);
    if (typeof scale === 'number') o.scale.setScalar(scale);
    else o.scale.set(...scale);
    if (name) o.name = name;
    body.add(o);
    return o;
  };
  switch (type) {
    case 'conveyor':
      add('factory-kit/conveyor', [0, 0, 0], FACTORY_CELL);
      break;
    case 'splitter':
    case 'merger': {
      // The kit's crossing belt, with orange arrows on top: from the center to the three outputs
      // (splitter), from the three inputs to the center (merger).
      add('factory-kit/conveyor-cross', [0, 0, 0], FACTORY_CELL);
      const sides = BUILDINGS[type].ports.filter((p) => p.dir === (type === 'splitter' ? 'out' : 'in')).map((p) => p.side);
      for (const s of sides) {
        const a = new THREE.Mesh(smallArrowGeometry, topArrowMaterial);
        const toward = type === 'splitter' ? s : (s + 2) % 4;
        a.position.set(DX[s] * 0.55, BELT_TOP_Y + 0.02, DZ[s] * 0.55);
        a.rotation.y = Math.atan2(DX[toward]!, DZ[toward]!);
        g.add(a);
      }
      break;
    }
    case 'smelter': {
      // Foundry: the machine with a round hole in its roof over a glowing molten core, a slim round
      // chimney at one end and an orange valve at the other (press: plain roof + square piston;
      // assembler: windows + robot arm).
      add('factory-kit/machine-connection-hole', [0, 0, 0], [1.6, 1.6, 2.55]);
      const glow = new THREE.Mesh(glowGeometry, glowMaterial);
      glow.name = GLOW_NAME;
      // The roof hole has a radius of 0.3 model units: 0.48 m across the tunnel, 0.77 m along it.
      glow.scale.set(0.43, 1.98, 0.69);
      glow.position.y = 0.02;
      body.add(glow);
      // Not named 'piston'/'arm' (animated parts); its own child nodes are 'top' and 'arm'.
      add('factory-kit/piston-thin-round', [0, 1.88, -1.3], [0.8, 2.2, 0.8], 'chimney');
      // Valve wheel native on -Z: turned outward (building +X).
      add('factory-kit/pipe-large-valve', [0, 1.9, 1.2], 0.6).rotation.y = Math.PI;
      break;
    }
    case 'press':
      add('factory-kit/machine', [0, 0, 0], [1.6, 1.6, 2.55]);
      add('factory-kit/piston-square', [0, 2.06, -0.9], 0.9, 'piston');
      break;
    case 'assembler':
      add('factory-kit/machine-window', [0, 0, 0], [1.6, 1.6, 2.55]);
      add('factory-kit/robot-arm-a', [0, 2.04, -1.0], 0.5, 'arm');
      break;
    case 'drill':
      // Drilling rig (2×1, frame of the footprint): drill tower in a yellow frame + collecting hopper.
      add('factory-kit/structure-yellow-medium', [-1.75, 0, 0], [1.6, 2.4, 1.6]);
      add('factory-kit/structure-yellow-medium', [-0.25, 0, 0], [1.6, 2.4, 1.6]);
      add('factory-kit/piston-thin-round', [-1, 0, 0], [1.6, 2.4, 1.6]);
      add('factory-kit/piston-round', [-1, 2.4, 0], 1.3, 'piston');
      add('factory-kit/hopper-high-round', [1, 0, 0], 1.5);
      break;
    case 'hub': {
      add('factory-kit/floor-large', [0, 0.01, 0], 3);
      add('factory-kit/hopper-high-square', [0, 0, 0], 2.6);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        add('factory-kit/structure-yellow-tall', [sx * 2.7, 0, sz * 2.7], [1.4, 1.6, 1.4]);
      }
      add('factory-kit/screen-panel-wide', [0, 0, 2.3], 1.6);
      // Crafting bench (« Établi ») on the south face: two yellow trestles under a plank, a lever
      // (its 'handle' rocks while crafting) and a few parts lying around.
      const { z, halfW, halfD, top } = HUB_BENCH;
      const plank = 0.1;
      for (const sx of [-1, 1]) add('factory-kit/structure-yellow-short', [sx * (halfW - 0.3), 0, z], [1, (top - plank) / 0.5, (halfD - 0.04) / 0.55]);
      add('factory-kit/box-large', [0, top - plank, z], [halfW / 0.55, plank / 0.55, halfD / 0.5]);
      add('factory-kit/lever-single', [0.8, top, z + 0.12], 1.3, 'bench-lever');
      add('car-kit/debris-plate-small-a', [-0.2, top, z - 0.05], 1.4, 'bench-piece').rotation.y = 0.3;
      add('car-kit/debris-bolt', [-0.85, top, z + 0.2], 1.5).rotation.y = 0.6;
      add('car-kit/debris-bolt', [-0.6, top, z + 0.32], 1.5).rotation.y = -0.4;
      add('factory-kit/pipe-large-long', [0.25, top, z + 0.36], 0.16).rotation.y = 0.15;
      break;
    }
    case 'garage': {
      // Drive-in bay (layout in garageLayout): walls on three sides, the front (+Z) open as the door
      // between two yellow posts under a lintel with the sign, open top with two beams, a painted bay
      // around the parking pose, a console on the back wall and some clutter in the back corners.
      const geo = garageGeometry();
      for (const key of Object.keys(geo) as GarageMat[]) {
        const m = new THREE.Mesh(geo[key], garageMats[key]);
        m.castShadow = key !== 'paint';
        m.receiveShadow = true;
        g.add(m);
      }
      const { wall: T, post, height: H } = GARAGE;
      const inner = GARAGE_INNER;
      // Floor slab inside the walls (the bay floor has no collider: it is the factory ground).
      add('factory-kit/top-large', [0, GARAGE_FLOOR_Y, (inner.back + inner.front) / 2], [inner.halfW, 1, (inner.front - inner.back) / 2]);
      // Hazard stripes across the door.
      const tiles = 5;
      const tw = (2 * GARAGE_DOOR.halfWidth) / tiles;
      for (let i = 0; i < tiles; i++) {
        add('factory-kit/indicator-special-lines', [-GARAGE_DOOR.halfWidth + (i + 0.5) * tw, GARAGE_PAINT_Y, GARAGE_DOOR.z - 0.25], [tw, 1, 0.5]);
      }
      // Door posts: yellow trusses ending the side walls (truss plane along the wall).
      for (const sx of [-1, 1]) add('factory-kit/structure-yellow-tall', [sx * (inner.halfW + T / 2), 0, GARAGE_DOOR.z - post / 2], [T / 0.3, H / 2, post / 1.1]);
      // Sign on the lintel, facing out.
      const t = garageMats.trim;
      const sign = new THREE.Mesh(signGeometry, [t, t, t, t, signMaterial(), t]);
      sign.position.set(0, (GARAGE_SIGN.bottom + GARAGE_SIGN.top) / 2, GARAGE_DOOR.z - GARAGE_SIGN.depth / 2);
      sign.castShadow = true;
      g.add(sign);
      // Console display in its frame on the back wall.
      const screen = new THREE.Mesh(screenPlane, screenMaterial());
      screen.scale.set(GARAGE_SCREEN.halfW * 2, GARAGE_SCREEN.halfH * 2, 1);
      screen.position.set(0, GARAGE_SCREEN.y, inner.back + GARAGE_SCREEN.depth + 0.01);
      g.add(screen);
      // Clutter in the back corners (boxes of the layout): two tires lying flat (0.6 × 0.35 m model,
      // axis on X), two crates (1.1 × 0.55 × 1 m model).
      const { tires, crates } = GARAGE_CLUTTER;
      const tire = tires.hy;
      for (const k of [0, 1]) {
        add('car-kit/debris-tire', [tires.x, tire / 2 + k * tire, tires.z], [tire / 0.35, tires.hx / 0.3, tires.hz / 0.3]).rotation.set(0, k * 0.6, Math.PI / 2);
      }
      add('factory-kit/box-large', [crates.x, 0, crates.z], 0.8);
      add('factory-kit/box-large', [crates.x, 0.44, crates.z], 0.6).rotation.y = 0.35;
      break;
    }
    default: {
      // Compile-time check: every building type has a model.
      const missing: never = type;
      void missing;
    }
  }
  return g;
}

/** Live visual of one building: model + status lamp + recipe icon + simple animations. */
export class BuildingVisual {
  readonly root = new THREE.Group();
  /** Hub only: the player is crafting at the bench (set by FactoryView.setCrafting). */
  crafting = false;
  private lamp: THREE.Mesh | null = null;
  private icon: THREE.Object3D | null = null;
  private iconRecipe: string | null = null;
  private piston: THREE.Object3D | null = null;
  private pistonTop: THREE.Object3D | null = null;
  private arm: THREE.Object3D | null = null;
  private armParts: THREE.Object3D[] = [];
  /** Smelter core material (own clone, pulsed while working). */
  private glow: THREE.MeshStandardMaterial | null = null;
  private benchHandle: THREE.Object3D | null = null;
  private benchPiece: THREE.Object3D | null = null;
  private benchPieceY = 0;
  private lastT: number | null = null;
  private phase = Math.random() * 10;

  constructor(private readonly assets: AssetLoader, readonly building: Building) {
    const model = buildModel(assets, building.type);
    this.root.add(model);
    footprintCenter(building.type, building.x, building.z, building.rot, this.root.position);
    this.root.rotation.y = building.rot * (Math.PI / 2);
    this.root.userData.buildingId = building.id;
    model.traverse((o) => (o.userData.buildingId = building.id));
    // Animated parts are looked up per type: Kenney models reuse node names ('top', 'arm').
    const type = building.type;
    if (type === 'press' || type === 'drill') {
      this.piston = model.getObjectByName('piston') ?? null;
      this.pistonTop = this.piston?.getObjectByName('top') ?? null;
    }
    if (type === 'assembler') {
      this.arm = model.getObjectByName('arm') ?? null;
      if (this.arm) this.armParts = ['element-b', 'element-c', 'element-e'].map((n) => this.arm!.getObjectByName(n)).filter((o): o is THREE.Object3D => !!o);
    }
    if (type === 'smelter') {
      const core = model.getObjectByName(GLOW_NAME) as THREE.Mesh | undefined;
      if (core) {
        this.glow = glowMaterial.clone();
        core.material = this.glow;
        core.castShadow = false;
      }
    }
    if (type === 'hub') {
      this.benchHandle = model.getObjectByName('bench-lever')?.getObjectByName('handle') ?? null;
      this.benchPiece = model.getObjectByName('bench-piece') ?? null;
      this.benchPieceY = this.benchPiece?.position.y ?? 0;
    }
    if (!isBelt(type) && type !== 'hub' && type !== 'garage') {
      this.lamp = new THREE.Mesh(lampGeometry, statusMaterial('noRecipe'));
      if (type === 'drill') this.lamp.position.set(-1, 3.95, 0);
      else this.lamp.position.set(1.1, 2.45, -0.6);
      this.root.add(this.lamp);
    }
  }

  update(sim: FactorySim, t: number): void {
    const dt = this.lastT === null ? 0 : Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;
    const b = this.building;
    let working = false;
    if (isMachine(b)) {
      working = b.status === 'working';
      if (this.lamp) this.lamp.material = statusMaterial(b.status);
      if (b.recipe !== this.iconRecipe) this.setIcon(b.recipe);
      if (this.glow) {
        // Bright pulsing melt while working, embers when idle/blocked, almost cold without a recipe.
        const target = working ? 1.6 + 0.5 * Math.sin((t + this.phase) * 5) : b.status === 'noRecipe' ? 0.08 : 0.35;
        this.glow.emissiveIntensity += (target - this.glow.emissiveIntensity) * Math.min(1, dt * 6);
      }
    } else if (b.type === 'drill') {
      working = !!b.resource && b.outBuf.length < 5;
      if (this.lamp) this.lamp.material = statusMaterial(!b.resource ? 'noRecipe' : working ? 'working' : 'blocked');
    }
    const k = t + this.phase;
    if (this.pistonTop) this.pistonTop.position.y = working ? Math.abs(Math.sin(k * (b.type === 'drill' ? 6 : 4))) * -0.35 : 0;
    if (this.armParts.length === 3 && working) {
      this.armParts[0]!.rotation.y = Math.sin(k * 1.7) * 1.2;
      this.armParts[1]!.rotation.x = Math.sin(k * 2.3) * 0.5;
      this.armParts[2]!.rotation.x = Math.sin(k * 2.9 + 1) * 0.6;
    }
    if (this.benchHandle) {
      // Lever pumped left/right while crafting, eased back to rest otherwise; the work piece hops.
      const h = this.benchHandle;
      h.rotation.z = this.crafting ? Math.sin(t * 9) * 0.55 : h.rotation.z * Math.max(0, 1 - dt * 10);
      if (this.benchPiece) this.benchPiece.position.y = this.benchPieceY + (this.crafting ? Math.abs(Math.sin(t * 9)) * 0.05 : 0);
    }
    if (this.icon) {
      this.icon.rotation.y = t * 1.5;
      this.icon.position.y = ICON_Y + Math.sin(t * 2) * 0.1;
    }
    void sim;
  }

  private setIcon(recipeId: string | null): void {
    this.iconRecipe = recipeId;
    if (this.icon) {
      this.icon.removeFromParent();
      this.icon = null;
    }
    if (!recipeId) return;
    const out = RECIPES_BY_ID[recipeId]?.outputs[0];
    if (!out) return;
    const def = ITEMS[out.item];
    // Same size for every item (belt scales go from bolts to engines), centered on the spin axis,
    // with the belt yaw so long items (rods, axles) keep the orientation they have on belts.
    const model = this.assets.instantiate(def.model);
    const { bbox, size } = this.assets.info(def.model);
    const s = ICON_SIZE / Math.max(size.x, size.y, size.z, 0.01);
    model.scale.setScalar(s);
    bbox.getCenter(model.position).multiplyScalar(-s);
    const tint = def.tint !== undefined ? tintMaterial(def.tint) : null;
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      if (tint) mesh.material = tint;
    });
    const yawed = new THREE.Group();
    yawed.rotation.y = def.beltYaw ?? 0;
    yawed.add(model);
    const icon = new THREE.Group();
    icon.add(yawed);
    icon.position.set(0, ICON_Y, 0);
    this.root.add(icon);
    this.icon = icon;
  }

  /**
   * Puts the visual on the relief: a padded building on its pad, a splitter or merger laid on its deck
   * (sheared like the conveyors). No-op on a flat map. Call again when the ground under it changes.
   */
  placeOn(sim: FactorySim): void {
    if (sim.terrain.flat) return;
    const b = this.building;
    if (!isBelt(b.type)) {
      this.root.position.y = (b.py ?? 0) / 100;
      return;
    }
    const deck = sim.deckOf(b, DECK);
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrix();
    this.root.matrix.premultiply(deckShear(deck, b.x, b.z, SHEAR));
    this.root.matrixWorldNeedsUpdate = true;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.glow?.dispose();
    this.glow = null;
  }
}

const DECK: DeckPlane = { c: 0, sx: 0, sz: 0 };
const SHEAR = new THREE.Matrix4();
