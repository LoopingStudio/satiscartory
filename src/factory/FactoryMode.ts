import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Mode } from '../core/ModeManager';
import { addLightRig, type LightRig } from '../core/Renderer';
import { GameState } from '../state/GameState';
import { isTerrainId } from './sim/terrain';
import { FactoryView, SUN_OFFSET } from './view/FactoryView';
import { SKY } from './view/terrain/SkyDome';
import { GRASS_PUSHERS } from './view/terrain/GrassField';
import { FactoryWorld } from './FactoryWorld';
import { BUILD_ORDER, FactoryHud } from './FactoryHud';
import { BuildController, describeError, describeFill, describeLinks, type Tool } from './build/BuildController';
import { CharacterController } from '../player/CharacterController';
import { PlayerAvatar } from '../player/PlayerAvatar';
import { OrbitCamera } from '../player/OrbitCamera';
import { FACTORY_CELL, GRAVITY_FACTORY, PLAYER_RADIUS } from '../config/constants';
import { RAPIER } from '../core/physics/PhysicsWorld';
import { FACTORY_MAP } from '../data/factoryMap';
import { BUILDINGS, BUILD_MENU, isBelt, type BuildingType } from '../data/buildings';
import { ITEMS, ITEM_IDS, countLabel, type Inventory as ItemCounts, type ItemId } from '../data/items';
import { RECIPES_BY_ID, recipesFor } from '../data/recipes';
import { TIERS, tierOf } from '../data/tiers';
import { HAND } from '../data/balance';
import { RESOURCES } from '../data/factoryMap';
import { isMachine } from './sim/types';
import type { Wallet } from '../state/Inventory';
import { PLAYER } from '../data/player';
import { OBJECTIVES, type ObjectiveContext } from '../data/objectives';
import { toast } from '../ui/dom';
import { keyFor, padGlyph, padText } from '../ui/padHints';
import { stickCurve } from '../core/gamepad';
import { openSettings } from '../ui/menus/SettingsPanel';
import { FactorySim } from './sim/FactorySim';
import { spawnDemoFactory, spawnStressLoops } from './sim/testLayouts';
import type { Action } from '../config/keybinds';
import { FactoryCars, carGroundOf } from './cars/FactoryCars';
import { GaragePanel } from '../garage/GaragePanel';
import { bayOccupant, bayPose, bayRect, type BayBlocker, type GarageSpot } from '../garage/parking';
import { makeCarPreview } from '../car/CarModel';
import { buildingIcons } from './view/BuildingIcons';
import type { TrackSelectParams } from '../race/TrackSelectMode';

export interface FactoryModeParams {
  layout?: 'demo' | 'stress';
  /** Dev (`?terrain=`): a fresh, never-saved game on this relief; the saved game stays untouched. */
  terrain?: string;
}

