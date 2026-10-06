import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Mode, ModeName } from '../core/ModeManager';
import { addLightRig, type LightRig } from '../core/Renderer';
import { PhysicsWorld } from '../core/physics/PhysicsWorld';
import { GRAVITY_RACE } from '../config/constants';
import type { GameState } from '../state/GameState';
import { buildTrack, pieceMatrix, type BuiltTrack } from '../track/TrackBuilder';
import { analyzeTrack } from '../track/validate';
import type { TrackData } from '../track/TrackData';
import { CarModel } from '../car/CarModel';
import { computeCarStats, type CarSpec } from '../car/stats';
import { tuningFromStats } from '../car/tuning';
import { Vehicle, NO_CONTROLS } from '../vehicle/Vehicle';
import { ChaseCamera } from '../vehicle/ChaseCamera';
import { readVehicleControls } from '../vehicle/VehicleInput';
import { VEHICLE } from '../data/vehicle';
import { TuningPanel } from '../dev/TuningPanel';
import { TEST_TRACK } from '../dev/testTrack';
import { createLayer, el } from '../ui/dom';

export interface RaceParams {
  track?: TrackData;
  /** Car to drive (defaults to the selected car, else a standard kart). */
  spec?: CarSpec;
  returnTo?: ModeName;
  returnParams?: unknown;
}

export const DEFAULT_SPEC: CarSpec = { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } };

