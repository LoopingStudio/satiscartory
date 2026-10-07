import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Mode } from '../core/ModeManager';
import { addLightRig, type LightRig } from '../core/Renderer';
import type { GameState } from '../state/GameState';
import { FactoryView } from './view/FactoryView';
import { FactoryWorld } from './FactoryWorld';
import { FactoryHud } from './FactoryHud';
import { BuildController, describeError, type Tool } from './build/BuildController';
import { CharacterController } from '../player/CharacterController';
import { PlayerAvatar } from '../player/PlayerAvatar';
import { OrbitCamera } from '../player/OrbitCamera';
import { FACTORY_CELL, GRAVITY_FACTORY, PLAYER_RADIUS } from '../config/constants';
import { RAPIER } from '../core/physics/PhysicsWorld';
import { FACTORY_MAP } from '../data/factoryMap';
import { BUILDINGS, BUILD_MENU } from '../data/buildings';
import { ITEMS, ITEM_IDS, countLabel } from '../data/items';
import { RECIPES_BY_ID, recipesFor } from '../data/recipes';
import { TIERS, tierOf } from '../data/tiers';
import { HAND } from '../data/balance';
import { RESOURCES } from '../data/factoryMap';
import { isMachine } from './sim/types';
import type { Wallet } from '../state/Inventory';
import { PLAYER } from '../data/player';
import { OBJECTIVES, type ObjectiveContext } from '../data/objectives';
import { toast } from '../ui/dom';
import { openSettings } from '../ui/menus/SettingsPanel';
import { FactorySim } from './sim/FactorySim';
import { spawnDemoFactory, spawnStressLoops } from './sim/testLayouts';
import type { Action } from '../config/keybinds';
import { FactoryCars } from './cars/FactoryCars';
import { GaragePanel } from '../garage/GaragePanel';
import { bayOccupant, bayPose, bayRect, type BayBlocker, type GarageSpot } from '../garage/parking';
import { makeCarPreview } from '../car/CarModel';
import type { TrackSelectParams } from '../race/TrackSelectMode';

export interface FactoryModeParams {
  layout?: 'demo' | 'stress';
}

const HOTKEYS: Action[] = ['hotbar1', 'hotbar2', 'hotbar3', 'hotbar4', 'hotbar5', 'hotbar6'];
/** The Escape keydown and the pointer-lock change arrive in either order: treat them as one press. */
const ESC_GRACE_MS = 400;

/** On-foot factory: third-person character, building, machine configuration. */
export class FactoryMode implements Mode {
  readonly name = 'factory' as const;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private disposeCamera: () => void;
  private sim!: FactorySim;
  private view!: FactoryView;
  private world!: FactoryWorld;
  private rig!: LightRig;
  private player!: CharacterController;
  private avatar!: PlayerAvatar;
  private orbit!: OrbitCamera;
  private build!: BuildController;
  private wallet!: Wallet;
  private hud!: FactoryHud;
  private freeCursor = false;
  private started = false;
  private hudTimer = 0;
  private unsub: (() => void)[] = [];
  private readonly renderPos = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private faceYaw = 0;
  private rmbDragged = 0;
  /** Hand mining: seconds E has been held on the current resource cell. */
  private mineT = 0;
  private mineCell: string | null = null;
  /** Time (ms) a build/dismantle tool was last closed by Escape. */
  private toolEscAt = -Infinity;
  /** Pointer released by Escape while a tool was active: no pause menu, click to resume. */
  private resumeHint = false;
  /** Pointer lock succeeded at least once (a later refusal is a re-lock cooldown, not a missing feature). */
  private lockWorked = false;
  /** Cars standing (or driven) in the factory. */
  private cars!: FactoryCars;
  private garagePanel!: GaragePanel;
  /** Ghost of the car being drafted in the open garage's empty bay. */
  private preview: { dispose(): void } | null = null;
  private previewOf: object | null = null;
  /** E pressed to get in/out of a car: ignore it (mining) until released. */
  private eLatch = false;

  constructor(private readonly game: Game, private readonly state: GameState) {
    const { camera, dispose } = game.makeCamera(62, 0.1, 1500);
    this.camera = camera;
    this.disposeCamera = dispose;
  }

