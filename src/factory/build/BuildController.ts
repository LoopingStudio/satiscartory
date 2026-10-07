import * as THREE from 'three';
import type { AssetLoader } from '../../core/assets/AssetLoader';
import { RAPIER } from '../../core/physics/PhysicsWorld';
import { BUILDINGS, isBelt, type BuildingType } from '../../data/buildings';
import { PLAYER } from '../../data/player';
import { FACTORY_CELL } from '../../config/constants';
import { DX, DZ, opposite, rotatedSize, type Rot } from '../sim/dirs';
import type { FactorySim } from '../sim/FactorySim';
import type { FactoryWorld } from '../FactoryWorld';
import { buildModel, buildingHeight, footprintCenter } from '../view/BuildingVisuals';
import { GARAGE } from '../view/garageLayout';
import { GARAGE_DOOR_SIDE } from '../../garage/parking';
import type { Building, PlaceCheck, Placement, PlanLinks } from '../sim/types';
import { endCell, planDrag, snapConveyorRot, startCell, steals, type DragEnd } from '../sim/planning';
import { POINTER_Y, PORT_COLORS, crossGeometry, pointerGeometry, portMarker, sharedPointer, yawOf } from '../view/portMarkers';
import { deckShear } from '../view/terrain/deck';
import type { DeckPlane } from '../sim/terrain';
import type { Wallet } from '../../state/Inventory';
import { countLabel, type Inventory, type ItemId } from '../../data/items';
import { HAND } from '../../data/balance';
import type { ResourceId } from '../../data/factoryMap';
import { TERRAIN_RULES } from '../../data/factoryTerrain';

export type Tool = { kind: 'none' } | { kind: 'build'; type: BuildingType } | { kind: 'dismantle' };

export interface Aim {
  point: THREE.Vector3 | null;
  cell: [number, number] | null;
  buildingId: number | null;
  /** The ground aimed at, within reach, is past the edge of the grid. */
  outside: boolean;
}

const ghostOk = new THREE.MeshStandardMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.55, emissive: 0x1d6b3f, depthWrite: false });
const ghostBad = new THREE.MeshStandardMaterial({ color: 0xff5d5d, transparent: true, opacity: 0.55, emissive: 0x6b1d1d, depthWrite: false });
const arrowOut = new THREE.MeshBasicMaterial({ color: PORT_COLORS.out });
const arrowIn = new THREE.MeshBasicMaterial({ color: PORT_COLORS.in });
const arrowGeo = new THREE.ConeGeometry(0.28, 0.6, 12).rotateX(Math.PI / 2); // points +Z
const highlightMat = new THREE.MeshBasicMaterial({ color: 0xff5d5d, transparent: true, opacity: 0.35, depthWrite: false });
const hoverMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false });
/** The rest of an aimed belt's line (what holding E picks up), brighter as the hold progresses. */
const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.13, depthWrite: false });
/** Unit box of the line highlight, shared by its instanced mesh as it grows (never disposed). */
const lineBox = new THREE.BoxGeometry(1, 1, 1);
/** Unit box with its top at y = 0 (the fill under a ghost's pad). */
const slabBox = new THREE.BoxGeometry(1, 1, 1).translate(0, -0.5, 0);
const UP = new THREE.Vector3(0, 1, 0);
/** Per side: the two corners (offsets from the cell's lowest corner) of that edge. */
const EDGE_CORNERS: Record<number, [[number, number], [number, number]]> = {
  0: [[0, 1], [1, 1]],
  1: [[1, 0], [1, 1]],
  2: [[0, 0], [1, 0]],
  3: [[0, 0], [0, 1]],
};
/** Hollow buildings (garage) get edges + a floor tint instead of a box that would tint the view from inside. */
const outlineMats = {
  dismantle: { edges: new THREE.LineBasicMaterial({ color: 0xff5d5d, transparent: true, opacity: 0.9, depthWrite: false }), floor: highlightMat },
  hover: { edges: new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false }), floor: hoverMat },
};
type HighlightKind = keyof typeof outlineMats;

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

/** A placement check, possibly vetoed by BuildController.placementGuard (error 'blocked' + its message). */
export type BuildCheck = Omit<PlaceCheck, 'error'> & { error?: PlaceCheck['error'] | 'blocked'; message?: string };

/**
 * What the ghost would connect to: buildings feeding it, buildings it feeds, what blocks its output (a
 * building or the map edge), machines whose output it would take away from their current line.
 */
export interface LinkSummary {
  from: BuildingType[];
  to: BuildingType[];
  blockedBy: BuildingType | 'edge' | 'terrain' | null;
  steals: BuildingType[];
}

/** HUD text for a link summary ('' when the ghost connects to nothing). */
export function describeLinks(s: LinkSummary | null): string {
  if (!s) return '';
  const names = (types: BuildingType[]) => [...new Set(types)].map((t) => BUILDINGS[t].name).join(', ');
  const parts: string[] = [];
  if (s.from.length) parts.push(`reçoit : ${names(s.from)}`);
  if (s.to.length) parts.push(`alimente : ${names(s.to)}`);
  const ok = parts.length ? `<span class="good">✓ ${parts.join(' · ')}</span>` : '';
  const steal = s.steals.length ? `<span class="bad">⚠ prend la sortie de : ${names(s.steals)} (sa ligne actuelle n’aura plus rien)</span>` : '';
  const bad =
    s.blockedBy === 'edge'
      ? '<span class="bad">✕ sortie vers le bord de la carte</span>'
      : s.blockedBy === 'terrain'
        ? '<span class="bad">✕ sortie vers une pente trop forte ou l’eau : aucun convoyeur n’y tient</span>'
        : s.blockedBy
          ? `<span class="bad">✕ sortie bloquée par : ${BUILDINGS[s.blockedBy].name}</span>`
          : '';
  return [ok, steal, bad].filter(Boolean).join(' · ');
}

