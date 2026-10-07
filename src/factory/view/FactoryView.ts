import * as THREE from 'three';
import type { AssetLoader } from '../../core/assets/AssetLoader';
import { BELT } from '../../data/balance';
import { BUILDINGS } from '../../data/buildings';
import { RESOURCES, type ResourceId } from '../../data/factoryMap';
import { FACTORY_CELL, FACTORY_MODEL_SCALE } from '../../config/constants';
import type { FactorySim, ConveyorShape } from '../sim/FactorySim';
import { isNode, type Building, type ConveyorB } from '../sim/types';
import { mulberry32 } from '../../core/rng';
import { BuildingVisual, buildingHeight } from './BuildingVisuals';
import { ItemRenderer } from './ItemRenderer';
import { MineBursts } from './MineBursts';
import { beltLocal, rotateLocal } from './beltPath';
import type { ModelKey } from '../../core/assets/manifest.gen';
import { DX, DZ } from '../sim/dirs';
import { PAD_Y, POINTER_Y, PORT_COLORS, crossGeometry, padGeometry, padMaterial, pointerGeometry, pointerMaterial, portPose } from './portMarkers';
import { TerrainMesh } from './terrain/TerrainMesh';
import { Water } from './terrain/Water';
import { SkyDome } from './terrain/SkyDome';
import { TerrainTextures } from './terrain/terrainTextures';
import { groundUniforms } from './terrain/groundMaterial';
import { Foundations } from './Foundations';
import { GRASS_PUSHERS, GrassField, grassUniforms } from './terrain/GrassField';
import type { GrassQuality } from '../../data/factoryTerrain';
import { deckPitch, deckShear } from './terrain/deck';
import { deckY, type DeckPlane } from '../sim/terrain';
import type { TerrainRect } from '../sim/FactorySim';

const BELT_TOP = 0.4 * FACTORY_MODEL_SCALE;
const SHAPE_MODELS: Record<ConveyorShape, ModelKey> = {
  straight: 'factory-kit/conveyor-stripe',
  left: 'factory-kit/conveyor-corner',
  right: 'factory-kit/conveyor-corner',
  junction: 'factory-kit/conveyor-junction-t',
};

/** Renders the factory simulation: ground, resource nodes, buildings, conveyors and belt items. */
export class FactoryView {
  readonly root = new THREE.Group();
  private visuals = new Map<number, BuildingVisual>();
  private conveyorMeshes = new Map<ConveyorShape, THREE.InstancedMesh>();
  private conveyorsDirty = true;
  private items: ItemRenderer;
  private bursts: MineBursts;
  /** Visual of the hub (its bench animates while the player crafts). */
  private hub: BuildingVisual | null = null;
  private crafting = false;
  private unsub: (() => void)[] = [];
  private t = 0;
  private readonly tmp = { x: 0, z: 0, yaw: 0 };
  private readonly tmp2 = { x: 0, z: 0 };
  /** Conveyor ids in instance order per shape (for picking). */
  private conveyorIds = new Map<ConveyorShape, number[]>();
  /** Port markers of placed buildings (pads and floating arrows, outputs and inputs) and dead-end crosses on belts. */
  private markers: Record<MarkerKind, THREE.InstancedMesh> | null = null;
  private markersDirty = true;
  /** A build tool is active: every free port shows, pulsing (otherwise only the unconnected sides). */
  private portEmphasis = false;
  /** Relief map only: the ground mesh, the lake and the sky. */
  private terrainMesh: TerrainMesh | null = null;
  private water: Water | null = null;
  private sky: SkyDome | null = null;
  /** Geometries and materials made for this view (the cached kit ones are not among them). */
  private readonly owned: { dispose(): void }[] = [];
  /** Relief map: per-cell data for the shaders, foundations under pads and belts, belt decks per cell (c, sx, sz). */
  private textures: TerrainTextures | null = null;
  private foundations: Foundations | null = null;
  private grass: GrassField | null = null;
  private foundationsDirty = true;
  private decks: Float32Array | null = null;
  /** Ground changed (corners) since the last frame. */
  private terrainDirty: TerrainRect | null = null;
  /** Build grid: wanted on/off, current opacity, center. */
  private gridOn = false;
  private gridAlpha = 0;
  private readonly deck: DeckPlane = { c: 0, sx: 0, sz: 0 };
  private readonly shear = new THREE.Matrix4();