  enter(params?: FactoryModeParams): void {
    if (params?.layout === 'stress') {
      this.sim = new FactorySim({ hub: null, width: 64, height: 64 });
      spawnStressLoops(this.sim);
      this.state.sim = this.sim;
      this.state.ephemeral = true;
    } else {
      this.sim = this.state.sim;
      if (params?.layout === 'demo') {
        spawnDemoFactory(this.sim);
        // Dev layout: every building available to play with the demo chains.
        this.state.tier = TIERS.length;
      }
    }
    this.rig = addLightRig(this.scene, { shadowSize: 45, fog: [90, 320] });
    this.view = new FactoryView(this.game.assets, this.sim);
    this.scene.add(this.view.root);
    this.world = new FactoryWorld(this.sim);

    // A saved position inside a building (e.g. where the hub's bench now stands) falls back to the spawn.
    const saved = this.state.player;
    const inside = saved ? this.sim.at(Math.floor(saved.x / FACTORY_CELL), Math.floor(saved.z / FACTORY_CELL)) : undefined;
    const spawn = saved && (!inside || inside.type === 'conveyor' || BUILDINGS[inside.type].hollow)
      ? new THREE.Vector3(saved.x, saved.y, saved.z)
      : new THREE.Vector3(FACTORY_MAP.spawn.x * FACTORY_CELL, 0.1, FACTORY_MAP.spawn.z * FACTORY_CELL);
    this.player = new CharacterController(this.world.physics, spawn);
    // Cars: old saves' cars without a place park in free garage bays.
    this.state.parkCars();
    this.cars = new FactoryCars(this.game.assets, this.world.physics, this.scene, this.state, {
      ground: this.world.ground,
      isConveyor: (c) => {
        const id = this.world.buildingOf(c);
        return id !== null && this.sim.buildings.get(id)?.type === 'conveyor';
      },
    });
    this.avatar = new PlayerAvatar(this.game.assets);
    this.scene.add(this.avatar.root);
    this.orbit = new OrbitCamera(this.camera, this.world.physics, this.player.collider);
    // New game: spawn south of the hub looking toward it (+Z).
    this.orbit.yaw = this.state.player ? this.state.player.yaw : 0;
    this.faceYaw = this.orbit.yaw;
    this.applySettings();
    // Restored inside a car (it was parked or assembled where the player stood): step beside it.
    // Scene queries only see colliders after a world step: a zero-length one indexes buildings and walls.
    this.world.physics.step(0);
    this.moveOutOfCars();

    this.wallet = this.state.wallet();
    const inv = this.state.inventory;
    this.build = new BuildController(this.game.assets, this.sim, this.world, this.scene, this.wallet);
    this.hud = new FactoryHud(this.sim, inv, this.wallet, this.game.icons, {
      selectTool: (t) => this.selectTool(t),
      setRecipe: (id, r) => {
        // Buffered items of the previous recipe go back to the backpack (overflow: hub).
        this.sim.setRecipe(id, r, this.wallet);
      },
      loadMachine: (id) => {
        const n = this.sim.loadFrom(id, this.wallet);
        toast(n ? `${n} objet${n > 1 ? 's' : ''} chargé${n > 1 ? 's' : ''}` : 'Rien à charger', n ? 'success' : 'info', 1200);
      },
      collect: (id) => {
        const b = this.sim.buildings.get(id);
        const item = b && 'outBuf' in b ? b.outBuf[0] : undefined;
        const waiting = b && 'outBuf' in b ? b.outBuf.length : 0;
        const n = this.sim.collectOutput(id, inv);
        if (n && item) toast(`+${countLabel(item, n)} dans le sac`, 'success', 1400);
        else if (waiting) toast('Sac plein : dépose des objets au hangar', 'error', 1800);
      },
      takeFromHub: (item) => {
        const want = Math.min(ITEMS[item].stack, this.sim.count(item), inv.room(item));
        const got = this.sim.hub.remove(item, want);
        const added = inv.add(item, got);
        if (added < got) this.sim.hub.add(item, got - added);
        if (added) toast(`+${countLabel(item, added)} dans le sac`, 'success', 1200);
      },
      depositSlot: (i) => {
        const st = inv.takeSlot(i);
        if (st) this.sim.hub.add(st.item, st.count);
      },
      moveSlot: (from, to) => inv.move(from, to),
      depositAll: () => {
        let n = 0;
        for (let i = 0; i < inv.slots.length; i++) {
          const st = inv.takeSlot(i);
          if (st) {
            this.sim.hub.add(st.item, st.count);
            n += st.count;
          }
        }
        if (n) toast(`${n} objet${n > 1 ? 's' : ''} déposé${n > 1 ? 's' : ''} au hangar`, 'success', 1400);
      },
      nearHub: () => this.nearHub(),
      tier: () => this.state.tier,
      isUnlocked: (type) => this.state.isUnlocked(type),
      unlockTier: (n) => {
        if (this.state.tier !== n - 1) return;
        const next = TIERS[this.state.tier];
        const res = this.state.unlockNextTier();
        if (res.ok && next) {
          toast(`Palier ${this.state.tier} débloqué : ${next.unlocks.map((t) => BUILDINGS[t].name).join(', ')}`, 'success', 2600);
          this.hud.buildHotbar(this.build.tool);
          this.hud.updateStorage();
        } else if (res.missing) {
          toast(`Il manque ${Object.entries(res.missing).map(([i, n]) => countLabel(i as keyof typeof ITEMS, n ?? 0)).join(', ')}`, 'error', 2200);
        }
      },
      craft: (id) => {
        const r = RECIPES_BY_ID[id];
        return !!r && r.machine === 'bench' && this.wallet.craft(r);
      },
      setCrafting: (active) => this.view.setCrafting(active),
      resume: () => this.resume(),
      menu: () => void this.game.switchMode('menu'),
      settings: () => openSettings(this.game, this.state, () => this.applySettings()),
      closePanel: () => this.closePanel(),
    });
    this.build.onChange = () => this.hud.buildHotbar(this.build.tool);
    this.build.onMessage = (text, kind) => toast(text, kind, 1600);
    this.build.placementGuard = (cells, type) => this.placementBlocker(cells, type);
    this.build.dismantleGuard = (b) => (b.type === 'garage' && bayOccupant(this.state.cars, b, this.bayBlocker) ? 'Une voiture est garée dans ce garage : sors-la d’abord' : null);
    this.garagePanel = new GaragePanel(this.hud.layer, this.state, this.game.icons, {
      close: () => this.closeGarage(),
      race: (carId) => this.goRace(carId),
      changed: () => {
        this.cars.sync();
        this.moveOutOfCars();
        this.parkWaitingCars();
      },
      drivenCarId: () => this.cars.drivingId,
      bayBlocker: this.bayBlocker,
    });

    this.unsub.push(
      this.game.pointer.subscribe((locked) => {
        if (locked) {
          this.lockWorked = true;
          this.resumeHint = false;
          this.hud.showOverlay(false, false);
          return;
        }
        if (this.uiOpen || this.freeCursor) return;
        // The browser always drops the pointer lock on Escape. With a tool active,
        // Escape only closes the tool; the pause menu needs a second Escape.
        if (this.build.cancel() || performance.now() - this.toolEscAt < ESC_GRACE_MS) {
          this.toolEscAt = performance.now();
          this.resumeHint = true;
          this.hud.buildHotbar(this.build.tool);
          return;
        }
        this.hud.showOverlay(true, this.started);
      }),
      this.sim.events.on('placed', (b) => {
        // A machine with a single recipe (the smelter) starts on it.
        if (isMachine(b) && !b.recipe) {
          const only = recipesFor(b.type);
          if (only.length === 1) this.sim.setRecipe(b.id, only[0]!.id);
        }
        // A new garage takes the cars that have no place yet.
        if (b.type === 'garage') this.parkWaitingCars();
        this.hud.buildHotbar(this.build.tool);
      }),
    );
    this.hud.showOverlay(true, false);
    this.hud.updateStorage();
    this.game.renderer.canvas.addEventListener('click', this.onCanvasClick);
  }