/** Slope of a gradient in cm per 2 m cell, in whole degrees. */
function degrees(cmPerCell: number): number {
  return Math.round((Math.atan(cmPerCell / 200) * 180) / Math.PI);
}

/** Centimeters as « 1,2 m ». */
function meters(cm: number): string {
  return `${(cm / 100).toFixed(1).replace('.', ',')} m`;
}

/**
 * Earthworks of a placeable padded building, from 25 cm: « fondation +0,4 m » where its pad stands above
 * the ground, « déblai 0,6 m » where it is dug in.
 */
export function describeFill(check: BuildCheck | null): string {
  if (!check?.ok) return '';
  const parts: string[] = [];
  if ((check.fill ?? 0) >= 25) parts.push(`fondation +${meters(check.fill!)}`);
  if ((check.cut ?? 0) >= 25) parts.push(`déblai ${meters(check.cut!)}`);
  return parts.join(' · ');
}

export function describeError(check: BuildCheck): string {
  switch (check.error) {
    case 'blocked':
      return check.message ?? 'Emplacement bloqué';
    case 'occupied':
      return 'Emplacement occupé';
    case 'outOfBounds':
      return 'Hors de la zone constructible';
    case 'needsNode':
      return 'La foreuse doit être posée sur un gisement';
    case 'notBuildable':
      return 'Non constructible';
    case 'water':
      return 'Dans l’eau : impossible de construire ici';
    case 'steep': {
      const R = TERRAIN_RULES;
      switch (check.detail) {
        case 'belt':
          return `Trop en pente pour un convoyeur : ${degrees(check.grad ?? 0)}° (${degrees(R.BELT_GRAD)}° au plus)`;
        case 'twist':
          return 'Sol trop tordu pour un convoyeur';
        case 'relief':
          return `Trop de dénivelé sous le bâtiment : ${meters(check.relief ?? 0)} (${meters(R.PAD_RELIEF)} au plus)`;
        case 'cut':
          return `Trop de terre à creuser ou remblayer : ${meters(check.cutFill ?? 0)} (${meters(R.PAD_CUT_FILL)} au plus)`;
        case 'door':
          return 'Devant la porte, le sol est trop en pente pour sortir en voiture';
        default:
          return `Terrain trop en pente : ${degrees(check.grad ?? 0)}° (${degrees(R.PAD_GRAD)}° au plus sous un bâtiment)`;
      }
    }
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
  aim: Aim = { point: null, cell: null, buildingId: null, outside: false };
  /** Player position at the last aim update (hand-mining reach). */
  private playerPos = new THREE.Vector3();
  /** The last aim ray hit the ground itself (not a car or a building): hand mining only then. */
  private aimGround = false;
  /** Last placement check (for HUD messages). */
  lastCheck: BuildCheck | null = null;
  /** What the current ghost or drag would connect to (for HUD messages). */
  lastLinks: LinkSummary | null = null;
  onChange: (() => void) | null = null;
  onMessage: ((text: string, kind: 'info' | 'error' | 'success') => void) | null = null;
  /**
   * Veto on placing any building (checked live for the ghost and again on click, after the grid
   * checks and before the cost one): returns a message to block, null to allow.
   */
  placementGuard: ((cells: [number, number][], type: BuildingType) => string | null) | null = null;
  /** Veto on dismantling a building: returns a message to block, null to allow. */
  dismantleGuard: ((b: Building) => string | null) | null = null;

  private ghost: THREE.Group | null = null;
  private ghostType: BuildingType | null = null;
  private ghostValid = true;
  /** Port markers of a building ghost, by port index (in the scene, on the ground in front of each port). */
  private ghostPorts: ReturnType<typeof portMarker>[] = [];
  /** Relief: the fill under a building ghost's pad (a translucent slab from the lowest corner up). */
  private slab: THREE.Mesh;
  private readonly deck: DeckPlane = { c: 0, sx: 0, sz: 0 };
  private readonly shear = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  /** Single conveyor ghost: where it stands and how it is turned (after snapping). */
  private shown: { x: number; z: number; rot: Rot } | null = null;
  /** Cell where R turned the single conveyor ghost by hand: no snapping there until the aim leaves it. */
  private rotOverride: string | null = null;
  /** Progress (0..1) of holding E on a belt to pick up its whole line, null when not holding (set by FactoryMode). */
  beltProgress: number | null = null;
  /** Boxes over the tiles of the aimed belt's line. */
  private lineMesh: THREE.InstancedMesh | null = null;
  private lineCache: { id: number; version: number; ids: number[] } | null = null;
  /** Connection marks (green arrows at linked edges) and the dead-end cross. */
  private linkMarks: THREE.Mesh[] = [];
  private deadMark: THREE.Mesh;
  private dragStart: DragEnd | null = null;
  /** Where the drag was pressed: while the aim stays on that cell (or building), it is a click, not a drag. */
  private dragAim: { cell: [number, number]; building: number | null } | null = null;
  /** The drag ends on a belt that its last tile merges into: that end is not placed. */
  private dragMerge = false;
  private dragPath: { x: number; z: number; rot: Rot }[] = [];
  private dragGhosts: THREE.Object3D[] = [];
  private highlight: THREE.Mesh;
  /** Outline of a hollow building: box edges + floor tint (unit size, scaled per building). */
  private outline = new THREE.Group();
  private outlineEdges: THREE.LineSegments;
  private outlineFloor: THREE.Mesh;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

  constructor(
    private readonly assets: AssetLoader,
    private readonly sim: FactorySim,
    private readonly world: FactoryWorld,
    private readonly scene: THREE.Scene,
    /** Pays costs (backpack first, then hub) and receives dismantling refunds. */
    private readonly wallet: Wallet,
  ) {
    this.deadMark = new THREE.Mesh(crossGeometry, sharedPointer.dead);
    this.deadMark.visible = false;
    this.deadMark.renderOrder = 6;
    scene.add(this.deadMark);
    this.highlight = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), highlightMat);
    this.highlight.visible = false;
    this.highlight.renderOrder = 5;
    scene.add(this.highlight);
    this.outlineEdges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)), outlineMats.hover.edges);
    this.outlineFloor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), hoverMat);
    this.outlineEdges.position.y = 0.02;
    this.outlineFloor.position.y = 0.06;
    this.outline.add(this.outlineEdges, this.outlineFloor);
    this.outline.visible = false;
    this.outline.renderOrder = 5;
    scene.add(this.outline);
    this.slab = new THREE.Mesh(slabBox, ghostOk);
    this.slab.visible = false;
    this.slab.renderOrder = 4;
    scene.add(this.slab);
  }

  // ------------------------------------------------------------ relief heights

  private get relief(): boolean {
    return !this.sim.terrain.flat;
  }

  /** Height (m) of the middle of a cell's edge on side `side` (ground as it is now). */
  private edgeY(cx: number, cz: number, side: number): number {
    if (!this.relief) return 0;
    const t = this.sim.terrain;
    const [[a, b], [c, d]] = EDGE_CORNERS[side]!;
    return (t.effAt(cx + a, cz + b) + t.effAt(cx + c, cz + d)) / 200;
  }

  /** Lays a ghost tile (a conveyor at x, z, rot, with its arrow) on the deck it would ride on. */
  private placeTile(g: THREE.Object3D, x: number, z: number, rot: Rot): void {
    if (!this.relief) {
      g.matrixAutoUpdate = true;
      g.position.set((x + 0.5) * FACTORY_CELL, 0.02, (z + 0.5) * FACTORY_CELL);
      g.rotation.set(0, rot * (Math.PI / 2), 0);
      return;
    }
    const deck = this.sim.terrain.deckPlane(x, z, rot, this.deck);
    g.matrixAutoUpdate = false;
    this.q.setFromAxisAngle(UP, rot * (Math.PI / 2));
    g.matrix.compose(this.v.set((x + 0.5) * FACTORY_CELL, 0.02, (z + 0.5) * FACTORY_CELL), this.q, this.one).premultiply(deckShear(deck, x, z, this.shear));
    g.matrixWorldNeedsUpdate = true;
  }

  /** Puts a building ghost's port markers on the ground in front of its ports. */
  private placeGhostPorts(plan: Placement): void {
    const ports = BUILDINGS[plan.type].ports;
    this.ghostPorts.forEach((marker, i) => {
      const p = ports[i]!;
      const w = this.sim.portWorld(plan, p.cell, p.side);
      const fx = w.cx + DX[w.side];
      const fz = w.cz + DZ[w.side];
      const x = (fx + 0.5) * FACTORY_CELL;
      const z = (fz + 0.5) * FACTORY_CELL;
      this.q.setFromAxisAngle(UP, yawOf(w.side) + (p.dir === 'in' ? Math.PI : 0));
      marker.matrix.compose(this.v.set(x, 0, z), this.q, this.one);
      if (this.relief) {
        const t = this.sim.terrain;
        const plane = t.deckPlane(Math.max(0, Math.min(this.sim.width - 1, fx)), Math.max(0, Math.min(this.sim.height - 1, fz)), null, this.deck);
        marker.matrix.premultiply(deckShear(plane, fx, fz, this.shear));
      }
      marker.matrixWorldNeedsUpdate = true;
    });
  }

  setTool(tool: Tool): void {
    this.clearGhost();
    this.clearDrag();
    this.hideLinks();
    this.lastLinks = null;
    this.rotOverride = null;
    this.tool = tool;
    this.onChange?.();
  }

  toggleDismantle(): void {
    this.setTool(this.tool.kind === 'dismantle' ? { kind: 'none' } : { kind: 'dismantle' });
  }

  rotate(dir: 1 | -1 = 1): void {
    if (this.dragStart && this.dragPath.length === 1) {
      // Button held on a single tile: same as on the hover ghost.
      const t = this.dragPath[0]!;
      this.rot = ((t.rot + dir + 4) & 3) as Rot;
      this.rotOverride = `${t.x},${t.z}`;
      return;
    }
    if (this.shown && !this.dragStart) {
      // Single conveyor: turn from what the ghost shows (snapped or not), and stop snapping on this cell.
      this.rot = ((this.shown.rot + dir + 4) & 3) as Rot;
      this.rotOverride = `${this.shown.x},${this.shown.z}`;
      return;
    }
    this.rot = ((this.rot + dir + 4) & 3) as Rot;
    if (this.ghost) this.ghostType = null; // force refresh
  }

  /**
   * Aim from a world-space ray. In build mode the ray only sees the ground (so you can build behind
   * machines, while hills still block it); otherwise it hits the first collider (to pick buildings for
   * dismantling/interaction). Hollow buildings (garage) have no floor collider: a ray reaching the ground
   * inside their footprint picks them.
   */
  updateAim(origin: THREE.Vector3, dir: THREE.Vector3, player: THREE.Vector3, exclude: RAPIER.Collider): void {
    this.aim.point = null;
    this.aim.cell = null;
    this.aim.buildingId = null;
    this.aim.outside = false;
    this.aimGround = false;
    this.playerPos.copy(player);
    let p: THREE.Vector3 | null = null;
    let ground = false;
    this.ray.origin = { x: origin.x, y: origin.y, z: origin.z };
    this.ray.dir = { x: dir.x, y: dir.y, z: dir.z };
    const world = this.world.physics.world;
    const hit =
      this.tool.kind === 'build'
        ? world.castRay(this.ray, 120, true, undefined, undefined, exclude, undefined, (c) => this.world.isGround(c))
        : world.castRay(this.ray, 120, true, undefined, undefined, exclude, undefined, (c) => !this.world.isDecor(c));
    if (hit) {
      p = origin.clone().addScaledVector(dir, hit.timeOfImpact);
      if (this.tool.kind !== 'build') this.aim.buildingId = this.world.buildingOf(hit.collider);
      ground = this.world.isGround(hit.collider);
    }
    if (!p) return;
    const flat = Math.hypot(p.x - player.x, p.z - player.z);
    if (flat > PLAYER.REACH) {
      this.aim.buildingId = null;
      return;
    }
    this.aimGround = ground;
    this.aim.point = p;
    // Nudge slightly into the surface so side hits pick the cell of the touched building.
    const q = p.clone().addScaledVector(dir, 0.02);
    const cx = Math.floor(q.x / FACTORY_CELL);
    const cz = Math.floor(q.z / FACTORY_CELL);
    this.aim.cell = this.sim.inBounds(cx, cz) ? [cx, cz] : null;
    this.aim.outside = !this.aim.cell;
    if (this.aim.buildingId === null && this.aim.cell) {
      const b = this.sim.at(cx, cz);
      if (b && (this.tool.kind === 'build' || (ground && BUILDINGS[b.type].hollow))) this.aim.buildingId = b.id;
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
    this.outline.visible = false;
    if (this.lineMesh) this.lineMesh.count = 0;
    this.shown = null;
    this.lastLinks = null;
    this.hideLinks();
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
    this.slab.visible = false;
    if (!cell) {
      if (this.ghost) this.ghost.visible = false;
      for (const m of this.ghostPorts) m.visible = false;
      // Ground within reach past the edge of the grid: say why nothing shows.
      this.lastCheck = this.aim.outside ? { ok: false, error: 'outOfBounds', cells: [] } : null;
      return;
    }
    if (!this.ghost || this.ghostType !== type) this.makeGhost(type);
    let ax: number;
    let az: number;
    let rot = this.rot;
    if (type === 'conveyor') {
      [ax, az] = startCell(this.sim, cell, this.aimPoint()).cell;
      rot = this.conveyorRot(ax, az);
      this.shown = { x: ax, z: az, rot };
    } else [ax, az] = this.anchorFor(type, cell);
    const check = this.checkPlacement(type, ax, az, rot);
    this.lastCheck = check;
    const ghost = this.ghost!;
    ghost.visible = true;
    const plan: Placement[] = [{ type, x: ax, z: az, rot }];
    let base = 0;
    if (type === 'conveyor') this.placeTile(ghost, ax, az, rot);
    else {
      footprintCenter(type, ax, az, rot, ghost.position);
      // On the relief, a padded building stands on the pad it would get, its fill shown under it.
      if (this.relief) {
        const py = check.py ?? this.sim.padPlan(type, ax, az, rot).py;
        base = py / 100;
        const [w, h] = BUILDINGS[type].footprint;
        const [rw, rh] = rotatedSize(w, h, rot);
        const t = this.sim.terrain;
        let low = Infinity;
        for (let i = ax; i <= ax + rw; i++) for (let j = az; j <= az + rh; j++) low = Math.min(low, t.baseAt(i, j));
        const fill = py - low;
        if (fill >= 10) {
          this.slab.position.set(ghost.position.x, base, ghost.position.z);
          this.slab.scale.set(rw * FACTORY_CELL, fill / 100, rh * FACTORY_CELL);
          this.slab.material = check.ok ? ghostOk : ghostBad;
          this.slab.visible = true;
        }
      }
      ghost.position.y = base + 0.02;
      ghost.rotation.y = rot * (Math.PI / 2);
      this.placeGhostPorts(plan[0]!);
    }
    if (check.ok !== this.ghostValid) {
      this.ghostValid = check.ok;
      setGhostMaterial(ghost, check.ok ? ghostOk : ghostBad);
    }
    // Connections it would make (only where it can stand).
    const links = cellsFree(check) ? this.sim.planLinks(plan) : null;
    if (links) this.showLinks(plan, links, type === 'conveyor');
    if (type === 'conveyor') return;
    const ports = BUILDINGS[type].ports;
    if (!links) {
      // Where it cannot stand: plain markers (no state left over from the last spot).
      this.ghostPorts.forEach((marker, i) => {
        marker.visible = true;
        marker.setColor(ports[i]!.dir);
      });
      return;
    }
    // Machine ghost: outputs green when they would link (the others hidden, a building outputs through one
    // port only); when every output faces a building or the map edge, a red cross over its output face.
    // A splitter outputs through all its ports: none is hidden for another.
    const outLinked = !!links[0]!.out && !BUILDINGS[type].multiOut;
    let blocked: BuildingType | 'edge' | 'terrain' | null = null;
    const faces: [number, number][] = [];
    if (!links[0]!.out) {
      const fronts = ports.filter((p) => p.dir === 'out').map((p) => {
        const w = this.sim.portWorld(plan[0]!, p.cell, p.side);
        faces.push([(w.cx + 0.5 + DX[w.side] * 0.3) * FACTORY_CELL, (w.cz + 0.5 + DZ[w.side] * 0.3) * FACTORY_CELL]);
        const nx = w.cx + DX[w.side];
        const nz = w.cz + DZ[w.side];
        if (!this.sim.inBounds(nx, nz)) return 'edge';
        return this.sim.at(nx, nz)?.type ?? (this.sim.beltFitsBeside(nx, nz, plan[0]!, this.lastCheck?.py) ? 'free' : 'terrain');
      });
      if (fronts.length && !fronts.includes('free')) {
        blocked = (fronts.find((f) => f !== 'edge' && f !== 'terrain') as BuildingType | undefined) ?? (fronts.includes('terrain') ? 'terrain' : 'edge');
      }
    }
    this.ghostPorts.forEach((marker, i) => {
      const p = ports[i]!;
      const linked = portLinked(this.sim, plan[0]!, i, links[0]!);
      // Blocked outputs: their markers would sit inside the blocking building, the cross shows instead
      // (a splitter: each unlinked output facing a building).
      const w = this.sim.portWorld(plan[0]!, p.cell, p.side);
      const fx = w.cx + DX[w.side];
      const fz = w.cz + DZ[w.side];
      const faced = !!this.sim.at(fx, fz) || (this.sim.inBounds(fx, fz) && !this.sim.beltFitsBeside(fx, fz, plan[0]!, this.lastCheck?.py));
      marker.visible = !(p.dir === 'out' && ((outLinked && !linked) || blocked || (!linked && faced && BUILDINGS[type].multiOut)));
      marker.setColor(linked ? 'linked' : p.dir);
    });
    if (blocked && this.lastLinks) {
      this.lastLinks.blockedBy = blocked;
      const fx = faces.reduce((a, f) => a + f[0], 0) / faces.length;
      const fz = faces.reduce((a, f) => a + f[1], 0) / faces.length;
      this.deadMark.position.set(fx, base + buildingHeight(type) + 0.6, fz);
      this.deadMark.visible = true;
    }
  }

  /** Aimed point in cell units (fractional). */
  private aimPoint(): [number, number] | undefined {
    const p = this.aim.point;
    return p ? [p.x / FACTORY_CELL, p.z / FACTORY_CELL] : undefined;
  }

  /** Orientation of a single conveyor: snapped to the ports around it, unless R turned it by hand on this cell. */
  private conveyorRot(x: number, z: number): Rot {
    if (this.rotOverride === `${x},${z}`) return this.rot;
    this.rotOverride = null;
    return snapConveyorRot(this.sim, x, z, this.rot).rot;
  }

  /**
   * Green arrows where planned buildings would connect to existing ones (planned ↔ planned links are the
   * path itself), a red cross where the last one's front would run into a building that refuses its items;
   * fills lastLinks. Only placements that can stand are passed in, in path order.
   */
  private showLinks(plan: Placement[], links: PlanLinks[], marks = true): void {
    const summary: LinkSummary = { from: [], to: [], blockedBy: null, steals: [] };
    let k = 0;
    const mark = (cx: number, cz: number, entry: number, stolen = false) => {
      if (!marks) return;
      let m = this.linkMarks[k];
      if (!m) {
        m = new THREE.Mesh(pointerGeometry, sharedPointer.linked);
        this.scene.add(m);
        this.linkMarks.push(m);
      }
      k++;
      m.material = stolen ? sharedPointer.dead : sharedPointer.linked;
      // On the shared edge, over the belts, pointing into the receiving cell.
      m.position.set((cx + 0.5 + DX[entry]! * 0.5) * FACTORY_CELL, this.edgeY(cx, cz, entry) + POINTER_Y, (cz + 0.5 + DZ[entry]! * 0.5) * FACTORY_CELL);
      m.rotation.y = yawOf(opposite(entry as Rot));
      m.visible = true;
    };
    links.forEach((l, i) => {
      // Every output link (a splitter has several).
      for (const o of l.outs) {
        if (o.target < 0) continue;
        mark(o.cx, o.cz, o.entry);
        summary.to.push(this.sim.buildings.get(o.target)!.type);
      }
      for (const f of l.in) {
        if (f.id < 0) continue;
        const type = this.sim.buildings.get(f.id)!.type;
        const stolen = steals(this.sim, f);
        mark(f.link.cx, f.link.cz, f.link.entry, stolen);
        (stolen ? summary.steals : summary.from).push(type);
      }
      const p = plan[i]!;
      if (marks && i === plan.length - 1 && p.type === 'conveyor' && !l.out) {
        const fx = p.x + DX[p.rot];
        const fz = p.z + DZ[p.rot];
        const front = this.sim.at(fx, fz);
        // A building that refuses its items, or ground no belt can stand on: the line can never go on.
        const stuck = front ? front.type : this.sim.inBounds(fx, fz) && !this.sim.beltFits(fx, fz) ? 'terrain' : null;
        if (stuck) {
          summary.blockedBy = stuck;
          const f = 0.4 * FACTORY_CELL;
          this.deadMark.position.set((p.x + 0.5) * FACTORY_CELL + DX[p.rot] * f, this.edgeY(p.x, p.z, p.rot) + POINTER_Y, (p.z + 0.5) * FACTORY_CELL + DZ[p.rot] * f);
          this.deadMark.visible = true;
        }
      }
    });
    this.lastLinks = summary;
  }

  private hideLinks(): void {
    for (const m of this.linkMarks) m.visible = false;
    this.deadMark.visible = false;
  }

  /** Grid/cost check of the sim, with the placement guard's veto (a blocked spot outranks a missing cost). */
  private checkPlacement(type: BuildingType, x: number, z: number, rot: Rot, opts: { free?: boolean } = {}): BuildCheck {
    const check = this.sim.check(type, x, z, rot, opts.free ? { free: true } : { wallet: this.wallet });
    if (!this.placementGuard || (!check.ok && check.error !== 'cost')) return check;
    const message = this.placementGuard(check.cells, type);
    return message ? { ...check, ok: false, error: 'blocked', message } : check;
  }

  private makeGhost(type: BuildingType): void {
    this.clearGhost();
    const g = buildModel(this.assets, type);
    setGhostMaterial(g, ghostOk);
    this.ghostValid = true;
    // Port markers in the cell in front of each port, as on placed buildings; a conveyor shows its
    // direction with an arrow over it instead.
    const def = BUILDINGS[type];
    this.ghostPorts = [];
    if (type === 'conveyor') g.add(conveyorArrow());
    else {
      for (const p of def.ports) {
        // Placed each frame by placeGhostPorts (on the ground of the cell in front, slope included).
        const marker = portMarker(p.dir);
        marker.matrixAutoUpdate = false;
        this.scene.add(marker);
        this.ghostPorts.push(marker);
      }
    }
    if (type === 'garage') {
      // Door: an entry arrow in front of the open side.
      const arrow = new THREE.Mesh(arrowGeo, arrowIn);
      arrow.userData.keepMaterial = true;
      arrow.position.set(DX[GARAGE_DOOR_SIDE] * (GARAGE.halfW + 0.8), 0.45, DZ[GARAGE_DOOR_SIDE] * (GARAGE.halfD + 0.8));
      arrow.rotation.y = Math.atan2(DX[GARAGE_DOOR_SIDE], DZ[GARAGE_DOOR_SIDE]) + Math.PI;
      arrow.scale.setScalar(1.6);
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
    for (const m of this.ghostPorts) m.removeFromParent();
    this.ghostPorts = [];
    this.slab.visible = false;
  }

  // ------------------------------------------------------------ conveyor drag

  /**
   * Conveyor path of the current drag: from the pressed spot to the aimed one, snapped to ports (a belt runs
   * from an output to an input, whichever is pressed first). While the aim stays where it was pressed, a
   * single tile, as the hover ghost showed.
   */
  private planDrag(): Placement[] {
    const start = this.dragStart!;
    const aim = this.aim.cell;
    const pressed = this.dragAim;
    const click =
      !aim ||
      !pressed ||
      (aim[0] === pressed.cell[0] && aim[1] === pressed.cell[1]) ||
      (pressed.building !== null && this.sim.at(aim[0], aim[1])?.id === pressed.building);
    const end = click ? start : endCell(this.sim, aim, start, this.aimPoint());
    const path = planDrag(this.sim, start, end, this.rot);
    // A click keeps the orientation R gave on that cell.
    if (path.length === 1 && this.rotOverride === `${path[0]!.x},${path[0]!.z}`) path[0]!.rot = this.rot;
    return path;
  }

  private updateDrag(): void {
    const path = this.planDrag();
    this.dragPath = path;
    while (this.dragGhosts.length < path.length) {
      const g = buildModel(this.assets, 'conveyor');
      setGhostMaterial(g, ghostOk);
      g.add(conveyorArrow());
      this.scene.add(g);
      this.dragGhosts.push(g);
    }
    const checks = path.map((p) => this.checkPlacement('conveyor', p.x, p.z, p.rot, { free: true }));
    const standing = path.filter((_, i) => cellsFree(checks[i]!));
    const links = standing.length ? this.sim.planLinks(standing) : [];
    // A path ending on a belt that the tile before merges into: that end is the existing belt, not a tile.
    const n = path.length;
    const endBelt = n > 1 ? this.sim.at(path[n - 1]!.x, path[n - 1]!.z) : undefined;
    const merge = endBelt?.type === 'conveyor' && standing[standing.length - 1] === path[n - 2] && links[links.length - 1]?.out?.target === endBelt.id;
    this.dragMerge = merge;
    let budget = this.wallet.count('plate');
    const cost = BUILDINGS.conveyor.cost.plate ?? 0;
    let short = 0;
    let blocked: BuildCheck | null = null;
    let failed: BuildCheck | null = null;
    this.dragGhosts.forEach((g, i) => {
      const p = path[i];
      g.visible = !!p && !(merge && i === n - 1);
      if (!g.visible || !p) return;
      this.placeTile(g, p.x, p.z, p.rot);
      const check = checks[i]!;
      const affordable = budget >= cost;
      if (check.ok && affordable) budget -= cost;
      else if (check.ok) short++;
      else if (check.error === 'blocked') blocked ??= check;
      else failed ??= check;
      setGhostMaterial(g, check.ok && affordable ? ghostOk : ghostBad);
    });
    // The first real reason first (a veto, a taken cell), then what is missing to pay for the rest.
    this.lastCheck = blocked ?? failed ?? (short ? { ok: false, cells: [], error: 'cost', missing: { plate: short * cost } } : { ok: true, cells: [] });
    if (this.ghost) this.ghost.visible = false;
    if (n === 1) this.shown = { ...path[0]! };
    if (standing.length) this.showLinks(standing, links);
  }

  private clearDrag(): void {
    for (const g of this.dragGhosts) g.removeFromParent();
    this.dragGhosts = [];
    this.dragStart = null;
    this.dragAim = null;
    this.dragMerge = false;
    this.dragPath = [];
  }

  // ------------------------------------------------------------ dismantle / hover

  private boxAround(id: number, kind: HighlightKind): void {
    const b = this.sim.buildings.get(id);
    if (!b) return;
    const [w, h] = BUILDINGS[b.type].footprint;
    const [rw, rh] = rotatedSize(w, h, b.rot);
    const height = buildingHeight(b.type);
    const sx = rw * FACTORY_CELL + 0.1;
    const sz = rh * FACTORY_CELL + 0.1;
    // Its base: the pad of a padded building, the deck of a belt piece (on the relief).
    const base = !this.relief ? 0 : isBelt(b.type) ? this.sim.deckOf(b, this.deck).c : (b.py ?? 0) / 100;
    if (BUILDINGS[b.type].hollow) {
      footprintCenter(b.type, b.x, b.z, b.rot, this.outline.position);
      this.outline.position.y = base;
      this.outlineEdges.scale.set(sx, height, sz);
      this.outlineEdges.material = outlineMats[kind].edges;
      this.outlineFloor.scale.set(sx, 1, sz);
      this.outlineFloor.material = outlineMats[kind].floor;
      this.outline.visible = true;
      return;
    }
    footprintCenter(b.type, b.x, b.z, b.rot, this.highlight.position);
    this.highlight.position.y = base + height / 2;
    this.highlight.scale.set(sx, height, sz);
    this.highlight.material = kind === 'dismantle' ? highlightMat : hoverMat;
    this.highlight.visible = true;
  }

  private updateDismantle(): void {
    const id = this.aim.buildingId;
    if (id !== null && BUILDINGS[this.sim.buildings.get(id)?.type ?? 'hub'].buildable) this.boxAround(id, 'dismantle');
  }

  private updateHover(): void {
    const id = this.aim.buildingId;
    const mine = this.mineTarget();
    if (mine) {
      // Flat highlight of the resource cell that E would mine.
      const mx = (mine.cell[0] + 0.5) * FACTORY_CELL;
      const mz = (mine.cell[1] + 0.5) * FACTORY_CELL;
      this.highlight.position.set(mx, this.sim.terrain.heightAt(mx, mz) + 0.2, mz);
      this.highlight.scale.set(FACTORY_CELL, 0.4, FACTORY_CELL);
      this.highlight.material = hoverMat;
      this.highlight.visible = true;
      return;
    }
    if (id === null) return;
    const b = this.sim.buildings.get(id);
    if (b && isBelt(b.type)) {
      // A belt piece carrying items (on it or along its line): E picks them up.
      const load = this.beltLoad(id);
      if (load.line > 0) {
        this.boxAround(id, 'hover');
        this.showLine(load.ids);
      }
    } else if (b && !isBelt(b.type)) this.boxAround(id, 'hover');
  }

  /** Belt piece (conveyor, splitter, merger) aimed at without a tool (picking up items off belts). */
  beltTarget(): number | null {
    const id = this.aim.buildingId;
    if (this.tool.kind !== 'none' || id === null) return null;
    const b = this.sim.buildings.get(id);
    return b && isBelt(b.type) ? id : null;
  }

  /** Items on a belt piece and on its whole line (connected belt pieces), with the line's pieces. */
  beltLoad(id: number): { ids: number[]; tile: number; line: number } {
    this.sim.syncTopology(); // a building placed or removed since the last tick bumps the version
    const c = this.lineCache;
    const ids = c && c.id === id && c.version === this.sim.topologyVersion ? c.ids : this.sim.beltLine(id);
    this.lineCache = { id, version: this.sim.topologyVersion, ids };
    let line = 0;
    let tile = 0;
    for (const k of ids) {
      const n = this.sim.itemsOn(k);
      line += n;
      if (k === id) tile = n;
    }
    return { ids, tile, line };
  }

  /** Faint boxes over a belt line, brighter while E is held on it. */
  private showLine(ids: number[]): void {
    let mesh = this.lineMesh;
    if (!mesh || mesh.instanceMatrix.count < ids.length) {
      mesh?.removeFromParent();
      mesh?.dispose();
      mesh = new THREE.InstancedMesh(lineBox, lineMat, Math.max(32, 2 ** Math.ceil(Math.log2(ids.length))));
      mesh.renderOrder = 5;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.lineMesh = mesh;
    }
    const m = new THREE.Matrix4();
    const s = FACTORY_CELL + 0.06;
    ids.forEach((id, i) => {
      const b = this.sim.buildings.get(id)!;
      const y = this.relief ? this.sim.deckOf(b, this.deck).c : 0;
      m.makeScale(s, 1.0, s).setPosition((b.x + 0.5) * FACTORY_CELL, y + 0.5, (b.z + 0.5) * FACTORY_CELL);
      mesh!.setMatrixAt(i, m);
    });
    mesh.count = ids.length;
    mesh.instanceMatrix.needsUpdate = true;
    lineMat.opacity = this.beltProgress === null ? 0.13 : 0.14 + 0.2 * this.beltProgress;
  }

  /**
   * Resource cell the player can mine by hand (E held): no tool, aiming at the ground of a free node
   * cell (a drill on it catches the ray first), within HAND.MINE_REACH of the player.
   */
  mineTarget(): { cell: [number, number]; resource: ResourceId } | null {
    const cell = this.aim.cell;
    if (this.tool.kind !== 'none' || !this.aimGround || this.aim.buildingId !== null || !cell || this.sim.at(cell[0], cell[1])) return null;
    const resource = this.sim.resourceAt(cell[0], cell[1]);
    if (!resource) return null;
    // Distance to the nearest point of the cell (on its ground: from up a hill, a node below is out of reach).
    const nx = Math.max(cell[0] * FACTORY_CELL, Math.min(this.playerPos.x, (cell[0] + 1) * FACTORY_CELL));
    const nz = Math.max(cell[1] * FACTORY_CELL, Math.min(this.playerPos.z, (cell[1] + 1) * FACTORY_CELL));
    const dy = this.playerPos.y - this.sim.terrain.heightAt(nx, nz);
    return Math.hypot(nx - this.playerPos.x, dy, nz - this.playerPos.z) <= HAND.MINE_REACH ? { cell, resource } : null;
  }

  /** Hides the hover / dismantle / mine-cell highlights (controls taken away: driving, garage panel). */
  hideHighlights(): void {
    this.highlight.visible = false;
    this.outline.visible = false;
    if (this.lineMesh) this.lineMesh.count = 0;
    this.hideLinks();
  }

  /** Building the player can interact with (E): machines, drills and the hub. */
  interactTarget(): number | null {
    const id = this.aim.buildingId;
    if (id === null) return null;
    const b = this.sim.buildings.get(id);
    return b && !isBelt(b.type) ? id : null;
  }

  // ------------------------------------------------------------ actions

  primaryDown(): void {
    if (this.tool.kind === 'build' && this.tool.type === 'conveyor' && this.aim.cell) {
      this.dragStart = startCell(this.sim, this.aim.cell, this.aimPoint());
      this.dragAim = { cell: [...this.aim.cell], building: this.sim.at(this.aim.cell[0], this.aim.cell[1])?.id ?? null };
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
    const check = this.checkPlacement(type, ax, az, this.rot);
    if (check.error === 'blocked') {
      this.onMessage?.(describeError(check), 'error');
      this.onChange?.();
      return;
    }
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
    if (!this.dragPath.length) this.updateDrag();
    const path = this.dragMerge ? this.dragPath.slice(0, -1) : this.dragPath;
    let placed = 0;
    let lastError: BuildCheck | null = null;
    let last: Building | null = null;
    for (const p of path) {
      const check = this.checkPlacement('conveyor', p.x, p.z, p.rot, { free: true });
      if (check.error === 'blocked') {
        lastError = check;
        continue;
      }
      const r = this.sim.place('conveyor', p.x, p.z, p.rot, { wallet: this.wallet });
      if (r.ok) {
        placed++;
        last = r.building;
      } else lastError = r.check;
    }
    if (path.length) this.rot = path[path.length - 1]!.rot;
    this.rotOverride = null;
    // Nothing placed: the reason the HUD gave (veto, taken cell, missing plates) rather than the last one met.
    const reason = this.lastCheck && !this.lastCheck.ok ? this.lastCheck : lastError;
    this.clearDrag();
    const dead = !!last && this.sim.isDeadEnd(last.id);
    const front = dead ? this.sim.at(last!.x + DX[last!.rot], last!.z + DZ[last!.rot]) : undefined;
    const label = `${placed} convoyeur${placed > 1 ? 's' : ''} posé${placed > 1 ? 's' : ''}`;
    if (placed && front) this.onMessage?.(`${label}, mais le dernier bute contre : ${BUILDINGS[front.type].name}`, 'error');
    else if (placed && dead) this.onMessage?.(`${label}, mais le dernier bute contre un relief`, 'error');
    else if (placed) this.onMessage?.(label, 'success');
    else if (reason) this.onMessage?.(describeError(reason), 'error');
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
    const veto = this.dismantleGuard?.(b);
    if (veto) {
      this.onMessage?.(veto, 'error');
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
    for (const m of this.linkMarks) m.removeFromParent();
    this.linkMarks = [];
    this.deadMark.removeFromParent();
    if (this.lineMesh) {
      this.lineMesh.removeFromParent();
      this.lineMesh.dispose();
    }
    this.highlight.removeFromParent();
    this.highlight.geometry.dispose();
    this.slab.removeFromParent();
    this.outline.removeFromParent();
    this.outlineEdges.geometry.dispose();
    this.outlineFloor.geometry.dispose();
  }
}

/** Cells free for the building (it may still be unaffordable or vetoed): its connections can be previewed. */
function cellsFree(check: BuildCheck): boolean {
  return check.ok || check.error === 'cost' || check.error === 'blocked';
}

/** Is port `i` of planned building `p` part of one of its planned links? */
function portLinked(sim: FactorySim, p: Placement, i: number, links: PlanLinks): boolean {
  const port = BUILDINGS[p.type].ports[i]!;
  const w = sim.portWorld(p, port.cell, port.side);
  if (port.dir === 'out') return links.outs.some((o) => o.cx === w.cx + DX[w.side] && o.cz === w.cz + DZ[w.side] && o.entry === opposite(w.side));
  return links.in.some((f) => f.link.cx === w.cx && f.link.cz === w.cz && f.link.entry === w.side);
}

/** Orange arrow over a conveyor ghost: its direction. */
function conveyorArrow(): THREE.Mesh {
  const arrow = new THREE.Mesh(arrowGeo, arrowOut);
  arrow.userData.keepMaterial = true;
  arrow.position.set(0, 1.0, 0.3);
  arrow.scale.setScalar(0.7);
  return arrow;
}
