import * as THREE from 'three';
import type { AssetLoader } from '../../core/assets/AssetLoader';
import { RAPIER } from '../../core/physics/PhysicsWorld';
import { BUILDINGS, type BuildingType } from '../../data/buildings';
import { PLAYER } from '../../data/player';
import { FACTORY_CELL } from '../../config/constants';
import { DX, DZ, rotatedSize, type Rot } from '../sim/dirs';
import type { FactorySim } from '../sim/FactorySim';
import type { FactoryWorld } from '../FactoryWorld';
import { buildModel, footprintCenter } from '../view/BuildingVisuals';
import type { PlaceCheck } from '../sim/types';
import type { Wallet } from '../../state/Inventory';
import { countLabel, type Inventory, type ItemId } from '../../data/items';

export type Tool = { kind: 'none' } | { kind: 'build'; type: BuildingType } | { kind: 'dismantle' };

export interface Aim {
  point: THREE.Vector3 | null;
  cell: [number, number] | null;
  buildingId: number | null;
}

const ghostOk = new THREE.MeshStandardMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.55, emissive: 0x1d6b3f, depthWrite: false });
const ghostBad = new THREE.MeshStandardMaterial({ color: 0xff5d5d, transparent: true, opacity: 0.55, emissive: 0x6b1d1d, depthWrite: false });
const arrowOut = new THREE.MeshBasicMaterial({ color: 0xffa31a });
const arrowIn = new THREE.MeshBasicMaterial({ color: 0x5ad1ff });
const arrowGeo = new THREE.ConeGeometry(0.28, 0.6, 12).rotateX(Math.PI / 2); // points +Z
const highlightMat = new THREE.MeshBasicMaterial({ color: 0xff5d5d, transparent: true, opacity: 0.35, depthWrite: false });
const hoverMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false });

function setGhostMaterial(root: THREE.Object3D, mat: THREE.Material): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !m.userData.keepMaterial) {
      m.material = mat;
      m.castShadow = false;
      m.receiveShadow = false;
    }
  });
}

export function describeError(check: PlaceCheck): string {
  switch (check.error) {
    case 'occupied':
      return 'Emplacement occupé';
    case 'outOfBounds':
      return 'Hors de la zone constructible';
    case 'needsNode':
      return 'La foreuse doit être posée sur un gisement';
    case 'notBuildable':
      return 'Non constructible';
    case 'cost': {
      const parts = Object.entries(check.missing ?? {}).map(([i, n]) => countLabel(i as ItemId, n ?? 0));
      return `Il manque ${parts.join(', ')}`;
    }
    default:
      return '';
  }
}

/** Ghost preview, conveyor drag-placement, dismantling and aiming in the factory. */
export class BuildController {
  tool: Tool = { kind: 'none' };
  rot: Rot = 0;
  aim: Aim = { point: null, cell: null, buildingId: null };
  /** Last placement check (for HUD messages). */
  lastCheck: PlaceCheck | null = null;
  onChange: (() => void) | null = null;
  onMessage: ((text: string, kind: 'info' | 'error' | 'success') => void) | null = null;

  private ghost: THREE.Group | null = null;
  private ghostType: BuildingType | null = null;
  private ghostValid = true;
  private dragStart: [number, number] | null = null;
  private dragPath: { x: number; z: number; rot: Rot }[] = [];
  private dragGhosts: THREE.Object3D[] = [];
  private highlight: THREE.Mesh;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