  constructor(private readonly assets: AssetLoader, private readonly sim: FactorySim) {
    this.root.name = 'factory';
    this.items = new ItemRenderer(assets, this.root);
    this.bursts = new MineBursts(this.root);
    this.buildGround();
    if (!sim.terrain.flat) {
      this.textures = new TerrainTextures(sim);
      const t = sim.terrain;
      groundUniforms.uCells.value = this.textures.cells;
      groundUniforms.uCellsSize.value.set(t.nx - 1, t.nz - 1);
      groundUniforms.uMargin.value = t.margin;
      groundUniforms.uGridCells.value.set(sim.width, sim.height);
      groundUniforms.uGrid.value.w = 0;
      this.foundations = new Foundations(sim);
      this.root.add(this.foundations.mesh);
      this.decks = new Float32Array(sim.width * sim.height * 3);
      this.grass = new GrassField();
      grassUniforms.uHeights.value = this.textures.heights;
      grassUniforms.uCells.value = this.textures.cells;
      grassUniforms.uLattice.value.set(t.margin, t.nx - 1, t.nz - 1);
      grassUniforms.uWater.value = t.lake ? t.lake.level / 100 : -1e9;
      grassUniforms.uFlatten.value.set(0, 0, 10, 0);
      for (const p of grassUniforms.uPush.value) p.set(0, 0, 0);
      this.root.add(this.grass.root);
    }
    for (const b of sim.buildings.values()) this.addVisual(b);
    const cellsOf = (b: Building) => this.sim.cellsFor(b.type, b.x, b.z, b.rot);
    this.unsub.push(
      sim.events.on('placed', (b) => {
        this.addVisual(b);
        this.conveyorsDirty = true;
        this.markersDirty = true;
        this.foundationsDirty = true;
        this.textures?.occupancyChanged(cellsOf(b));
      }),
      sim.events.on('removed', (b) => {
        const v = this.visuals.get(b.id);
        v?.dispose();
        if (v && v === this.hub) this.hub = null;
        this.visuals.delete(b.id);
        this.conveyorsDirty = true;
        this.markersDirty = true;
        this.foundationsDirty = true;
        this.textures?.occupancyChanged(cellsOf(b));
      }),
      sim.events.on('topology', () => {
        this.conveyorsDirty = true;
        this.markersDirty = true;
        this.foundationsDirty = true;
      }),
      sim.events.on('terrain', (r) => {
        const d = this.terrainDirty;
        this.terrainDirty = d ? { i0: Math.min(d.i0, r.i0), j0: Math.min(d.j0, r.j0), i1: Math.max(d.i1, r.i1), j1: Math.max(d.j1, r.j1) } : { ...r };
      }),
    );
  }

  private own<T extends { dispose(): void }>(o: T): T {
    this.owned.push(o);
    return o;
  }