/** The player walks at most this far (m) past the edge of the grid. */
const MAP_EDGE = 20;
const HOTKEYS: Action[] = ['hotbar1', 'hotbar2', 'hotbar3', 'hotbar4', 'hotbar5', 'hotbar6', 'hotbar7', 'hotbar8'];
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
  /** Played at least once (the overlay says « Reprendre » rather than « Jouer »). */
  private started = false;
  /** The pause / start overlay is up. */
  private paused = true;
  /**
   * Playing with the pad without pointer lock: a pad press is no user gesture, so the browser refuses
   * the lock; the camera turns with the right stick and the aim stays at the screen center anyway.
   */
  private padPlay = false;
  /** Sprint toggled by the left stick's click; ends when the stick comes back to rest. */
  private padSprint = false;
  /** The pad's place trigger went down while building (its release places, like the mouse button). */
  private padPrimary = false;
  /** Same for the left mouse button: a release whose press went elsewhere (the click that took the lock) places nothing. */
  private mousePrimary = false;
  private hudTimer = 0;
  private unsub: (() => void)[] = [];
  private readonly renderPos = new THREE.Vector3();
  private readonly tmpV = new THREE.Vector3();
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
  /** E held on a belt: seconds held and the line it picks up when HAND.BELT_LINE_SECONDS is reached. */
  private beltHold: { t: number; ids: Set<number>; taken: ItemCounts } | null = null;
  /** Last grounded positions (one every 0.25 s, ring of 4): where a fall through the relief comes back. */
  private readonly lastGround: (THREE.Vector3 | null)[] = [null, null, null, null];
  private lastGroundAt = 0;
  private lastGroundT = 0;
  /** Terrain slope under the player (avatar feet). */
  private readonly slope = { x: 0, z: 0 };

  constructor(private readonly game: Game, private readonly state: GameState) {
    const { camera, dispose } = game.makeCamera(62, 0.1, 1500);
    this.camera = camera;
    this.disposeCamera = dispose;
  }

  enter(params?: FactoryModeParams): void {
    const devTerrain = import.meta.env.DEV && isTerrainId(params?.terrain) ? params.terrain : null;
    if (params?.layout === 'stress') {
      this.sim = new FactorySim({ hub: null, width: 64, height: 64 });
      spawnStressLoops(this.sim);
      this.state.sim = this.sim;
      this.state.ephemeral = true;
      // The saved player and cars stand on the real map, not in this 64×64 one.
      this.state.player = null;
      this.state.cars = [];
      this.state.builds = [];
    } else if (devTerrain) {
      const settings = this.state.settings;
      this.state.replaceWith(new GameState(FactorySim.newGame({ terrain: devTerrain })));
      this.state.settings = settings;
      this.state.ephemeral = true;
      // Dev game: every building unlocked and a well-stocked hub, to try building on the relief.
      this.state.tier = TIERS.length;
      this.sim = this.state.sim;
      this.sim.give(Object.fromEntries(ITEM_IDS.map((i) => [i, 1000])));
      if (params?.layout === 'demo') spawnDemoFactory(this.sim);
    } else {
      this.sim = this.state.sim;
      if (params?.layout === 'demo') {
        spawnDemoFactory(this.sim);
        // Dev layout: every building available to play with the demo chains.
        this.state.tier = TIERS.length;
      }
    }
    this.rig = addLightRig(
      this.scene,
      this.sim.terrain.flat
        ? { shadowSize: 45, fog: [90, 320] }
        : // Relief: green ground bounce, warmer sun, fog melting the far hills into the horizon.
          { shadowSize: 50, sky: SKY.horizon, hemiSky: 0xdbe9ff, ground: 0x5b6b3c, hemiIntensity: 0.95, sunColor: 0xfff1d6, sunIntensity: 2.9, sunOffset: SUN_OFFSET, fog: [140, 620] },
    );
    this.view = new FactoryView(this.game.assets, this.sim);
    this.scene.add(this.view.root);
    this.world = new FactoryWorld(this.sim);

    // A saved position inside a building (e.g. where the hub's bench now stands) falls back to the spawn.
    // On the relief, never under the ground (the heightfield has one side: a capsule below falls through).
    const terrain = this.sim.terrain;
    const saved = this.state.player;
    const inside = saved ? this.sim.at(Math.floor(saved.x / FACTORY_CELL), Math.floor(saved.z / FACTORY_CELL)) : undefined;
    let spawn: THREE.Vector3;
    if (saved && (!inside || isBelt(inside.type) || BUILDINGS[inside.type].hollow)) {
      const x = terrain.flat ? saved.x : this.clampToMap(saved.x, this.sim.width);
      const z = terrain.flat ? saved.z : this.clampToMap(saved.z, this.sim.height);
      spawn = new THREE.Vector3(x, Math.max(saved.y, terrain.heightAt(x, z) + 0.05), z);
    } else spawn = this.spawnPoint(new THREE.Vector3());
    this.player = new CharacterController(
      this.world.physics,
      spawn,
      terrain.flat ? null : { minY: terrain.minY - 10, respawn: (_cur, out) => this.safeSpot(out) },
    );
    // Cars: old saves' cars without a place park in free garage bays.
    this.state.parkCars();
    this.cars = new FactoryCars(this.game.assets, this.world.physics, this.scene, this.state, {
      ground: carGroundOf(this.sim.terrain),
      isConveyor: (c) => {
        const id = this.world.buildingOf(c);
        const type = id !== null ? this.sim.buildings.get(id)?.type : undefined;
        return !!type && isBelt(type);
      },
      onEvent: () => toast('La voiture a pris l’eau : retour au sec', 'info', 2200),
      isDecor: (c) => this.world.isDecor(c),
    });
    this.avatar = new PlayerAvatar(this.game.assets);
    this.scene.add(this.avatar.root);
    // The camera looks through trees and rocks (no pumping in a forest), never under the ground.
    // (Over the lake, its surface: the camera never goes under the water, which is not drawn from below.)
    this.orbit = new OrbitCamera(this.camera, this.world.physics, this.player.collider, terrain.flat ? {} : { groundAt: (x, z) => terrain.heightAt(x, z) + terrain.waterDepthAt(x, z), filter: (c) => !this.world.isDecor(c) });
    this.world.overlapsPlayer = (c) => this.player.collider.isEnabled() && c.intersectsShape(this.player.collider.shape, this.player.collider.translation(), this.player.collider.rotation());
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
    const buildingThumbs = buildingIcons(this.game.assets, BUILD_MENU);
    this.hud = new FactoryHud(this.sim, inv, this.wallet, this.game.icons, (t) => buildingThumbs.get(t) ?? null, {
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
          this.hud.onToolChanged(this.build.tool);
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
      home: () => this.goHome(),
      canGoHome: () => !this.driving,
      settings: () => openSettings(this.game, this.state, () => this.applySettings(), () => this.applySettings()),
      closePanel: () => this.closePanel(),
    });
    this.build.onChange = () => this.hud.onToolChanged(this.build.tool);
    this.build.onMessage = (text, kind) => toast(text, kind, 1600);
    this.build.placementGuard = (cells, type) => this.placementBlocker(cells, type);
    this.build.dismantleGuard = (b) =>
      b.type !== 'garage'
        ? null
        : bayOccupant(this.state.cars, b, this.bayBlocker)
          ? 'Une voiture est garée dans ce garage : sors-la d’abord'
          : this.state.builds.some((w) => w.garage === b.id)
            ? 'Une voiture est en construction dans ce garage : termine-la ou abandonne-la d’abord (E sur le garage)'
            : null;
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
          this.paused = false;
          this.padPlay = false;
          this.hud.showOverlay(false, false);
          return;
        }
        // Released by a pause from the pad (Menu): the overlay is already up.
        if (this.uiOpen || this.freeCursor || this.paused) return;
        // The browser always drops the pointer lock on Escape. With a tool active,
        // Escape only closes the tool; the pause menu needs a second Escape.
        if (this.build.cancel() || performance.now() - this.toolEscAt < ESC_GRACE_MS) {
          this.toolEscAt = performance.now();
          this.resumeHint = true;
          this.hud.onToolChanged(this.build.tool);
          return;
        }
        this.paused = true;
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
        this.hud.onToolChanged(this.build.tool);
      }),
    );
    this.hud.showOverlay(true, false);
    this.hud.updateStorage();
    this.game.renderer.canvas.addEventListener('click', this.onCanvasClick);
    // A factory built before the relief, loaded on it: once (the next save stores the pad heights).
    const migrated = this.sim.migration;
    if (migrated?.padded) {
      const raised = [...this.sim.buildings.values()].some((b) => b.py);
      const lake = migrated.inWater ? `, ${migrated.inWater} dans le lac sur un remblai` : '';
      toast(
        raised ? `Nouvelle carte avec du relief : tes bâtiments ont été posés sur des fondations${lake}` : 'Nouvelle carte avec du relief : ton usine est restée sur le plateau, les collines commencent autour',
        'info',
        6000,
      );
      this.sim.migration = null;
    }
  }

  private applySettings(): void {
    this.orbit.sensitivity = PLAYER.MOUSE_SENSITIVITY * this.state.settings.mouseSensitivity;
    this.orbit.invertY = this.state.settings.invertY;
    this.view.setGrassQuality(this.state.settings.grass);
  }

  private onCanvasClick = () => {
    // Also while playing with the pad: a click hands the camera back to the mouse.
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
  private placementBlocker(cells: [number, number][], type: BuildingType): string | null {
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
    if (!isBelt(type) && p.x > x0 - PLAYER_RADIUS && p.x < x1 + PLAYER_RADIUS && p.z > z0 - PLAYER_RADIUS && p.z < z1 + PLAYER_RADIUS) return 'Tu es dans le chemin';
    return null;
  }

  /** The player stands inside a car (just assembled in the bay, or restored there) or a car under construction: step beside it. */
  private moveOutOfCars(): void {
    if (this.driving) return;
    const id = this.cars.carNear(this.player.cur, PLAYER_RADIUS, { builds: true });
    const spot = id ? this.cars.spotBeside(id, this.player.collider) : null;
    if (spot) this.teleportPlayer(spot.position, spot.yaw);
  }

  private teleportPlayer(pos: THREE.Vector3, yaw: number): void {
    this.player.teleport(pos);
    this.player.cur.copy(pos);
    this.player.prev.copy(pos);
    this.orbit.yaw = yaw;
    this.orbit.snap();
    this.faceYaw = yaw;
  }

  /** What pushes the grass aside: the player's feet (on foot), the driven car and the nearest parked cars. */
  private pushers(feet: THREE.Vector3 | null): { x: number; z: number; r: number }[] {
    const list = this.pushList;
    list.length = 0;
    if (feet) list.push({ x: feet.x, z: feet.z, r: 0.6 });
    this.cars.pushers(this.camera.position, list, GRASS_PUSHERS);
    return list;
  }
  private readonly pushList: { x: number; z: number; r: number }[] = [];

  /**
   * New game's spawn, south of the hub, on the ground; when something solid was built there, the nearest
   * cell where nothing (but a belt or a garage's floor) stands.
   */
  private spawnPoint(out: THREE.Vector3): THREE.Vector3 {
    const sx = FACTORY_MAP.spawn.x;
    const sz = FACTORY_MAP.spawn.z;
    const free = (cx: number, cz: number) => {
      const b = this.sim.at(cx, cz);
      return this.sim.inBounds(cx, cz) && (!b || isBelt(b.type) || !!BUILDINGS[b.type].hollow) && !this.sim.terrain.isWetCell(cx, cz);
    };
    let fx = sx;
    let fz = sz;
    search: for (let r = 0; r < 20; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (free(Math.floor(sx) + dx, Math.floor(sz) + dz)) {
            fx = sx + dx;
            fz = sz + dz;
            break search;
          }
        }
      }
    }
    const x = fx * FACTORY_CELL;
    const z = fz * FACTORY_CELL;
    return out.set(x, this.sim.terrain.heightAt(x, z) + 0.1, z);
  }

  /** Keeps a coordinate within MAP_EDGE m of the grid (m). */
  private clampToMap(v: number, cells: number): number {
    return Math.max(-MAP_EDGE, Math.min(cells * FACTORY_CELL + MAP_EDGE, v));
  }

  /** Where a player who fell through the relief comes back: a recent grounded spot, else the spawn. */
  private safeSpot(out: THREE.Vector3): THREE.Vector3 {
    const p = this.lastGround[this.lastGroundAt % this.lastGround.length];
    if (!p) return this.spawnPoint(out).setY(this.sim.terrain.heightAt(out.x, out.z) + 0.5);
    return out.set(p.x, Math.max(p.y, this.sim.terrain.heightAt(p.x, p.z)) + 0.5, p.z);
  }

  /** Pause menu « Revenir au hangar »: back to the spawn (stuck between a slope and a wall, lost on a hill). */
  private goHome(): void {
    if (this.driving) return;
    const p = this.spawnPoint(new THREE.Vector3());
    this.teleportPlayer(p, 0);
    this.lastGround.fill(null);
    this.state.player = { x: p.x, y: p.y, z: p.z, yaw: 0 };
    void this.resume();
  }

  private enterCar(id: string): void {
    if (!this.cars.enter(id)) return;
    this.eLatch = true;
    // A held (jump → handbrake), RT held (place → throttle): nothing carries over to the car.
    this.game.input.blockPadHeld();
    this.padPrimary = false;
    this.padSprint = false;
    this.build.setTool({ kind: 'none' });
    this.build.hideHighlights();
    this.hud.onToolChanged(this.build.tool);
    this.avatar.root.visible = false;
    this.player.collider.setEnabled(false);
    this.hud.layer.classList.add('driving');
  }

  /** Gets out if slow enough; false otherwise. */
  private exitCar(): boolean {
    const blocker = this.cars.exitBlocker();
    if (blocker) {
      toast(blocker === 'tilt' ? 'Trop en pente pour descendre' : 'Ralentis pour descendre', 'info', 1200);
      return false;
    }
    const spot = this.cars.exit(this.player.collider);
    if (!spot) return false;
    this.eLatch = true;
    this.game.input.blockPadHeld();
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
    this.padPrimary = this.mousePrimary = false;
    this.build.setTool({ kind: 'none' });
    this.hud.onToolChanged(this.build.tool);
    this.garagePanel.open({ id: b.id, x: b.x, z: b.z, rot: b.rot, ...(b.py !== undefined ? { py: b.py } : {}) });
    this.game.pointer.release();
  }

  private closeGarage(): void {
    this.garagePanel.close();
    this.setPreview(null);
    this.regainControl();
  }

  /**
   * After a panel: the pointer lock again, or straight back to pad play when the pad closed it (a pad press
   * is no user gesture: the lock would be refused). What closed it decides, not the last device: a pad
   * nudged while clicking « Fermer » must not keep the mouse from its lock.
   */
  private regainControl(): void {
    if (this.freeCursor) return;
    if (this.game.input.padActivation) this.padPlay = true;
    else void this.game.pointer.request();
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
    const look = new THREE.Vector3(pose.x, pose.y + 0.9, pose.z);
    const target = new THREE.Vector3(pose.x + Math.sin(a) * 9.5, pose.y + 4.2, pose.z + Math.cos(a) * 9.5);
    // Pulled in when a building or the ground stands in front of the door (cars, dynamic or not, are ignored).
    const dir = target.clone().sub(look);
    const len = dir.length();
    dir.divideScalar(len);
    const hit = this.world.physics.world.castRay(new RAPIER.Ray(look, dir), len, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, this.player.collider, undefined, (c) => this.world.buildingOf(c) !== null || this.world.isGround(c));
    if (hit) target.copy(look).addScaledVector(dir, Math.max(1.5, hit.timeOfImpact - 0.3));
    target.y = Math.max(target.y, this.sim.terrain.heightAt(target.x, target.z) + 1);
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
    this.paused = false;
    this.resumeHint = false;
    this.hud.showOverlay(false, false);
    if (this.freeCursor) return;
    // « Jouer » pressed with the pad (PadNav), not clicked.
    if (this.game.input.padActivation) {
      this.padPlay = true;
      return;
    }
    this.padPlay = false;
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
      const e = this.game.input.device === 'pad' ? padText('x', this.game.input.pad.style) : 'E';
      toast(`${BUILDINGS[t.type].name} : débloque le palier ${tierOf(t.type)} au hangar (${e} → Paliers)`, 'error', 2200);
      return;
    }
    this.build.setTool(t);
    this.hud.onToolChanged(this.build.tool);
  }

  private openPanel(kind: 'build' | 'machine' | 'hub' | 'inventory', id?: number): void {
    this.dropDrag();
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
    this.regainControl();
  }

  /** A conveyor being traced stops (the tool stays): its release would be lost behind a menu. */
  private dropDrag(): void {
    this.padPrimary = this.mousePrimary = false;
    if (!this.build.dragging) return;
    this.build.cancel();
    this.hud.onToolChanged(this.build.tool);
  }

  /** Pause overlay (Menu on the pad, Escape without pointer lock); the lock, if any, is let go. */
  private pause(): void {
    this.dropDrag();
    this.paused = true;
    this.resumeHint = false;
    this.hud.showOverlay(true, true);
    this.game.pointer.release();
  }

  private get controlling(): boolean {
    return !this.paused && !this.uiOpen && (this.game.pointer.locked || this.freeCursor || this.padPlay);
  }

  /** The aim follows the cursor (free-cursor mode with the mouse), else the screen center. */
  private get cursorAim(): boolean {
    return this.freeCursor && this.game.input.device !== 'pad';
  }

  /**
   * Physics catches up with the relief (pads placed or removed since the last step): before anything
   * moves or casts. The heightfield has one side: the player is put back on top if the ground rose
   * over them (a bank of a pad placed or dismantled next to them).
   */
  private flushTerrain(): void {
    const area = this.world.flush();
    if (area) this.cars.onTerrain(area);
    if (!this.world.rebuilt || this.driving) return;
    // On the highest surface under the feet: the ground, or a belt whose deck rose under the player.
    const p = this.player.cur;
    this.lift.origin = { x: p.x, y: p.y + 1.5, z: p.z };
    this.lift.dir = { x: 0, y: -1, z: 0 };
    const hit = this.world.physics.world.castRay(this.lift, 3, true, undefined, undefined, this.player.collider, undefined, (c) => !this.world.isDecor(c));
    const top = Math.max(this.sim.terrain.heightAt(p.x, p.z), hit ? p.y + 1.5 - hit.timeOfImpact : -Infinity);
    if (p.y < top - 0.02 && top - p.y < 1.5) this.player.teleport(this.tmpV.set(p.x, top + 0.02, p.z));
  }
  private readonly lift = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  fixedUpdate(dt: number): void {
    const input = this.game.input;
    this.flushTerrain();
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
      // Keys and the left stick (analog: a light tilt walks slowly; +y is the stick pulled back).
      const stick = input.padStick('left');
      const f = input.axis('back', 'forward') - stick.y;
      const r = input.axis('left', 'right') + stick.x;
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
      sprint = input.isDown('sprint') || this.padSprint;
      jump = input.consume('jump');
    }
    // Map edge on the relief: no walking further out than MAP_EDGE m past the grid (the cliffs stop the
    // player first; past them the heightfield ends). A flat map keeps its wide floor.
    const p = this.player.cur;
    const terrain = this.sim.terrain;
    const hi = (n: number) => n * FACTORY_CELL + MAP_EDGE;
    if (!terrain.flat) {
      if ((p.x <= -MAP_EDGE && dirX < 0) || (p.x >= hi(this.sim.width) && dirX > 0)) dirX = 0;
      if ((p.z <= -MAP_EDGE && dirZ < 0) || (p.z >= hi(this.sim.height) && dirZ > 0)) dirZ = 0;
    }
    if (!terrain.flat && (p.x < -MAP_EDGE - 1 || p.z < -MAP_EDGE - 1 || p.x > hi(this.sim.width) + 1 || p.z > hi(this.sim.height) + 1)) {
      const x = this.clampToMap(p.x, this.sim.width);
      const z = this.clampToMap(p.z, this.sim.height);
      this.player.teleport(this.tmpV.set(x, Math.max(p.y, terrain.heightAt(x, z) + 0.05), z));
    }
    // Wading in the lake.
    const speedScale = terrain.waterDepthAt(p.x, p.z) > 0.25 ? 0.6 : 1;
    this.player.step(dt, { dirX, dirZ, sprint, jump, speedScale }, GRAVITY_FACTORY);
    this.world.physics.step(dt);
    // A grounded spot every 0.25 s, for the fall safety.
    this.lastGroundT += dt;
    if (this.player.grounded && this.lastGroundT >= 0.25) {
      this.lastGroundT = 0;
      const slot = (this.lastGroundAt = (this.lastGroundAt + 1) % this.lastGround.length);
      (this.lastGround[slot] ??= new THREE.Vector3()).copy(this.player.cur);
    }
  }

  update(dt: number, alpha: number): void {
    const input = this.game.input;
    this.flushTerrain();
    input.padProfile = this.driving ? 'drive' : 'foot';
    // A pad user left without control (pointer lock refused after a panel, Escape with a tool): any pad
    // input takes it back.
    if (!this.controlling && !this.paused && !this.uiOpen && !this.freeCursor && input.device === 'pad' && input.pad.active) {
      this.padPlay = true;
      this.resumeHint = false;
    }
    const controlling = this.controlling;
    if (this.eLatch && !input.isDown('interact')) this.eLatch = false;
    if (this.driving) return this.updateDriving(dt, alpha, controlling);

    // Camera
    if (this.game.pointer.locked && !this.uiOpen) this.orbit.rotate(input.mouseDX, input.mouseDY);
    else if (this.freeCursor && input.isButtonDown(2) && !this.uiOpen) {
      this.orbit.rotate(input.mouseDX, input.mouseDY);
      this.rmbDragged += Math.abs(input.mouseDX) + Math.abs(input.mouseDY);
    }
    if (controlling) {
      const rs = input.padStick('right');
      const k = this.state.settings.padSensitivity * dt;
      if (rs.x || rs.y) this.orbit.turn(stickCurve(rs.x) * PLAYER.PAD_YAW_SPEED * k, stickCurve(rs.y) * PLAYER.PAD_PITCH_SPEED * k);
      // The stick's click starts a sprint that lasts until the stick is let go.
      const ls = input.padStick('left');
      if (input.wasPressed('sprint') && input.device === 'pad') this.padSprint = true;
      if (Math.hypot(ls.x, ls.y) < 0.2) this.padSprint = false;
    } else this.padSprint = false;
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
    const terrain = this.sim.terrain;
    const ground = terrain.flat
      ? null
      : (terrain.slopeAt(this.renderPos.x, this.renderPos.z, this.slope), { y: terrain.heightAt(this.renderPos.x, this.renderPos.z), sx: this.slope.x, sz: this.slope.z });
    this.avatar.update(dt, this.renderPos, this.player.speed, this.player.grounded, this.faceYaw, this.player.landedImpact, ground);
    this.player.landedImpact = 0;

    // Aim: screen center when locked, cursor in free mode (none while the garage camera frames the bay).
    if (this.garagePanel.isOpen) this.build.hideHighlights();
    else {
      if (this.cursorAim) this.raycaster.setFromCamera(new THREE.Vector2(input.ndcX, input.ndcY), this.camera);
      else this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
      this.build.updateAim(this.raycaster.ray.origin, this.raycaster.ray.direction, this.renderPos, this.player.collider);
      this.build.update();
    }

    if (controlling) this.handleActions();
    else if (this.resumeHint && !this.hud.panelOpen) {
      // Second Escape (tool already closed): open the pause menu.
      if (input.wasPressed('cancel') && performance.now() - this.toolEscAt > ESC_GRACE_MS) this.pause();
    } else if (this.garagePanel.isOpen && input.wasPressed('cancel')) this.closeGarage();
    else if (this.hud.openPanelKind === 'build' && HOTKEYS.some((a) => input.wasPressed(a))) {
      // Shortcut while the build menu is open: pick and place right away.
      const type = BUILD_MENU[HOTKEYS.findIndex((a) => input.wasPressed(a))]!;
      // A locked one only explains its tier (the menu stays open).
      if (this.state.isUnlocked(type)) this.closePanel();
      this.selectTool({ kind: 'build', type });
    }
    else if (this.hud.panelOpen && (input.wasPressed('cancel') || (input.wasPressed('buildMenu') && this.hud.openPanelKind === 'build') || (input.wasPressed('inventory') && this.hud.openPanelKind === 'inventory'))) this.closePanel();
    this.updateMining(dt, controlling && !this.eLatch);
    this.updateBeltPickup(dt, controlling && !this.eLatch);
    this.hud.frame(dt);

    this.hud.setCrosshair(!this.uiOpen && (this.game.pointer.locked || (controlling && !this.cursorAim)));
    this.updateHint();

    this.rig.follow(this.renderPos);
    const building = this.build.tool.kind === 'build' && !this.garagePanel.isOpen;
    this.view.setPortEmphasis(building);
    this.view.setBuildGrid(building, this.build.aim.point);
    this.view.setPushers(this.pushers(this.avatar.root.visible ? this.renderPos : null));
    this.view.update(dt, this.game.loop.factoryAlpha, this.camera.position);
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
      } else if (input.wasPressed('pause')) this.pause();
      // No pointer lock to drop: Escape pauses directly (as on foot).
      else if (!this.game.pointer.locked && input.wasPressed('cancel')) this.pause();
    } else if (this.resumeHint && input.wasPressed('cancel') && performance.now() - this.toolEscAt > ESC_GRACE_MS) this.pause();
    this.hud.setCrosshair(false);
    this.updateHint();
    this.view.setBuildGrid(false, null);
    this.view.setPushers(this.pushers(null));
    this.rig.follow(this.renderPos);
    this.view.update(dt, this.game.loop.factoryAlpha, this.camera.position);
    this.tickHud(dt);
    // state.player keeps the spot where the player got in (a reload never spawns inside the car).
  }

  private tickHud(dt: number): void {
    this.hudTimer += dt;
    if (this.hudTimer <= 0.2) return;
    this.hudTimer = 0;
    this.hud.updateStorage();
    this.hud.tick();
    this.hud.onToolChanged(this.build.tool);
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

  /** E held on a belt (pressed on it): after HAND.BELT_LINE_SECONDS, its whole line goes into the backpack. */
  private updateBeltPickup(dt: number, controlling: boolean): void {
    const h = this.beltHold;
    const aimed = this.build.beltTarget();
    if (!h || !controlling || !this.game.input.isDown('interact') || aimed === null || !h.ids.has(aimed)) {
      this.beltHold = null;
      this.build.beltProgress = null;
      return;
    }
    h.t += dt;
    this.build.beltProgress = Math.min(1, h.t / HAND.BELT_LINE_SECONDS);
    if (h.t < HAND.BELT_LINE_SECONDS) return;
    this.beltHold = null;
    this.build.beltProgress = null;
    // The message counts the whole gesture: the tile taken by the press, then the rest of the line.
    this.takeFromBelts(this.sim.beltLine(aimed), h.taken);
  }

  /**
   * Belt items into the backpack, with a message saying what was taken (plus `before`, taken earlier in the
   * same gesture) or that the backpack is full. Returns what this call took.
   */
  private takeFromBelts(ids: number[], before: ItemCounts = {}): ItemCounts {
    const taken = this.sim.takeFromBelts(ids, this.state.inventory);
    const left = ids.reduce((n, id) => n + this.sim.itemsOn(id), 0);
    const all: ItemCounts = { ...before };
    for (const [i, n] of Object.entries(taken) as [ItemId, number][]) all[i] = (all[i] ?? 0) + n;
    const labels = (Object.entries(all) as [ItemId, number][]).map(([i, n]) => countLabel(i, n));
    if (labels.length) {
      toast(`Pris : ${labels.join(', ')}${left ? ' · sac plein, le reste attend sur le convoyeur' : ''}`, left ? 'info' : 'success', 1800);
      this.hud.updateStorage();
    } else if (left) toast('Sac plein : dépose des objets au hangar', 'error', 1800);
    return taken;
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
    if (input.wasPressed('pause')) return this.pause();
    HOTKEYS.forEach((a, i) => {
      if (input.wasPressed(a)) {
        const type = BUILD_MENU[i]!;
        const t = this.build.tool;
        this.selectTool(t.kind === 'build' && t.type === type ? { kind: 'none' } : { kind: 'build', type });
      }
    });
    if (input.wasPressed('rotate')) this.build.rotate(input.isKeyDown('ShiftLeft') ? -1 : 1);
    if (input.wasPressed('rotateBack')) this.build.rotate(-1);
    if (input.wasPressed('prevTool')) this.cycleTool(-1);
    if (input.wasPressed('nextTool')) this.cycleTool(1);
    if (input.wasPressed('zoomCycle')) this.orbit.cycleZoom(PLAYER.PAD_ZOOM_STEPS);
    if (input.wasPressed('dismantle')) {
      this.build.toggleDismantle();
      this.hud.onToolChanged(this.build.tool);
    }
    if (input.wasPressed('buildMenu')) this.openPanel('build');
    if (input.wasPressed('inventory')) this.openPanel('inventory');
    if (input.wasPressed('interact') && !this.eLatch) {
      // What the crosshair targets first (a car body hides the garage floor), then the nearest car.
      const id = this.build.interactTarget();
      const b = id !== null ? this.sim.buildings.get(id) : undefined;
      // A belt counts when something lies on its line (an empty one lets E reach a car next to it).
      const belt = b ? null : this.build.beltTarget();
      const load = belt !== null ? this.build.beltLoad(belt) : null;
      const car = b || this.build.mineTarget() || load?.line ? null : this.cars.carNear(this.player.cur);
      if (b?.type === 'hub') this.openPanel('hub');
      else if (b?.type === 'garage') this.openGarage(b);
      else if (b) this.openPanel('machine', b.id);
      else if (belt !== null && load?.line) {
        // A press takes the aimed tile; holding on goes on to the whole line.
        const taken = load.tile ? this.takeFromBelts([belt]) : {};
        this.beltHold = { t: 0, ids: new Set(load.ids), taken };
      } else if (car) this.enterCar(car);
    }
    if (input.wasPressed('cancel')) {
      // Escape closes the active tool first; only without a tool does it pause (with the pointer
      // locked, the browser's lock loss does).
      if (this.build.cancel()) this.toolEscAt = performance.now();
      else if (!this.game.pointer.locked) return this.pause();
      this.hud.onToolChanged(this.build.tool);
    }
    // Pad: B cancels like the right button (the drag, then the tool), never pauses; RT is the left button.
    if (input.wasPressed('secondary')) {
      this.build.cancel();
      this.padPrimary = false;
      this.hud.onToolChanged(this.build.tool);
    }
    if (input.wasPressed('primary')) {
      this.padPrimary = true;
      this.build.primaryDown();
    }
    if (input.wasReleased('primary') && this.padPrimary) {
      this.padPrimary = false;
      this.build.primaryUp();
    }
    // The mouse builds only when it aims (locked, or free cursor); during pad play a click takes the lock.
    if (!this.game.pointer.locked && !this.freeCursor) return;
    if (input.buttonWasPressed(0)) {
      this.mousePrimary = true;
      this.build.primaryDown();
    }
    if (input.buttonWasReleased(0) && this.mousePrimary) {
      this.mousePrimary = false;
      this.build.primaryUp();
    }
    if (input.buttonWasPressed(2)) this.rmbDragged = 0;
    if (input.buttonWasReleased(2) && (this.game.pointer.locked || this.rmbDragged < 6)) {
      this.build.cancel();
      this.hud.onToolChanged(this.build.tool);
    }
  }

  /** Pad ◀ ▶: previous / next unlocked building in the build menu's order (from none: the first / last). */
  private cycleTool(dir: 1 | -1): void {
    const open = BUILD_ORDER.filter((t) => this.state.isUnlocked(t));
    if (!open.length) {
      toast(`Aucun bâtiment débloqué : ${padText('x', this.game.input.pad.style)} sur le hangar → Paliers`, 'error', 2200);
      return;
    }
    const t = this.build.tool;
    const i = t.kind === 'build' ? open.indexOf(t.type) : -1;
    const next = i < 0 ? open[dir > 0 ? 0 : open.length - 1]! : open[(i + dir + open.length) % open.length]!;
    this.selectTool({ kind: 'build', type: next });
  }

  /** Bottom hint, for the device in use (pad buttons, or AZERTY keys and mouse buttons). */
  private updateHint(): void {
    const t = this.build.tool;
    const device = this.game.input.device;
    const pad = device === 'pad';
    const k = (a: Action) => keyFor(device, a, this.driving ? 'drive' : 'foot');
    let html = '';
    if (!this.controlling) html = this.resumeHint && !this.uiOpen ? 'Clic : reprendre · <kbd>Échap</kbd> pause' : '';
    else if (this.driving) {
      const car = this.state.cars.find((c) => c.id === this.cars.drivingId);
      const blocker = this.cars.exitBlocker();
      const exit = !blocker ? `${k('interact')} descendre` : `<span class="muted">${blocker === 'tilt' ? 'trop en pente pour descendre' : 'ralentis pour descendre'}</span>`;
      html = `<b>${car?.name ?? 'Voiture'}</b> · ${Math.round(this.cars.speedKmh())} km/h · ${exit} · ${k('retry')} courir · ${k('respawn')} replacer`;
    } else if (t.kind === 'build') {
      const check = this.build.lastCheck;
      const err = check && !check.ok ? `<span class="bad">${describeError(check)}</span> · ` : '';
      const links = describeLinks(this.build.lastLinks);
      const name = BUILDINGS[t.type].name;
      const fill = describeFill(check);
      const status = `${err}<b>${name}</b>${fill ? ` <span class="muted">${fill}</span>` : ''}${links ? ` · ${links}` : ''}`;
      const place = t.type === 'conveyor'
        ? pad ? `${padGlyph('rt')} maintenu : tracer` : 'clic gauche maintenu : tracer'
        : pad ? `${padGlyph('rt')} poser` : 'clic gauche : poser';
      html = pad
        ? `${status} · ${place} · ${padGlyph('lb')}${padGlyph('rb')} tourner · ${padGlyph('b')} annuler · ${padGlyph('left')}${padGlyph('right')} bâtiment`
        : `${status} · ${place} · <kbd>R</kbd> tourner · clic droit : annuler`;
    } else if (t.kind === 'dismantle') {
      html = pad
        ? `Démontage · ${padGlyph('rt')} démonter (remboursé) · ${padGlyph('b')} quitter`
        : 'Démontage · clic gauche : démonter (remboursé) · <kbd>F</kbd> quitter';
    } else {
      const id = this.build.interactTarget();
      const b = id !== null ? this.sim.buildings.get(id) : undefined;
      const mine = this.build.mineTarget();
      const belt = b ? null : this.build.beltTarget();
      const load = belt !== null ? this.build.beltLoad(belt) : null;
      const car = b || mine || load?.line ? null : this.cars.carNear(this.player.cur);
      const e = k('interact');
      if (b) html = `${e} ${b.type === 'hub' ? 'hangar : établi, paliers, stock' : b.type === 'garage' ? 'garage : assembler, pièces, voiture de course' : `configurer : ${BUILDINGS[b.type].name}`}`;
      else if (load?.line) {
        const pct = Math.round((this.build.beltProgress ?? 0) * 100);
        html = this.beltHold
          ? `Ramassage de la ligne (${load.line}) <span class="mine-bar"><i style="width:${pct}%"></i></span>`
          : load.tile
            ? `${e} prendre (${load.tile}) · maintenir : toute la ligne (${load.line})`
            : `${e} maintenir : prendre toute la ligne (${load.line})`;
      } else if (car) html = `${e} monter dans ${this.state.cars.find((c) => c.id === car)?.name ?? 'la voiture'}`;
      else if (mine) {
        const pct = Math.round((this.mineT / HAND.MINE_SECONDS) * 100);
        html = this.mineT > 0
          ? `Minage : ${RESOURCES[mine.resource].name} <span class="mine-bar"><i style="width:${pct}%"></i></span>`
          : `${e} maintenir : miner (${RESOURCES[mine.resource].name})`;
      } else html = pad
        ? `${padGlyph('y')} construire · ${padGlyph('left')}${padGlyph('right')} bâtiment · ${padGlyph('down')} démonter · ${padGlyph('view')} sac · ${padGlyph('start')} pause`
        : '<kbd>A</kbd> construire · <kbd>F</kbd> démonter';
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

  /** Dev helper: point the camera so that the screen center aims at a world cell (its ground). */
  debugLookAtCell(x: number, z: number): void {
    const tx = (x + 0.5) * FACTORY_CELL;
    const tz = (z + 0.5) * FACTORY_CELL;
    const target = new THREE.Vector3(tx, this.sim.terrain.heightAt(tx, tz), tz);
    const p = this.player.cur;
    this.orbit.yaw = Math.atan2(target.x - p.x, target.z - p.z);
    this.orbit.pitch = Math.max(-1.35, Math.min(0.9, Math.atan2(target.y - (p.y + PLAYER.CAMERA_HEIGHT), Math.hypot(target.x - p.x, target.z - p.z))));
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
    this.avatar.dispose();
    this.world.dispose();
    this.view.dispose();
    this.rig.dispose();
    this.disposeCamera();
  }
}