  private applySettings(): void {
    this.orbit.sensitivity = PLAYER.MOUSE_SENSITIVITY * this.state.settings.mouseSensitivity;
    this.orbit.invertY = this.state.settings.invertY;
  }

  private onCanvasClick = () => {
    if (!this.game.pointer.locked && !this.freeCursor && !this.uiOpen) void this.resume();
  };

  /** A HUD panel or the garage panel is open (no player control). */
  private get uiOpen(): boolean {
    return this.hud.panelOpen || this.garagePanel.isOpen;
  }

  private get driving(): boolean {
    return this.cars.drivingId !== null;
  }

  /** A car whose body covers part of the garage's interior (also catches a car left in the doorway). */
  private readonly bayBlocker: BayBlocker = (g) => {
    const id = this.cars.carOverlapping(...bayRect(g));
    return id ? (this.state.cars.find((c) => c.id === id) ?? null) : null;
  };

  /** Cars waiting for a place (old saves, a second car) take any free garage bay. */
  private parkWaitingCars(): void {
    if (!this.state.parkCars(this.bayBlocker).length) return;
    this.cars.sync();
    this.moveOutOfCars();
  }

  /** Build placement: not over a car, nor (except belts) over the player. */
  private placementBlocker(cells: [number, number][], type: string): string | null {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of cells) {
      minX = Math.min(minX, x);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x + 1);
      maxZ = Math.max(maxZ, z + 1);
    }
    const [x0, z0, x1, z1] = [minX * FACTORY_CELL, minZ * FACTORY_CELL, maxX * FACTORY_CELL, maxZ * FACTORY_CELL];
    if (this.cars.overlapsArea(x0, z0, x1, z1)) return 'Une voiture gêne';
    const p = this.player.cur;
    if (type !== 'conveyor' && p.x > x0 - PLAYER_RADIUS && p.x < x1 + PLAYER_RADIUS && p.z > z0 - PLAYER_RADIUS && p.z < z1 + PLAYER_RADIUS) return 'Tu es dans le chemin';
    return null;
  }

  /** The player stands inside a car (just assembled in the bay, or restored there): step beside it. */
  private moveOutOfCars(): void {
    if (this.driving) return;
    const id = this.cars.carNear(this.player.cur, PLAYER_RADIUS);
    const spot = id ? this.cars.spotBeside(id, this.player.collider) : null;
    if (spot) this.teleportPlayer(spot.position, spot.yaw);
  }

  private teleportPlayer(pos: THREE.Vector3, yaw: number): void {
    this.player.teleport(pos);
    this.player.cur.copy(pos);
    this.player.prev.copy(pos);
    this.orbit.yaw = yaw;
    this.faceYaw = yaw;
  }

  private enterCar(id: string): void {
    if (!this.cars.enter(id)) return;
    this.eLatch = true;
    this.build.setTool({ kind: 'none' });
    this.build.hideHighlights();
    this.hud.buildHotbar(this.build.tool);
    this.avatar.root.visible = false;
    this.player.collider.setEnabled(false);
    this.hud.layer.classList.add('driving');
  }

  /** Gets out if slow enough; false otherwise. */
  private exitCar(): boolean {
    if (!this.cars.canExit()) {
      toast('Ralentis pour descendre', 'info', 1200);
      return false;
    }
    const spot = this.cars.exit(this.player.collider);
    if (!spot) return false;
    this.eLatch = true;
    this.player.collider.setEnabled(true);
    this.teleportPlayer(spot.position, spot.yaw);
    // Saved now: Enter-to-race switches mode before update() could record it.
    this.state.player = { x: spot.position.x, y: spot.position.y, z: spot.position.z, yaw: spot.yaw };
    this.avatar.root.visible = true;
    this.hud.layer.classList.remove('driving');
    // The bay the car left may be free for a waiting car.
    this.parkWaitingCars();
    return true;
  }

  private openGarage(b: GarageSpot): void {
    this.build.setTool({ kind: 'none' });
    this.hud.buildHotbar(this.build.tool);
    this.garagePanel.open({ id: b.id, x: b.x, z: b.z, rot: b.rot });
    this.game.pointer.release();
  }

  private closeGarage(): void {
    this.garagePanel.close();
    this.setPreview(null);
    if (!this.freeCursor) void this.game.pointer.request();
  }

  /** Ghost of the drafted car in the open garage's bay (rebuilt when the draft changes). */
  private setPreview(p: GaragePanel['preview']): void {
    if (p === this.previewOf) return;
    this.preview?.dispose();
    this.preview = null;
    this.previewOf = p;
    const g = this.garagePanel.garage;
    if (!p || !g) return;
    const prev = makeCarPreview(this.game.assets, p.spec);
    const pose = bayPose(g);
    prev.root.position.set(pose.x, pose.y, pose.z);
    prev.root.rotation.y = pose.yaw;
    this.scene.add(prev.root);
    this.preview = prev;
  }

  /** Camera on the garage bay, from outside the door (3/4 view, under the lintel). */
  private frameGarage(dt: number): void {
    const g = this.garagePanel.garage;
    if (!g) return;
    const pose = bayPose(g);
    const a = pose.yaw + 0.45;
    const look = new THREE.Vector3(pose.x, 0.9, pose.z);
    const target = new THREE.Vector3(pose.x + Math.sin(a) * 9.5, 4.2, pose.z + Math.cos(a) * 9.5);
    // Pulled in when a building stands in front of the door (cars, dynamic or not, are ignored).
    const dir = target.clone().sub(look);
    const len = dir.length();
    dir.divideScalar(len);
    const hit = this.world.physics.world.castRay(new RAPIER.Ray(look, dir), len, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, this.player.collider, undefined, (c) => this.world.buildingOf(c) !== null);
    if (hit) target.copy(look).addScaledVector(dir, Math.max(1.5, hit.timeOfImpact - 0.3));
    this.camera.position.lerp(target, 1 - Math.exp(-6 * dt));
    this.camera.lookAt(look);
  }

  /** Track select for this car (from the garage panel or the driver's seat). */
  private goRace(carId: string | null): void {
    this.state.selectedCarId = carId;
    void this.game.switchMode('tracks', { origin: 'factory' } satisfies TrackSelectParams);
  }

  private async resume(): Promise<void> {
    this.started = true;
    this.resumeHint = false;
    this.hud.showOverlay(false, false);
    if (this.freeCursor) return;
    const ok = await this.game.pointer.request();
    if (!ok && this.lockWorked) {
      // Re-lock refused (browsers impose a short cooldown after Escape): click again.
      this.resumeHint = true;
      return;
    }
    if (!ok) {
      // Pointer lock unavailable (embedded browser, denied…): play with a free cursor.
      this.freeCursor = true;
      toast('Mode curseur libre : clic droit maintenu pour tourner la caméra', 'info', 3500);
    }
  }

  private selectTool(t: Tool): void {
    if (t.kind === 'build' && !this.state.isUnlocked(t.type)) {
      toast(`${BUILDINGS[t.type].name} : débloque le palier ${tierOf(t.type)} au hangar (E → Paliers)`, 'error', 2200);
      return;
    }
    this.build.setTool(t);
    this.hud.buildHotbar(this.build.tool);
  }

  private openPanel(kind: 'build' | 'machine' | 'hub' | 'inventory', id?: number): void {
    if (kind === 'build') this.hud.openBuildMenu();
    else if (kind === 'machine' && id !== undefined) this.hud.openMachine(id);
    else if (kind === 'hub') this.hud.openHub();
    else if (kind === 'inventory') this.hud.openInventory();
    this.game.pointer.release();
  }

  /** Within reach of the central hub (deposit / take). */
  private nearHub(): boolean {
    const hub = [...this.sim.buildings.values()].find((b) => b.type === 'hub');
    if (!hub) return false;
    const cx = (hub.x + 1.5) * FACTORY_CELL;
    const cz = (hub.z + 1.5) * FACTORY_CELL;
    return Math.hypot(this.player.cur.x - cx, this.player.cur.z - cz) < 12;
  }

  private closePanel(): void {
    this.hud.closePanel();
    if (!this.freeCursor) void this.game.pointer.request();
  }

  private get controlling(): boolean {
    return (this.game.pointer.locked || (this.freeCursor && this.started)) && !this.uiOpen;
  }

  fixedUpdate(dt: number): void {
    const input = this.game.input;
    if (this.driving) {
      // The player capsule is disabled while driving; the car drives (race controls).
      this.cars.fixedUpdate(dt, this.controlling ? input : null);
      this.world.physics.step(dt);
      return;
    }
    let dirX = 0;
    let dirZ = 0;
    let sprint = false;
    let jump = false;
    if (this.controlling) {
      const f = input.axis('back', 'forward');
      const r = input.axis('left', 'right');
      this.orbit.forward(this.fwd);
      // forward = (sin yaw, cos yaw) → screen-right = (-cos yaw, sin yaw)
      const rx = -this.fwd.z;
      const rz = this.fwd.x;
      dirX = this.fwd.x * f + rx * r;
      dirZ = this.fwd.z * f + rz * r;
      const len = Math.hypot(dirX, dirZ);
      if (len > 1) {
        dirX /= len;
        dirZ /= len;
      }
      sprint = input.isDown('sprint');
      jump = input.consume('jump');
    }
    this.player.step(dt, { dirX, dirZ, sprint, jump }, GRAVITY_FACTORY);
    this.world.physics.step(dt);
  }

  update(dt: number, alpha: number): void {
    const input = this.game.input;
    const controlling = this.controlling;
    if (this.eLatch && !input.isDown('interact')) this.eLatch = false;
    if (this.driving) return this.updateDriving(dt, alpha, controlling);

    // Camera
    if (this.game.pointer.locked && !this.uiOpen) this.orbit.rotate(input.mouseDX, input.mouseDY);
    else if (this.freeCursor && input.isButtonDown(2) && !this.uiOpen) {
      this.orbit.rotate(input.mouseDX, input.mouseDY);
      this.rmbDragged += Math.abs(input.mouseDX) + Math.abs(input.mouseDY);
    }
    if (controlling && input.wheel) this.orbit.zoom(input.wheel);

    this.renderPos.lerpVectors(this.player.prev, this.player.cur, alpha);
    if (this.garagePanel.isOpen) {
      this.frameGarage(dt);
      this.setPreview(this.garagePanel.preview);
    } else this.orbit.update(this.renderPos, dt);
    this.cars.update(dt, alpha, this.camera);

    // Facing: toward movement, toward the camera while a build tool is active, toward the rock while mining.
    const moving = this.player.speed > 0.5;
    if (this.build.tool.kind !== 'none') this.faceYaw = this.orbit.yaw;
    else if (this.mineT > 0 && this.mineCell) {
      const [cx, cz] = this.mineCell.split(',').map(Number) as [number, number];
      this.faceYaw = Math.atan2((cx + 0.5) * FACTORY_CELL - this.renderPos.x, (cz + 0.5) * FACTORY_CELL - this.renderPos.z);
    }
    else if (moving) {
      const d = this.player.cur.clone().sub(this.player.prev);
      if (d.lengthSq() > 1e-6) this.faceYaw = Math.atan2(d.x, d.z);
    }
    this.avatar.update(dt, this.renderPos, this.player.speed, this.player.grounded, this.faceYaw, this.player.landedImpact);
    this.player.landedImpact = 0;

    // Aim: screen center when locked, cursor in free mode (none while the garage camera frames the bay).
    if (this.garagePanel.isOpen) this.build.hideHighlights();
    else {
      if (this.freeCursor) this.raycaster.setFromCamera(new THREE.Vector2(input.ndcX, input.ndcY), this.camera);
      else this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
      this.build.updateAim(this.raycaster.ray.origin, this.raycaster.ray.direction, this.renderPos, this.player.collider);
      this.build.update();
    }

    if (controlling) this.handleActions();
    else if (this.resumeHint && !this.hud.panelOpen) {
      // Second Escape (tool already closed): open the pause menu.
      if (input.wasPressed('cancel') && performance.now() - this.toolEscAt > ESC_GRACE_MS) {
        this.resumeHint = false;
        this.hud.showOverlay(true, true);
      }
    } else if (this.garagePanel.isOpen && input.wasPressed('cancel')) this.closeGarage();
    else if (this.hud.panelOpen && (input.wasPressed('cancel') || (input.wasPressed('buildMenu') && this.hud.openPanelKind === 'build') || (input.wasPressed('inventory') && this.hud.openPanelKind === 'inventory'))) this.closePanel();
    this.updateMining(dt, controlling && !this.eLatch);
    this.hud.frame(dt);

    this.hud.setCrosshair(this.game.pointer.locked && !this.uiOpen);
    this.updateHint();

    this.rig.follow(this.renderPos);
    this.view.update(dt, this.game.loop.factoryAlpha);
    this.tickHud(dt);
    this.state.player = { x: this.player.cur.x, y: this.player.cur.y, z: this.player.cur.z, yaw: this.orbit.yaw };
  }

  /** Driver's seat: chase camera (FactoryCars), E to get out, Backspace to put the car back, Enter to race. */
  private updateDriving(dt: number, alpha: number, controlling: boolean): void {
    const input = this.game.input;
    this.cars.update(dt, alpha, this.camera);
    const p = this.cars.drivingPosition;
    if (p) this.renderPos.copy(p);
    if (controlling) {
      if (input.wasPressed('interact') && !this.eLatch) this.exitCar();
      else if (input.wasPressed('respawn')) this.cars.resetToLastSafe();
      else if (input.wasPressed('retry')) {
        const id = this.cars.drivingId;
        if (this.exitCar()) this.goRace(id);
      } else if (this.freeCursor && input.wasPressed('cancel')) {
        // No pointer lock to drop: Escape pauses directly (as on foot).
        this.hud.showOverlay(true, true);
        this.started = false;
      }
    } else if (this.resumeHint && input.wasPressed('cancel') && performance.now() - this.toolEscAt > ESC_GRACE_MS) {
      this.resumeHint = false;
      this.hud.showOverlay(true, true);
    }
    this.hud.setCrosshair(false);
    this.updateHint();
    this.rig.follow(this.renderPos);
    this.view.update(dt, this.game.loop.factoryAlpha);
    this.tickHud(dt);
    // state.player keeps the spot where the player got in (a reload never spawns inside the car).
  }

  private tickHud(dt: number): void {
    this.hudTimer += dt;
    if (this.hudTimer <= 0.2) return;
    this.hudTimer = 0;
    this.hud.updateStorage();
    this.hud.tick();
    this.hud.buildHotbar(this.build.tool);
    this.garagePanel.refresh();
    this.cars.sync();
    this.updateObjectives();
  }

  /** Hand mining: hold E on a free resource cell within reach; one item per HAND.MINE_SECONDS into the backpack. */
  private updateMining(dt: number, controlling: boolean): void {
    const target = controlling ? this.build.mineTarget() : null;
    const key = target ? target.cell.join(',') : null;
    if (!target || !this.game.input.isDown('interact') || key !== this.mineCell) {
      this.mineT = 0;
      this.mineCell = target && this.game.input.isDown('interact') ? key : null;
      return;
    }
    this.mineT += dt;
    if (this.mineT < HAND.MINE_SECONDS) return;
    this.mineT -= HAND.MINE_SECONDS;
    const item = this.sim.mineAt(target.cell[0], target.cell[1], this.state.inventory);
    if (item) {
      this.view.mineEffect(target.cell[0], target.cell[1], target.resource);
      this.hud.updateStorage();
    } else {
      this.mineT = 0;
      this.mineCell = null;
      toast('Sac plein : dépose des objets au hangar', 'error', 1800);
    }
  }

  private updateObjectives(): void {
    const ctx: ObjectiveContext = {
      buildings: [...this.sim.buildings.values()].map((b) => ({
        type: b.type,
        recipe: isMachine(b) ? b.recipe : null,
        resource: b.type === 'drill' ? b.resource : null,
      })),
      storage: this.wallet.totals(ITEM_IDS),
      cars: this.state.cars.length,
      delivered: this.sim.delivered,
      crafted: this.sim.crafted,
      blueprints: this.state.cars.map((c) => c.blueprint),
      racesWithOwnCar: Object.values(this.state.records).filter((r) => r.carId).length,
      tier: this.state.tier,
    };
    const items = OBJECTIVES.map((o) => {
      const done = !!this.state.objectives[o.id] || o.done(ctx);
      if (done) this.state.objectives[o.id] = true;
      return { text: o.text, hint: o.hint, done };
    });
    this.hud.renderObjectives(items);
  }

  private handleActions(): void {
    const input = this.game.input;
    HOTKEYS.forEach((a, i) => {
      if (input.wasPressed(a)) {
        const type = BUILD_MENU[i]!;
        const t = this.build.tool;
        this.selectTool(t.kind === 'build' && t.type === type ? { kind: 'none' } : { kind: 'build', type });
      }
    });
    if (input.wasPressed('rotate')) this.build.rotate(input.isKeyDown('ShiftLeft') ? -1 : 1);
    if (input.wasPressed('dismantle')) {
      this.build.toggleDismantle();
      this.hud.buildHotbar(this.build.tool);
    }
    if (input.wasPressed('buildMenu')) this.openPanel('build');
    if (input.wasPressed('inventory')) this.openPanel('inventory');
    if (input.wasPressed('interact') && !this.eLatch) {
      // What the crosshair targets first (a car body hides the garage floor), then the nearest car.
      const id = this.build.interactTarget();
      const b = id !== null ? this.sim.buildings.get(id) : undefined;
      const car = b || this.build.mineTarget() ? null : this.cars.carNear(this.player.cur);
      if (b?.type === 'hub') this.openPanel('hub');
      else if (b?.type === 'garage') this.openGarage(b);
      else if (b) this.openPanel('machine', b.id);
      else if (car) this.enterCar(car);
    }
    if (input.wasPressed('cancel')) {
      // Escape closes the active tool first; only without a tool does it pause.
      if (this.build.cancel()) this.toolEscAt = performance.now();
      else if (this.freeCursor) this.hud.showOverlay(true, true), (this.started = false);
      this.hud.buildHotbar(this.build.tool);
    }
    if (input.buttonWasPressed(0)) this.build.primaryDown();
    if (input.buttonWasReleased(0)) this.build.primaryUp();
    if (input.buttonWasPressed(2)) this.rmbDragged = 0;
    if (input.buttonWasReleased(2) && (this.game.pointer.locked || this.rmbDragged < 6)) {
      this.build.cancel();
      this.hud.buildHotbar(this.build.tool);
    }
  }

  private updateHint(): void {
    const t = this.build.tool;
    let html = '';
    if (!this.controlling) html = this.resumeHint && !this.uiOpen ? 'Clic : reprendre · <kbd>Échap</kbd> pause' : '';
    else if (this.driving) {
      const car = this.state.cars.find((c) => c.id === this.cars.drivingId);
      const exit = this.cars.canExit() ? '<kbd>E</kbd> descendre' : '<span class="muted">ralentis pour descendre</span>';
      html = `<b>${car?.name ?? 'Voiture'}</b> · ${Math.round(this.cars.speedKmh())} km/h · ${exit} · <kbd>Entrée</kbd> courir · <kbd>Retour arrière</kbd> replacer`;
    } else if (t.kind === 'build') {
      const check = this.build.lastCheck;
      const err = check && !check.ok ? `<span class="bad">${describeError(check)}</span> · ` : '';
      const name = BUILDINGS[t.type].name;
      html =
        t.type === 'conveyor'
          ? `${err}<b>${name}</b> · clic gauche maintenu : tracer · <kbd>R</kbd> tourner · clic droit : annuler`
          : `${err}<b>${name}</b> · clic gauche : poser · <kbd>R</kbd> tourner · clic droit : annuler`;
    } else if (t.kind === 'dismantle') {
      html = 'Démontage · clic gauche : démonter (remboursé) · <kbd>F</kbd> quitter';
    } else {
      const id = this.build.interactTarget();
      const b = id !== null ? this.sim.buildings.get(id) : undefined;
      const mine = this.build.mineTarget();
      const car = b || mine ? null : this.cars.carNear(this.player.cur);
      if (b) html = `<kbd>E</kbd> ${b.type === 'hub' ? 'hangar : établi, paliers, stock' : b.type === 'garage' ? 'garage : assembler, pièces, voiture de course' : `configurer : ${BUILDINGS[b.type].name}`}`;
      else if (car) html = `<kbd>E</kbd> monter dans ${this.state.cars.find((c) => c.id === car)?.name ?? 'la voiture'}`;
      else if (mine) {
        const pct = Math.round((this.mineT / HAND.MINE_SECONDS) * 100);
        html = this.mineT > 0
          ? `Minage : ${RESOURCES[mine.resource].name} <span class="mine-bar"><i style="width:${pct}%"></i></span>`
          : `<kbd>E</kbd> maintenir : miner (${RESOURCES[mine.resource].name})`;
      } else html = '<kbd>1-6</kbd> construire · <kbd>A</kbd> menu · <kbd>F</kbd> démonter';
    }
    this.hud.setHint(html);
  }

  debugInfo(): string {
    const p = this.player.cur;
    return `sim tick ${this.sim.tickCount}  buildings ${this.sim.buildings.size}  belt items ${this.sim.beltItemCount()}\nplayer ${p.x.toFixed(1)} ${p.y.toFixed(2)} ${p.z.toFixed(1)} grounded=${this.player.grounded}  aim ${this.build.aim.cell?.join(',') ?? '-'}`;
  }

  setDebug(enabled: boolean): void {
    this.world.physics.setDebug(this.scene, enabled);
  }

  /** For automated checks (window.__game). */
  debugState() {
    return {
      tick: this.sim.tickCount,
      storage: { ...this.sim.storage },
      inventory: this.state.inventory.totals(),
      delivered: { ...this.sim.delivered },
      beltItems: this.sim.beltItemCount(),
      buildings: this.sim.buildings.size,
      player: this.player.cur.toArray().map((v) => +v.toFixed(2)),
      grounded: this.player.grounded,
      aim: this.build.aim.cell,
      aimBuilding: this.build.aim.buildingId,
      tool: this.build.tool,
      freeCursor: this.freeCursor,
      locked: this.game.pointer.locked,
      driving: this.cars.drivingId,
      garage: this.garagePanel.garage?.id ?? null,
    };
  }

  /** Dev helper: point the camera so that the screen center aims at a world cell. */
  debugLookAtCell(x: number, z: number): void {
    const target = new THREE.Vector3((x + 0.5) * FACTORY_CELL, 0, (z + 0.5) * FACTORY_CELL);
    const p = this.player.cur;
    this.orbit.yaw = Math.atan2(target.x - p.x, target.z - p.z);
  }

  exit(): void {
    this.game.renderer.canvas.removeEventListener('click', this.onCanvasClick);
    for (const u of this.unsub) u();
    this.game.pointer.release();
    this.build.dispose();
    this.garagePanel.dispose();
    this.preview?.dispose();
    this.hud.dispose();
    // Cars hold Rapier bodies: free them before the world.
    this.cars.dispose();
    this.player.dispose();
    this.world.dispose();
    this.view.dispose();
    this.disposeCamera();
  }
}