  constructor(
    private readonly assets: AssetLoader,
    private readonly sim: FactorySim,
    private readonly world: FactoryWorld,
    private readonly scene: THREE.Scene,
    /** Pays costs (backpack first, then hub) and receives dismantling refunds. */
    private readonly wallet: Wallet,
  ) {
    this.highlight = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), highlightMat);
    this.highlight.visible = false;
    this.highlight.renderOrder = 5;
    scene.add(this.highlight);
  }

  setTool(tool: Tool): void {
    this.clearGhost();
    this.clearDrag();
    this.tool = tool;
    this.onChange?.();
  }

  toggleDismantle(): void {
    this.setTool(this.tool.kind === 'dismantle' ? { kind: 'none' } : { kind: 'dismantle' });
  }

  rotate(dir: 1 | -1 = 1): void {
    this.rot = ((this.rot + dir + 4) & 3) as Rot;
    if (this.ghost) this.ghostType = null; // force refresh
  }

  /**
   * Aim from a world-space ray. In build mode the ray targets the ground plane
   * (so you can build behind machines); otherwise it hits the first collider
   * (to pick buildings for dismantling/interaction).
   */
  updateAim(origin: THREE.Vector3, dir: THREE.Vector3, player: THREE.Vector3, exclude: RAPIER.Collider): void {
    this.aim.point = null;
    this.aim.cell = null;
    this.aim.buildingId = null;
    let p: THREE.Vector3 | null = null;
    if (this.tool.kind === 'build') {
      if (dir.y < -1e-4) p = origin.clone().addScaledVector(dir, -origin.y / dir.y);
    } else {
      this.ray.origin = { x: origin.x, y: origin.y, z: origin.z };
      this.ray.dir = { x: dir.x, y: dir.y, z: dir.z };
      const hit = this.world.physics.world.castRay(this.ray, 120, true, undefined, undefined, exclude);
      if (hit) {
        p = origin.clone().addScaledVector(dir, hit.timeOfImpact);
        this.aim.buildingId = this.world.buildingOf(hit.collider);
      }
    }
    if (!p) return;
    const flat = Math.hypot(p.x - player.x, p.z - player.z);
    if (flat > PLAYER.REACH) {
      this.aim.buildingId = null;
      return;
    }
    this.aim.point = p;
    // Nudge slightly into the surface so side hits pick the cell of the touched building.
    const q = p.clone().addScaledVector(dir, 0.02);
    const cx = Math.floor(q.x / FACTORY_CELL);
    const cz = Math.floor(q.z / FACTORY_CELL);
    this.aim.cell = this.sim.inBounds(cx, cz) ? [cx, cz] : null;
    if (this.aim.buildingId === null && this.aim.cell && this.tool.kind === 'build') {
      this.aim.buildingId = this.sim.at(cx, cz)?.id ?? null;
    }
  }

  /** Anchor so that the rotated footprint is centered on the aimed cell. */
  private anchorFor(type: BuildingType, cell: [number, number]): [number, number] {
    const [w, h] = BUILDINGS[type].footprint;
    const [rw, rh] = rotatedSize(w, h, this.rot);
    return [cell[0] - Math.floor((rw - 1) / 2), cell[1] - Math.floor((rh - 1) / 2)];
  }

  update(): void {
    this.highlight.visible = false;
    if (this.tool.kind === 'build') this.updateBuild(this.tool.type);
    else if (this.tool.kind === 'dismantle') this.updateDismantle();
    else this.updateHover();
  }

  private updateBuild(type: BuildingType): void {
    if (this.dragStart) {
      this.updateDrag();
      return;
    }
    const cell = this.aim.cell;
    if (!cell) {
      if (this.ghost) this.ghost.visible = false;
      this.lastCheck = null;
      return;
    }
    if (!this.ghost || this.ghostType !== type) this.makeGhost(type);
    const [ax, az] = this.anchorFor(type, cell);
    const check = this.sim.check(type, ax, az, this.rot, { wallet: this.wallet });
    this.lastCheck = check;
    const ghost = this.ghost!;
    ghost.visible = true;
    footprintCenter(type, ax, az, this.rot, ghost.position);
    ghost.position.y = 0.02;
    ghost.rotation.y = this.rot * (Math.PI / 2);
    if (check.ok !== this.ghostValid) {
      this.ghostValid = check.ok;
      setGhostMaterial(ghost, check.ok ? ghostOk : ghostBad);
    }
  }

  private makeGhost(type: BuildingType): void {
    this.clearGhost();
    const g = buildModel(this.assets, type);
    setGhostMaterial(g, ghostOk);
    this.ghostValid = true;
    // Port arrows (local, unrotated footprint coordinates).
    const def = BUILDINGS[type];
    const [w, h] = def.footprint;
    for (const p of def.ports) {
      const arrow = new THREE.Mesh(arrowGeo, p.dir === 'out' ? arrowOut : arrowIn);
      arrow.userData.keepMaterial = true;
      const lx = (p.cell[0] + 0.5 - w / 2) * FACTORY_CELL + DX[p.side] * (FACTORY_CELL * 0.5 + 0.35);
      const lz = (p.cell[1] + 0.5 - h / 2) * FACTORY_CELL + DZ[p.side] * (FACTORY_CELL * 0.5 + 0.35);
      arrow.position.set(lx, 0.45, lz);
      const yaw = Math.atan2(DX[p.side], DZ[p.side]);
      arrow.rotation.y = p.dir === 'out' ? yaw : yaw + Math.PI;
      g.add(arrow);
    }
    this.ghost = g;
    this.ghostType = type;
    this.scene.add(g);
  }

  private clearGhost(): void {
    this.ghost?.removeFromParent();
    this.ghost = null;
    this.ghostType = null;
  }

  // ------------------------------------------------------------ conveyor drag

  private pathBetween(a: [number, number], b: [number, number]): { x: number; z: number; rot: Rot }[] {
    const cells: [number, number][] = [];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const sx = Math.sign(dx);
    const sz = Math.sign(dz);
    let x = a[0];
    let z = a[1];
    cells.push([x, z]);
    if (Math.abs(dx) >= Math.abs(dz)) {
      while (x !== b[0]) cells.push([(x += sx), z]);
      while (z !== b[1]) cells.push([x, (z += sz)]);
    } else {
      while (z !== b[1]) cells.push([x, (z += sz)]);
      while (x !== b[0]) cells.push([(x += sx), z]);
    }
    const dirOf = (from: [number, number], to: [number, number]): Rot =>
      to[0] > from[0] ? 1 : to[0] < from[0] ? 3 : to[1] > from[1] ? 0 : 2;
    return cells.map((c, i) => {
      let rot: Rot;
      if (cells.length === 1) rot = this.rot;
      else if (i < cells.length - 1) rot = dirOf(c, cells[i + 1]!);
      else rot = dirOf(cells[i - 1]!, c);
      return { x: c[0], z: c[1], rot };
    });
  }

  private updateDrag(): void {
    const end = this.aim.cell ?? this.dragStart!;
    const path = this.pathBetween(this.dragStart!, end).slice(0, 64);
    this.dragPath = path;
    while (this.dragGhosts.length < path.length) {
      const g = buildModel(this.assets, 'conveyor');
      setGhostMaterial(g, ghostOk);
      const arrow = new THREE.Mesh(arrowGeo, arrowOut);
      arrow.userData.keepMaterial = true;
      arrow.position.set(0, 1.0, 0.3);
      arrow.scale.setScalar(0.7);
      g.add(arrow);
      this.scene.add(g);
      this.dragGhosts.push(g);
    }
    let budget = this.wallet.count('plate');
    const cost = BUILDINGS.conveyor.cost.plate ?? 0;
    let okCount = 0;
    this.dragGhosts.forEach((g, i) => {
      const p = path[i];
      g.visible = !!p;
      if (!p) return;
      g.position.set((p.x + 0.5) * FACTORY_CELL, 0.02, (p.z + 0.5) * FACTORY_CELL);
      g.rotation.y = p.rot * (Math.PI / 2);
      const check = this.sim.check('conveyor', p.x, p.z, p.rot, { free: true });
      const affordable = budget >= cost;
      const ok = check.ok && affordable;
      if (ok) {
        budget -= cost;
        okCount++;
      }
      setGhostMaterial(g, ok ? ghostOk : ghostBad);
    });
    this.lastCheck = { ok: okCount === path.length, cells: [], error: okCount === path.length ? undefined : 'cost' };
    if (this.ghost) this.ghost.visible = false;
  }

  private clearDrag(): void {
    for (const g of this.dragGhosts) g.removeFromParent();
    this.dragGhosts = [];
    this.dragStart = null;
    this.dragPath = [];
  }

  // ------------------------------------------------------------ dismantle / hover

  private boxAround(id: number, mat: THREE.Material): void {
    const b = this.sim.buildings.get(id);
    if (!b) return;
    const [w, h] = BUILDINGS[b.type].footprint;
    const [rw, rh] = rotatedSize(w, h, b.rot);
    const height = b.type === 'conveyor' ? 1.0 : b.type === 'hub' ? 4.2 : b.type === 'drill' ? 4.1 : 2.6;
    footprintCenter(b.type, b.x, b.z, b.rot, this.highlight.position);
    this.highlight.position.y = height / 2;
    this.highlight.scale.set(rw * FACTORY_CELL + 0.1, height, rh * FACTORY_CELL + 0.1);
    this.highlight.material = mat;
    this.highlight.visible = true;
  }

  private updateDismantle(): void {
    const id = this.aim.buildingId;
    if (id !== null && BUILDINGS[this.sim.buildings.get(id)?.type ?? 'hub'].buildable) this.boxAround(id, highlightMat);
  }

  private updateHover(): void {
    const id = this.aim.buildingId;
    if (id === null) return;
    const b = this.sim.buildings.get(id);
    if (b && b.type !== 'conveyor') this.boxAround(id, hoverMat);
  }

  /** Building the player can interact with (E): machines, drills and the hub. */
  interactTarget(): number | null {
    const id = this.aim.buildingId;
    if (id === null) return null;
    const b = this.sim.buildings.get(id);
    return b && b.type !== 'conveyor' ? id : null;
  }

  // ------------------------------------------------------------ actions

  primaryDown(): void {
    if (this.tool.kind === 'build' && this.tool.type === 'conveyor' && this.aim.cell) {
      this.dragStart = [...this.aim.cell];
      this.updateDrag();
    }
  }

  primaryUp(): void {
    const tool = this.tool;
    if (tool.kind === 'build') {
      if (tool.type === 'conveyor') this.commitDrag();
      else this.placeSingle(tool.type);
    } else if (tool.kind === 'dismantle') {
      this.dismantleAimed();
    }
  }

  private placeSingle(type: BuildingType): void {
    if (!this.aim.cell) return;
    const [ax, az] = this.anchorFor(type, this.aim.cell);
    const r = this.sim.place(type, ax, az, this.rot, { wallet: this.wallet });
    if (r.ok) {
      this.onMessage?.(`${BUILDINGS[type].name} : construction terminée`, 'success');
      this.ghostType = null;
    } else {
      this.onMessage?.(describeError(r.check), 'error');
    }
    this.onChange?.();
  }

  private commitDrag(): void {
    if (!this.dragStart) return;
    const path = this.dragPath.length ? this.dragPath : this.pathBetween(this.dragStart, this.dragStart);
    let placed = 0;
    let lastError: PlaceCheck | null = null;
    for (const p of path) {
      const r = this.sim.place('conveyor', p.x, p.z, p.rot, { wallet: this.wallet });
      if (r.ok) placed++;
      else lastError = r.check;
    }
    if (path.length) this.rot = path[path.length - 1]!.rot;
    this.clearDrag();
    if (placed) this.onMessage?.(`${placed} convoyeur${placed > 1 ? 's' : ''} posé${placed > 1 ? 's' : ''}`, 'success');
    else if (lastError) this.onMessage?.(describeError(lastError), 'error');
    this.onChange?.();
  }

  private dismantleAimed(): void {
    const id = this.aim.buildingId;
    if (id === null) return;
    const b = this.sim.buildings.get(id);
    if (!b) return;
    if (!BUILDINGS[b.type].buildable) {
      this.onMessage?.('Le hangar central ne peut pas être démonté', 'error');
      return;
    }
    if (this.sim.remove(id, this.wallet)) this.onMessage?.(`${BUILDINGS[b.type].name} démonté (remboursé dans le sac)`, 'info');
    this.onChange?.();
  }

  cancel(): boolean {
    if (this.dragStart) {
      this.clearDrag();
      return true;
    }
    if (this.tool.kind !== 'none') {
      this.setTool({ kind: 'none' });
      return true;
    }
    return false;
  }

  get dragging(): boolean {
    return this.dragStart !== null;
  }

  costLabel(cost: Inventory): string {
    return Object.entries(cost)
      .map(([i, n]) => countLabel(i as ItemId, n ?? 0))
      .join(', ');
  }

  dispose(): void {
    this.clearGhost();
    this.clearDrag();
    this.highlight.removeFromParent();
  }
}
