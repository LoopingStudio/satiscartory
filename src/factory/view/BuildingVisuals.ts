import * as THREE from 'three';
import type { AssetLoader } from '../../core/assets/AssetLoader';
import { BUILDINGS, type BuildingType } from '../../data/buildings';
import { ITEMS } from '../../data/items';
import { RECIPES_BY_ID } from '../../data/recipes';
import { FACTORY_CELL } from '../../config/constants';
import { rotatedSize, type Rot } from '../sim/dirs';
import type { FactorySim } from '../sim/FactorySim';
import type { Building } from '../sim/types';
import type { ModelKey } from '../../core/assets/manifest.gen';

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

/** World position of the center of a footprint. */
export function footprintCenter(type: BuildingType, x: number, z: number, rot: Rot, out = new THREE.Vector3()): THREE.Vector3 {
  const [w, h] = BUILDINGS[type].footprint;
  const [rw, rh] = rotatedSize(w, h, rot);
  return out.set((x + rw / 2) * FACTORY_CELL, 0, (z + rh / 2) * FACTORY_CELL);
}

/** Builds the static model group of a building type (also used for build ghosts). */
export function buildModel(assets: AssetLoader, type: BuildingType): THREE.Group {
  const g = new THREE.Group();
  const add = (key: ModelKey, pos: [number, number, number], scale: [number, number, number] | number, name?: string) => {
    const o = assets.instantiate(key);
    o.position.set(...pos);
    if (typeof scale === 'number') o.scale.setScalar(scale);
    else o.scale.set(...scale);
    if (name) o.name = name;
    g.add(o);
    return o;
  };
  switch (type) {
    case 'conveyor':
      add('factory-kit/conveyor', [0, 0, 0], FACTORY_CELL);
      break;
    case 'press':
      add('factory-kit/machine', [0, 0, 0], [1.6, 1.6, 2.55]);
      add('factory-kit/piston-square', [0, 2.06, -0.9], 0.9, 'piston');
      break;
    case 'assembler':
      add('factory-kit/machine-window', [0, 0, 0], [1.6, 1.6, 2.55]);
      add('factory-kit/robot-arm-a', [0, 2.04, -1.0], 0.5, 'arm');
      break;
    case 'drill':
      add('factory-kit/machine-fortified', [0, 0, 0], [1.6, 1.6, 2.45]);
      add('factory-kit/piston-round', [0, 2.12, -0.9], 0.9, 'piston');
      break;
    case 'hub': {
      add('factory-kit/floor-large', [0, 0.01, 0], 3);
      add('factory-kit/hopper-high-square', [0, 0, 0], 2.6);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        add('factory-kit/structure-yellow-tall', [sx * 2.7, 0, sz * 2.7], [1.4, 1.6, 1.4]);
      }
      add('factory-kit/screen-panel-wide', [0, 0, 2.3], 1.6);
      break;
    }
  }
  return g;
}

/** Live visual of one building: model + status lamp + recipe icon + simple animations. */
export class BuildingVisual {
  readonly root = new THREE.Group();
  private lamp: THREE.Mesh | null = null;
  private icon: THREE.Object3D | null = null;
  private iconRecipe: string | null = null;
  private piston: THREE.Object3D | null = null;
  private pistonTop: THREE.Object3D | null = null;
  private arm: THREE.Object3D | null = null;
  private armParts: THREE.Object3D[] = [];
  private phase = Math.random() * 10;

  constructor(private readonly assets: AssetLoader, readonly building: Building) {
    const model = buildModel(assets, building.type);
    this.root.add(model);
    footprintCenter(building.type, building.x, building.z, building.rot, this.root.position);
    this.root.rotation.y = building.rot * (Math.PI / 2);
    this.root.userData.buildingId = building.id;
    model.traverse((o) => (o.userData.buildingId = building.id));
    this.piston = model.getObjectByName('piston') ?? null;
    this.pistonTop = this.piston?.getObjectByName('top') ?? null;
    this.arm = model.getObjectByName('arm') ?? null;
    if (this.arm) this.armParts = ['element-b', 'element-c', 'element-e'].map((n) => this.arm!.getObjectByName(n)).filter((o): o is THREE.Object3D => !!o);
    if (building.type !== 'conveyor' && building.type !== 'hub') {
      this.lamp = new THREE.Mesh(lampGeometry, statusMaterial('noRecipe'));
      this.lamp.position.set(0.6, 2.45, 1.1);
      this.root.add(this.lamp);
    }
  }

  update(sim: FactorySim, t: number): void {
    const b = this.building;
    let working = false;
    if (b.type === 'press' || b.type === 'assembler') {
      working = b.status === 'working';
      if (this.lamp) this.lamp.material = statusMaterial(b.status);
      if (b.recipe !== this.iconRecipe) this.setIcon(b.recipe);
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
    if (this.icon) {
      this.icon.rotation.y = t * 1.5;
      this.icon.position.y = 4.1 + Math.sin(t * 2) * 0.1;
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
    const icon = this.assets.instantiate(def.model);
    icon.scale.setScalar(def.beltScale * 0.8);
    icon.position.set(0, 4.1, 0);
    icon.traverse((o) => ((o as THREE.Mesh).castShadow = false));
    this.root.add(icon);
    this.icon = icon;
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}