/** Dev presets (URL ?car=…). */
export const DEV_SPECS: Record<string, CarSpec> = {
  kart: DEFAULT_SPEC,
  kartr: { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing' } },
  sport: { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' } },
  sportr: { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' } },
};

/** Driving mode: a track, a car, a chase camera. */
export class RaceMode implements Mode {
  readonly name = 'race' as const;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private disposeCamera: () => void;
  private physics = new PhysicsWorld(GRAVITY_RACE);
  private track!: BuiltTrack;
  private trackData!: TrackData;
  private vehicle!: Vehicle;
  private carModel!: CarModel;
  private chase!: ChaseCamera;
  private rig!: LightRig;
  private layer: HTMLElement | null = null;
  private speedEl: HTMLElement | null = null;
  private tuningPanel: TuningPanel | null = null;
  private params: RaceParams = {};
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly vel = new THREE.Vector3();
  private respawnPoint = { position: new THREE.Vector3(), yaw: 0 };

  constructor(private readonly game: Game, private readonly state: GameState) {
    const { camera, dispose } = game.makeCamera(68, 0.1, 3000);
    this.camera = camera;
    this.disposeCamera = dispose;
  }

  enter(params?: RaceParams): void {
    this.params = params ?? {};
    this.trackData = params?.track ?? TEST_TRACK;
    this.rig = addLightRig(this.scene, { shadowSize: 60, sky: 0x9fc0f0, fog: [200, 900] });
    this.track = buildTrack(this.trackData, this.game.assets, this.physics.world);
    this.scene.add(this.track.root);

    const sel = this.state.selectedCar;
    const spec: CarSpec = params?.spec ?? (sel ? { blueprint: sel.blueprint as CarSpec['blueprint'], parts: sel.parts } : DEFAULT_SPEC);
    const stats = computeCarStats(spec);
    this.carModel = new CarModel(this.game.assets, spec);
    this.scene.add(this.carModel.root);
    this.vehicle = new Vehicle(this.physics.world, this.carModel.geometry, tuningFromStats(stats), this.track.spawn);
    this.vehicle.offroad = this.track.ground;
    this.respawnPoint = { position: this.track.spawn.position.clone(), yaw: this.track.spawn.yaw };
    this.chase = new ChaseCamera(this.camera);

    this.layer = createLayer('race-hud');
    this.speedEl = el('div', { class: 'speedo' }, '0');
    this.layer.append(
      el('div', { class: 'speedo-wrap bottom-right' }, this.speedEl, el('div', { class: 'speedo-unit' }, 'km/h')),
      el('div', { class: 'panel top-left race-help' },
        el('b', {}, this.trackData.name),
        el('div', { class: 'muted small' }, 'Z/W accélérer · S freiner · Q/A D tourner · Espace dérapage · Retour arrière : respawn · Échap : quitter'),
      ),
    );
    if (new URLSearchParams(location.search).has('tune')) this.toggleTuning(true);
  }

  private toggleTuning(on: boolean): void {
    if (on && !this.tuningPanel) this.tuningPanel = new TuningPanel(this.vehicle.tuning, (t) => this.vehicle.applyTuning(t));
    else if (!on && this.tuningPanel) {
      this.tuningPanel.dispose();
      this.tuningPanel = null;
    }
  }

  respawn(): void {
    this.vehicle.reset(this.respawnPoint.position, this.respawnPoint.yaw);
    this.chase.snap();
  }

  fixedUpdate(dt: number): void {
    const input = this.game.input;
    const controls = readVehicleControls(input);
    if (input.consume('respawn')) this.respawn();
    this.vehicle.step(dt, controls ?? NO_CONTROLS);
    this.physics.step(dt);
    this.vehicle.afterWorldStep();
    if (this.vehicle.curPos.y < this.track.minY - 25 || this.vehicle.flippedTime > VEHICLE.FLIP_RESPAWN_S) this.respawn();
  }

  update(dt: number, alpha: number): void {
    const input = this.game.input;
    if (input.wasPressed('cancel')) {
      void this.game.switchMode(this.params.returnTo ?? 'menu', this.params.returnParams);
      return;
    }
    this.vehicle.interpolate(alpha, this.pos, this.quat);
    this.carModel.root.position.copy(this.pos);
    this.carModel.root.quaternion.copy(this.quat);
    const t = this.vehicle.tuning;
    const susp = this.carModel.geometry.wheels.map((_, i) => t.suspensionRest - this.vehicle.suspensionLength(i));
    this.carModel.update(dt, this.vehicle.steerAngle, this.vehicle.speed, susp);
    const lv = this.vehicle.body.linvel();
    this.vel.set(lv.x, lv.y, lv.z);
    this.chase.update(dt, this.pos, this.quat, this.vel, t.topSpeedMs);
    this.rig.follow(this.pos);
    if (this.speedEl) this.speedEl.textContent = String(Math.round(Math.abs(this.vehicle.speed) * 3.6));
    this.physics.updateDebug();
  }

  setDebug(enabled: boolean): void {
    this.physics.setDebug(this.scene, enabled);
    this.toggleTuning(enabled);
  }

  debugInfo(): string {
    const v = this.vehicle;
    return `speed ${(v.speed * 3.6).toFixed(1)} km/h  contact ${v.wheelsInContact}  offroad ${v.wheelsOffroad}  drift ${v.drifting}\npos ${v.curPos.toArray().map((n) => n.toFixed(1)).join(' ')}`;
  }

  /** Dev/test: XZ centers of the pieces along the route (validated path, else listed order). */
  pathWaypoints(): [number, number][] {
    const a = analyzeTrack(this.trackData);
    const order = a.path.length > 1 ? a.path : this.trackData.pieces.map((_, i) => i);
    const pts: [number, number][] = [];
    for (const i of order) {
      const p = this.trackData.pieces[i]!;
      const e = new THREE.Vector3().setFromMatrixPosition(pieceMatrix(p));
      pts.push([e.x, e.z]);
    }
    return pts;
  }

  /** For automated checks (window.__game). */
  debugState() {
    const v = this.vehicle;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(v.curQuat);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(v.curQuat);
    return {
      speedKmh: +(v.speed * 3.6).toFixed(1),
      pos: v.curPos.toArray().map((n) => +n.toFixed(2)),
      heading: +((Math.atan2(fwd.x, fwd.z) * 180) / Math.PI).toFixed(1),
      upY: +up.y.toFixed(3),
      contact: v.wheelsInContact,
      offroad: v.wheelsOffroad,
      track: this.trackData.id,
    };
  }

  exit(): void {
    this.toggleTuning(false);
    this.vehicle.dispose();
    this.track.dispose();
    this.physics.dispose();
    this.layer?.remove();
    this.disposeCamera();
  }
}
