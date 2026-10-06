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
import { FACTORY_CELL, GRAVITY_FACTORY } from '../config/constants';
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

export interface FactoryModeParams {
  layout?: 'demo' | 'stress';
}

const HOTKEYS: Action[] = ['hotbar1', 'hotbar2', 'hotbar3', 'hotbar4', 'hotbar5'];
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
    const spawn = saved && (!inside || inside.type === 'conveyor')
      ? new THREE.Vector3(saved.x, saved.y, saved.z)
      : new THREE.Vector3(FACTORY_MAP.spawn.x * FACTORY_CELL, 0.1, FACTORY_MAP.spawn.z * FACTORY_CELL);
    this.player = new CharacterController(this.world.physics, spawn);
    this.avatar = new PlayerAvatar(this.game.assets);
    this.scene.add(this.avatar.root);
    this.orbit = new OrbitCamera(this.camera, this.world.physics, this.player.collider);
    // New game: spawn south of the hub looking toward it (+Z).
    this.orbit.yaw = this.state.player ? this.state.player.yaw : 0;
    this.faceYaw = this.orbit.yaw;
    this.applySettings();

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
      garage: () => void this.game.switchMode('garage'),
      settings: () => openSettings(this.game, this.state, () => this.applySettings()),
      closePanel: () => this.closePanel(),
    });
    this.build.onChange = () => this.hud.buildHotbar(this.build.tool);
    this.build.onMessage = (text, kind) => toast(text, kind, 1600);

    this.unsub.push(
      this.game.pointer.subscribe((locked) => {
        if (locked) {
          this.lockWorked = true;
          this.resumeHint = false;
          this.hud.showOverlay(false, false);
          return;
        }
        if (this.hud.panelOpen || this.freeCursor) return;
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
    if (!this.game.pointer.locked && !this.freeCursor && !this.hud.panelOpen) void this.resume();
  };

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
    return (this.game.pointer.locked || (this.freeCursor && this.started)) && !this.hud.panelOpen;
  }

  fixedUpdate(dt: number): void {
    const input = this.game.input;
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

    // Camera
    if (this.game.pointer.locked && !this.hud.panelOpen) this.orbit.rotate(input.mouseDX, input.mouseDY);
    else if (this.freeCursor && input.isButtonDown(2) && !this.hud.panelOpen) {
      this.orbit.rotate(input.mouseDX, input.mouseDY);
      this.rmbDragged += Math.abs(input.mouseDX) + Math.abs(input.mouseDY);
    }
    if (controlling && input.wheel) this.orbit.zoom(input.wheel);

    this.renderPos.lerpVectors(this.player.prev, this.player.cur, alpha);
    this.orbit.update(this.renderPos, dt);

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

    // Aim: screen center when locked, cursor in free mode.
    if (this.freeCursor) this.raycaster.setFromCamera(new THREE.Vector2(input.ndcX, input.ndcY), this.camera);
    else this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    this.build.updateAim(this.raycaster.ray.origin, this.raycaster.ray.direction, this.renderPos, this.player.collider);
    this.build.update();

    if (controlling) this.handleActions();
    else if (this.resumeHint && !this.hud.panelOpen) {
      // Second Escape (tool already closed): open the pause menu.
      if (input.wasPressed('cancel') && performance.now() - this.toolEscAt > ESC_GRACE_MS) {
        this.resumeHint = false;
        this.hud.showOverlay(true, true);
      }
    } else if (this.hud.panelOpen && (input.wasPressed('cancel') || (input.wasPressed('buildMenu') && this.hud.openPanelKind === 'build') || (input.wasPressed('inventory') && this.hud.openPanelKind === 'inventory'))) this.closePanel();
    this.updateMining(dt, controlling);
    this.hud.frame(dt);

    this.hud.setCrosshair(this.game.pointer.locked && !this.hud.panelOpen);
    this.updateHint();

    this.rig.follow(this.renderPos);
    this.view.update(dt, this.game.loop.factoryAlpha);

    this.hudTimer += dt;
    if (this.hudTimer > 0.2) {
      this.hudTimer = 0;
      this.hud.updateStorage();
      this.hud.tick();
      this.hud.buildHotbar(this.build.tool);
      this.updateObjectives();
    }
    this.state.player = { x: this.player.cur.x, y: this.player.cur.y, z: this.player.cur.z, yaw: this.orbit.yaw };
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
    if (input.wasPressed('garage')) void this.game.switchMode('garage');
    if (input.wasPressed('interact')) {
      const id = this.build.interactTarget();
      const b = id !== null ? this.sim.buildings.get(id) : undefined;
      if (b?.type === 'hub') this.openPanel('hub');
      else if (b) this.openPanel('machine', b.id);
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
    if (!this.controlling) html = this.resumeHint && !this.hud.panelOpen ? 'Clic : reprendre · <kbd>Échap</kbd> pause' : '';
    else if (t.kind === 'build') {
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
      if (b) html = `<kbd>E</kbd> ${b.type === 'hub' ? 'hangar : établi, paliers, stock' : `configurer : ${BUILDINGS[b.type].name}`}`;
      else if (mine) {
        const pct = Math.round((this.mineT / HAND.MINE_SECONDS) * 100);
        html = this.mineT > 0
          ? `Minage : ${RESOURCES[mine.resource].name} <span class="mine-bar"><i style="width:${pct}%"></i></span>`
          : `<kbd>E</kbd> maintenir : miner (${RESOURCES[mine.resource].name})`;
      } else html = '<kbd>1-5</kbd> construire · <kbd>A</kbd> menu · <kbd>F</kbd> démonter';
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
    this.hud.dispose();
    this.player.dispose();
    this.world.dispose();
    this.view.dispose();
    this.disposeCamera();
  }
}