  private buildGround(): void {
    const { width, height } = this.sim;
    const terrain = this.sim.terrain;
    if (terrain.flat) {
      // Floor: the kit's floor tile is a flat quad of one solid color, so a single quad
      // stretched over the whole grid looks the same as one tile per cell (16k instances
      // on the 128×128 map cost ~40% of the frame).
      const floorGeo = this.own(this.assets.mergedGeometry('factory-kit/floor').clone());
      floorGeo.scale(width * FACTORY_CELL, 1, height * FACTORY_CELL);
      const floor = new THREE.Mesh(floorGeo, this.assets.material('factory-kit'));
      floor.position.set((width * FACTORY_CELL) / 2, 0, (height * FACTORY_CELL) / 2);
      floor.receiveShadow = true;
      floor.name = 'floor';
      this.root.add(floor);

      // Surroundings beyond the buildable area.
      const outside = new THREE.Mesh(this.own(new THREE.PlaneGeometry(2000, 2000)), this.own(new THREE.MeshStandardMaterial({ color: 0x4b4f72 })));
      outside.rotation.x = -Math.PI / 2;
      outside.position.set((width * FACTORY_CELL) / 2, -0.05, (height * FACTORY_CELL) / 2);
      outside.receiveShadow = true;
      this.root.add(outside);

      // Grid border.
      const border = new THREE.LineSegments(
        this.own(new THREE.EdgesGeometry(new THREE.BoxGeometry(width * FACTORY_CELL, 0.01, height * FACTORY_CELL))),
        this.own(new THREE.LineBasicMaterial({ color: 0xffb347 })),
      );
      border.position.set((width * FACTORY_CELL) / 2, 0.03, (height * FACTORY_CELL) / 2);
      this.root.add(border);
    } else {
      // Relief: the ground mesh (its middle is the physics lattice), the lake, the sky.
      this.terrainMesh = new TerrainMesh(terrain);
      this.root.add(this.terrainMesh.mesh);
      if (terrain.lake) {
        this.water = new Water(terrain.lake);
        this.root.add(this.water.mesh);
      }
      this.sky = new SkyDome(SUN_DIR);
      this.root.add(this.sky.mesh);
    }

    // Resource nodes: colored patches + rocks (nodes are flat pads on the relief).
    const rng = mulberry32(42);
    const m = new THREE.Matrix4();
    const rockGeo = this.own(new THREE.IcosahedronGeometry(0.5, 0));
    for (const n of this.sim.nodes) {
      const def = RESOURCES[n.resource];
      const y = terrain.heightAt((n.x + n.w / 2) * FACTORY_CELL, (n.z + n.h / 2) * FACTORY_CELL);
      // On the relief the ground shader tints the node's cells instead.
      if (terrain.flat) {
        const patch = new THREE.Mesh(
          this.own(new THREE.PlaneGeometry(n.w * FACTORY_CELL - 0.2, n.h * FACTORY_CELL - 0.2)),
          this.own(new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.9 })),
        );
        patch.rotation.x = -Math.PI / 2;
        patch.position.set((n.x + n.w / 2) * FACTORY_CELL, y + 0.02, (n.z + n.h / 2) * FACTORY_CELL);
        patch.receiveShadow = true;
        this.root.add(patch);
      }
      const rockMat = this.own(new THREE.MeshStandardMaterial({ color: def.color, flatShading: true, roughness: 0.8 }));
      const count = n.w * n.h * 3;
      const rocks = new THREE.InstancedMesh(rockGeo, rockMat, count);
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const s = new THREE.Vector3();
      const p = new THREE.Vector3();
      for (let k = 0; k < count; k++) {
        e.set(rng() * 3, rng() * 3, rng() * 3);
        q.setFromEuler(e);
        const sc = 0.35 + rng() * 0.55;
        s.set(sc, sc * (0.6 + rng() * 0.5), sc);
        p.set((n.x + rng() * n.w) * FACTORY_CELL, y + sc * 0.2, (n.z + rng() * n.h) * FACTORY_CELL);
        rocks.setMatrixAt(k, m.compose(p, q, s));
      }
      rocks.castShadow = true;
      rocks.receiveShadow = true;
      rocks.name = `node:${n.resource}`;
      this.owned.push({ dispose: () => rocks.dispose() });
      this.root.add(rocks);
    }
  }

  private addVisual(b: Building): void {
    if (b.type === 'conveyor') return; // instanced
    const v = new BuildingVisual(this.assets, b);
    v.placeOn(this.sim);
    this.visuals.set(b.id, v);
    this.root.add(v.root);
    if (b.type === 'hub') {
      this.hub = v;
      v.crafting = this.crafting;
    }
  }

  private rebuildConveyors(): void {
    this.conveyorsDirty = false;
    const byShape = new Map<ConveyorShape, ConveyorB[]>();
    for (const b of this.sim.buildings.values()) {
      if (b.type !== 'conveyor') continue;
      const shape = this.sim.conveyorShape(b.id);
      let list = byShape.get(shape);
      if (!list) byShape.set(shape, (list = []));
      list.push(b);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const shape of Object.keys(SHAPE_MODELS) as ConveyorShape[]) {
      const list = byShape.get(shape) ?? [];
      let mesh = this.conveyorMeshes.get(shape);
      if (!mesh || mesh.instanceMatrix.count < list.length) {
        if (mesh) {
          mesh.removeFromParent();
          mesh.dispose();
        }
        const cap = Math.max(32, 2 ** Math.ceil(Math.log2(Math.max(1, list.length))));
        const key = SHAPE_MODELS[shape];
        mesh = new THREE.InstancedMesh(this.assets.mergedGeometry(key), this.assets.material('factory-kit'), cap);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = `conveyors:${shape}`;
        mesh.userData.conveyorShape = shape;
        this.root.add(mesh);
        this.conveyorMeshes.set(shape, mesh);
      }
      const ids: number[] = [];
      list.forEach((c, i) => {
        q.setFromAxisAngle(up, c.rot * (Math.PI / 2) + (shape === 'junction' ? JUNCTION_YAW : 0));
        s.set(shape === 'right' ? -FACTORY_MODEL_SCALE : FACTORY_MODEL_SCALE, FACTORY_MODEL_SCALE, FACTORY_MODEL_SCALE);
        p.set((c.x + 0.5) * FACTORY_CELL, 0, (c.z + 0.5) * FACTORY_CELL);
        m.compose(p, q, s);
        // On the relief, laid on its deck (sheared: legs and tile ends stay vertical).
        if (this.decks) m.premultiply(deckShear(this.storeDeck(c), c.x, c.z, this.shear));
        mesh!.setMatrixAt(i, m);
        ids.push(c.id);
      });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.conveyorIds.set(shape, ids);
    }
    // Splitters and mergers: their items ride their deck too.
    if (this.decks) for (const b of this.sim.buildings.values()) if (isNode(b)) this.storeDeck(b);
  }

  /** Computes a belt piece's deck and keeps it per cell (items read it every frame). */
  private storeDeck(b: Building): DeckPlane {
    const d = this.sim.deckOf(b, this.deck);
    const k = (b.x + b.z * this.sim.width) * 3;
    this.decks![k] = d.c;
    this.decks![k + 1] = d.sx;
    this.decks![k + 2] = d.sz;
    return d;
  }

  /** The kept deck of the belt piece on cell (cx, cz), in `this.deck`. */
  private deckAt(cx: number, cz: number): DeckPlane {
    const k = (cx + cz * this.sim.width) * 3;
    this.deck.c = this.decks![k]!;
    this.deck.sx = this.decks![k + 1]!;
    this.deck.sz = this.decks![k + 2]!;
    return this.deck;
  }

  /** Ground plane of a free cell (port pads), in `this.deck`; flat 0 on a flat map. */
  private cellPlane(cx: number, cz: number): DeckPlane {
    return this.sim.terrain.deckPlane(Math.max(0, Math.min(this.sim.width - 1, cx)), Math.max(0, Math.min(this.sim.height - 1, cz)), null, this.deck);
  }

  /**
   * Port markers: in front of each free output an orange pad and arrow, of each free input a blue one
   * (where a conveyor connects); a red cross at the end of a belt that runs into a building refusing its
   * items, and on the outputs of a building whose every output faces a building or the map edge. Without
   * a build tool only the sides of a building that nothing connects yet show.
   */
  private rebuildMarkers(): void {
    this.sim.syncTopology();
    this.markersDirty = false;
    const poses: Record<MarkerKind, { x: number; y: number; z: number; yaw: number; tilt?: [number, number, number, number, number] }[]> = { padOut: [], padIn: [], arrowOut: [], arrowIn: [], dead: [] };
    const pose = { x: 0, z: 0, yaw: 0 };
    const relief = !this.sim.terrain.flat;
    for (const b of this.sim.buildings.values()) {
      if (b.type === 'conveyor') {
        if (this.sim.isDeadEnd(b.id)) {
          // Over the front edge of the tile.
          const f = 0.4 * FACTORY_CELL;
          const x = (b.x + 0.5) * FACTORY_CELL + DX[b.rot] * f;
          const z = (b.z + 0.5) * FACTORY_CELL + DZ[b.rot] * f;
          const y = relief ? deckY(this.sim.deckOf(b, this.deck), b.x, b.z, x, z) : 0;
          poses.dead.push({ x, y: y + POINTER_Y, z, yaw: 0 });
        }
        continue;
      }
      const base = relief ? (b.py ?? 0) / 100 : 0;
      const ports = this.sim.portsOf(b.id);
      const linkedOut = ports.some((p) => p.dir === 'out' && p.state === 'linked');
      const linkedIn = ports.some((p) => p.dir === 'in' && p.state === 'linked');
      const outs = ports.filter((p) => p.dir === 'out');
      if (outs.length && outs.every((p) => p.state === 'blocked')) {
        // Nowhere to output: a cross over each output face, above the building so that a building standing
        // against it does not hide it (a belt pointing into it already has its own).
        for (const p of outs) {
          if (p.neighbor !== null && this.sim.buildings.get(p.neighbor)?.type === 'conveyor') continue;
          poses.dead.push({ x: (p.cx + 0.5 + DX[p.side] * 0.3) * FACTORY_CELL, y: base + buildingHeight(b.type) + 0.6, z: (p.cz + 0.5 + DZ[p.side] * 0.3) * FACTORY_CELL, yaw: 0 });
        }
      }
      for (const p of ports) {
        if (p.state !== 'free') continue;
        if (!this.portEmphasis && (p.dir === 'out' ? linkedOut : linkedIn)) continue;
        portPose(p.cx, p.cz, p.side, p.dir, pose);
        const out = p.dir === 'out';
        // On the relief, the pad lies on the cell in front (where the belt will go), the arrow floats over it.
        const fx = p.cx + DX[p.side];
        const fz = p.cz + DZ[p.side];
        const plane = relief ? this.cellPlane(fx, fz) : null;
        const gy = plane ? deckY(plane, fx, fz, pose.x, pose.z) : 0;
        poses[out ? 'padOut' : 'padIn'].push({ x: pose.x, y: gy + PAD_Y, z: pose.z, yaw: pose.yaw, tilt: plane ? [plane.c, plane.sx, plane.sz, fx, fz] : undefined });
        poses[out ? 'arrowOut' : 'arrowIn'].push({ x: pose.x, y: gy + POINTER_Y, z: pose.z, yaw: pose.yaw });
      }
    }
    if (!this.markers) {
      const make = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string, order: number) => {
        const m = new THREE.InstancedMesh(geo, mat, 16);
        m.name = name;
        m.renderOrder = order;
        m.frustumCulled = false;
        this.root.add(m);
        return m;
      };
      this.markers = {
        padOut: make(padGeometry, padMaterial(PORT_COLORS.out), 'ports:pad-out', 3),
        padIn: make(padGeometry, padMaterial(PORT_COLORS.in), 'ports:pad-in', 3),
        arrowOut: make(pointerGeometry, pointerMaterial(PORT_COLORS.out), 'ports:arrow-out', 0),
        arrowIn: make(pointerGeometry, pointerMaterial(PORT_COLORS.in), 'ports:arrow-in', 0),
        dead: make(crossGeometry, pointerMaterial(PORT_COLORS.dead), 'belts:dead-end', 0),
      };
    }
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    for (const kind of MARKER_KINDS) {
      let mesh = this.markers[kind];
      const list = poses[kind];
      if (mesh.instanceMatrix.count < list.length) {
        const bigger = new THREE.InstancedMesh(mesh.geometry, mesh.material, 2 ** Math.ceil(Math.log2(list.length)));
        bigger.name = mesh.name;
        bigger.renderOrder = mesh.renderOrder;
        bigger.frustumCulled = false;
        mesh.removeFromParent();
        mesh.dispose();
        this.root.add(bigger);
        this.markers[kind] = mesh = bigger;
      }
      list.forEach((o, i) => {
        m4.compose(p.set(o.x, o.y, o.z), q.setFromAxisAngle(up, o.yaw), one);
        if (o.tilt) {
          // Lay the pad on the cell's slope (around its own height).
          const [c, sx, sz, fx, fz] = o.tilt;
          m4.premultiply(deckShear({ c: c - deckY({ c, sx, sz }, fx, fz, o.x, o.z), sx, sz }, fx, fz, this.shear));
        }
        mesh.setMatrixAt(i, m4);
      });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** While a build tool is active, every free port shows and pulses. */
  setPortEmphasis(on: boolean): void {
    if (on === this.portEmphasis) return;
    this.portEmphasis = on;
    this.markersDirty = true;
  }

  /** Building id of a raycast hit (conveyor instance or building mesh), if any. */
  buildingIdFromHit(hit: THREE.Intersection): number | null {
    const obj = hit.object as THREE.InstancedMesh;
    const shape = obj.userData?.conveyorShape as ConveyorShape | undefined;
    if (shape && hit.instanceId !== undefined) return this.conveyorIds.get(shape)?.[hit.instanceId] ?? null;
    let o: THREE.Object3D | null = hit.object;
    while (o) {
      if (o.userData?.buildingId) return o.userData.buildingId as number;
      o = o.parent;
    }
    return null;
  }

  visualOf(id: number): BuildingVisual | undefined {
    return this.visuals.get(id);
  }

  /**
   * The player is crafting at the hub bench (true while a craft button is held): the bench lever pumps.
   * Call with false on release (and when the hub panel closes).
   */
  setCrafting(active: boolean): void {
    this.crafting = active;
    if (this.hub) this.hub.crafting = active;
  }

  /** Burst of rock chunks in the resource color at the center of grid cell (cx, cz): one hand-mined ore. */
  mineEffect(cx: number, cz: number, resource: ResourceId): void {
    const x = (cx + 0.5) * FACTORY_CELL;
    const z = (cz + 0.5) * FACTORY_CELL;
    const y = this.sim.terrain.heightAt(x, z);
    this.bursts.burst(x, y + 0.3, z, RESOURCES[resource].color, y);
  }

  /**
   * Build grid on the ground around `point` while a build tool is active (relief map only); fades in
   * and out.
   */
  setBuildGrid(active: boolean, point: THREE.Vector3 | null): void {
    this.gridOn = active && !!point;
    if (point) groundUniforms.uGrid.value.set(point.x, point.z, 12, this.gridAlpha);
  }

  /** « Herbe » setting (relief map only). */
  setGrassQuality(q: GrassQuality): void {
    this.grass?.setQuality(q);
  }

  /**
   * What pushes the grass aside this frame: (x, z, radius) each, at most GRASS_PUSHERS (the player's feet,
   * the cars).
   */
  setPushers(list: readonly { x: number; z: number; r: number }[]): void {
    if (!this.grass) return;
    const u = grassUniforms.uPush.value;
    for (let k = 0; k < GRASS_PUSHERS; k++) {
      const p = list[k];
      if (p) u[k]!.set(p.x, p.z, p.r);
      else u[k]!.set(0, 0, 0);
    }
  }

  /** The ground changed: mesh, textures, decks (belts, splitters, mergers) and foundations follow. */
  private applyTerrain(): void {
    const r = this.terrainDirty;
    if (!r) return;
    this.terrainDirty = null;
    this.terrainMesh?.updateCorners(r.i0, r.j0, r.i1, r.j1);
    this.textures?.terrainChanged(r);
    for (const v of this.visuals.values()) {
      const b = v.building;
      if (isNode(b) && b.x + 1 >= r.i0 && b.x <= r.i1 && b.z + 1 >= r.j0 && b.z <= r.j1) v.placeOn(this.sim);
    }
    this.conveyorsDirty = true;
    this.markersDirty = true;
    this.foundationsDirty = true;
  }

  /** @param viewer the camera position (the sky follows it). */
  update(dt: number, factoryAlpha: number, viewer?: THREE.Vector3): void {
    this.t += dt;
    if (viewer) this.sky?.update(viewer);
    this.applyTerrain();
    if (this.textures) {
      this.textures.flush();
      if (this.foundationsDirty) {
        this.foundationsDirty = false;
        this.foundations!.rebuild();
      }
      this.gridAlpha = Math.max(0, Math.min(1, this.gridAlpha + (this.gridOn ? dt : -dt) / 0.15));
      groundUniforms.uGrid.value.w = this.gridAlpha;
      // Grass: wind time, the camera it wraps around, shortened around the aim while building.
      grassUniforms.uTime.value = this.t;
      if (viewer) grassUniforms.uCam.value.set(viewer.x, viewer.z);
      const g = groundUniforms.uGrid.value;
      grassUniforms.uFlatten.value.set(g.x, g.y, 10, this.gridAlpha);
    }
    if (this.conveyorsDirty) this.rebuildConveyors();
    if (this.markersDirty) this.rebuildMarkers();
    if (this.markers) {
      // Pulsing while building; the floating arrows bob along their direction.
      const k = this.portEmphasis ? 0.5 + 0.5 * Math.sin(this.t * 5) : 0.5;
      for (const kind of ['padOut', 'padIn'] as const) (this.markers[kind].material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.4 * k;
      for (const kind of ['arrowOut', 'arrowIn'] as const) (this.markers[kind].material as THREE.MeshStandardMaterial).emissiveIntensity = 0.35 + 0.5 * k;
    }
    for (const v of this.visuals.values()) v.update(this.sim, this.t);
    this.bursts.update(dt);

    // Belt items, interpolated between the last two sim ticks.
    const items = this.items;
    const tmp = this.tmp;
    const r2 = this.tmp2;
    items.begin();
    for (const b of this.sim.buildings.values()) {
      if (isNode(b)) {
        // Splitter / merger: the item passing through in the middle of the crossing, and a splitter's items
        // waiting at its outputs, toward each output.
        const cx = (b.x + 0.5) * FACTORY_CELL;
        const cz = (b.z + 0.5) * FACTORY_CELL;
        const deck = this.decks ? this.deckAt(b.x, b.z) : null;
        const it = b.buf[0];
        if (it) items.add(it, cx, BELT_TOP + (deck ? deck.c : 0), cz, b.rot * (Math.PI / 2), deck ? deckPitch(deck, b.rot * (Math.PI / 2)) : 0);
        const outs = BUILDINGS[b.type].ports.filter((p) => p.dir === 'out');
        b.out.forEach((o, i) => {
          if (!o) return;
          const s = (outs[i]!.side + b.rot) % 4;
          const x = cx + DX[s] * 0.32 * FACTORY_CELL;
          const z = cz + DZ[s] * 0.32 * FACTORY_CELL;
          const yaw = s * (Math.PI / 2);
          items.add(o, x, BELT_TOP + (deck ? deckY(deck, b.x, b.z, x, z) : 0), z, yaw, deck ? deckPitch(deck, yaw) : 0);
        });
        continue;
      }
      if (b.type !== 'conveyor') continue;
      const cx = (b.x + 0.5) * FACTORY_CELL;
      const cz = (b.z + 0.5) * FACTORY_CELL;
      const deck = this.decks && b.items.length ? this.deckAt(b.x, b.z) : null;
      for (const it of b.items) {
        const u = (it.prev + (it.pos - it.prev) * factoryAlpha) / BELT.SEG;
        beltLocal(it.from, u, tmp);
        rotateLocal(tmp.x, tmp.z, b.rot, r2);
        const x = cx + r2.x * FACTORY_CELL;
        const z = cz + r2.z * FACTORY_CELL;
        const yaw = tmp.yaw + b.rot * (Math.PI / 2);
        if (deck) items.add(it.item, x, BELT_TOP + deckY(deck, b.x, b.z, x, z), z, yaw, deckPitch(deck, yaw));
        else items.add(it.item, x, BELT_TOP, z, yaw);
      }
    }
    items.end();
  }

  itemCount(): number {
    return this.items.total();
  }

  dispose(): void {
    for (const u of this.unsub) u();
    for (const v of this.visuals.values()) v.dispose();
    this.items.dispose();
    this.bursts.dispose();
    for (const m of this.conveyorMeshes.values()) m.dispose();
    if (this.markers) {
      for (const m of Object.values(this.markers)) {
        (m.material as THREE.Material).dispose();
        m.dispose();
      }
    }
    for (const o of this.owned) o.dispose();
    this.textures?.dispose();
    this.foundations?.dispose();
    this.grass?.dispose();
    if (grassUniforms.uCells.value === this.textures?.cells) grassUniforms.uCells.value = grassUniforms.uHeights.value = null;
    if (groundUniforms.uCells.value === this.textures?.cells) groundUniforms.uCells.value = null;
    this.terrainMesh?.dispose();
    this.water?.dispose();
    this.sky?.dispose();
    this.root.removeFromParent();
  }
}

type MarkerKind = 'padOut' | 'padIn' | 'arrowOut' | 'arrowIn' | 'dead';
const MARKER_KINDS: MarkerKind[] = ['padOut', 'padIn', 'arrowOut', 'arrowIn', 'dead'];

/** Toward the sun of the relief map's light rig (FactoryMode). */
export const SUN_OFFSET = new THREE.Vector3(55, 50, 30);
const SUN_DIR = SUN_OFFSET.clone().normalize();

/** Extra yaw for the T-junction model so its stem points backward (set after visual check). */
const JUNCTION_YAW = 0;
