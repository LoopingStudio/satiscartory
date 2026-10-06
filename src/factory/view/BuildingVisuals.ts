import * as THREE from 'three';
import type { AssetLoader } from '../../core/assets/AssetLoader';
import { BUILDINGS, type BuildingType } from '../../data/buildings';
import { ITEMS } from '../../data/items';
import { RECIPES_BY_ID } from '../../data/recipes';
import { FACTORY_CELL } from '../../config/constants';
import { rotatedSize, type Rot } from '../sim/dirs';
import type { FactorySim } from '../sim/FactorySim';
import { isMachine, type Building } from '../sim/types';
import type { ModelKey } from '../../core/assets/manifest.gen';
import { HUB_BENCH } from './hubBench';

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
    if (type !== 'conveyor' && type !== 'hub') {
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

  dispose(): void {
    this.root.removeFromParent();
    this.glow?.dispose();
    this.glow = null;
  }
}
