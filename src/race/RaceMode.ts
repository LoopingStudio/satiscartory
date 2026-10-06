import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Mode, ModeName } from '../core/ModeManager';
import { addLightRig, type LightRig } from '../core/Renderer';
import { PhysicsWorld } from '../core/physics/PhysicsWorld';
import { GRAVITY_RACE, PHYS_DT } from '../config/constants';
import type { GameState } from '../state/GameState';
import { SaveManager } from '../state/SaveManager';
import { buildTrack, type BuiltTrack, type Gate } from '../track/TrackBuilder';
import type { TrackData } from '../track/TrackData';
import { centerline, finishDirections } from '../track/layout';
import { CarModel } from '../car/CarModel';
import { computeCarStats, type CarSpec } from '../car/stats';
import { tuningFromStats } from '../car/tuning';
import { Vehicle, NO_CONTROLS } from '../vehicle/Vehicle';
import { ChaseCamera } from '../vehicle/ChaseCamera';
import { readVehicleControls } from '../vehicle/VehicleInput';
import { VEHICLE } from '../data/vehicle';
import { RACE } from '../data/race';
import { TuningPanel } from '../dev/TuningPanel';
import { TEST_TRACK } from '../dev/testTrack';
import { clear, createLayer, el, formatDelta, formatTime, toast } from '../ui/dom';
import { RaceSession, type RaceEvent } from './RaceSession';
import { crossGate } from './crossing';
import { MEDAL_LABEL, MEDAL_ORDER, medalFor, type Medal } from './medals';
import { countAttempt, submitRun } from './records';
import { LOANER_SPEC } from '../garage/assembly';

export interface RaceParams {
  track?: TrackData;
  /** Car to drive (defaults to the selected car, else the loaner kart). */
  spec?: CarSpec;
  /** Test drive from the editor: no records, offers to set the author time. */
  test?: boolean;
  returnTo?: ModeName;
  returnParams?: unknown;
  /** Called when a test run finishes (editor sets the author time). */
  onTestFinish?: (ms: number) => void;
}

export const DEFAULT_SPEC: CarSpec = { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } };

/** Dev presets (URL ?car=…). */
export const DEV_SPECS: Record<string, CarSpec> = {
  kart: DEFAULT_SPEC,
  kartr: { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing' } },
  sport: { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel', panels: 'panel' } },
  sportr: { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' } },
  loaner: LOANER_SPEC,
};


/** Time trial: countdown, checkpoints in any order, respawn, restart, medals and personal best. */
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
  private session!: RaceSession;
  private params: RaceParams = {};
  private spec!: CarSpec;
  private carId: string | null = null;
  private tuningPanel: TuningPanel | null = null;
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly vel = new THREE.Vector3();
  private readonly prevStep = new THREE.Vector3();
  private checkpointCount = 0;
  /** Route direction through each finish gate (crossing it the other way does not finish). */
  private finishDir = new Map<number, 1 | -1>();
  private respawnPoint = { position: new THREE.Vector3(), yaw: 0 };
  private pending: RaceEvent[] = [];
  // HUD
  private layer: HTMLElement | null = null;
  private hud: Record<string, HTMLElement> = {};
  private splitTimer = 0;
  private finished = false;

  constructor(private readonly game: Game, private readonly state: GameState) {
    const { camera, dispose } = game.makeCamera(68, 0.1, 3000);
    this.camera = camera;
    this.disposeCamera = dispose;
  }

  enter(params?: RaceParams): void {
    this.params = params ?? {};
    this.trackData = params?.track ?? TEST_TRACK;
    this.rig = addLightRig(this.scene, { shadowSize: 60, sky: 0x9fc0f0, fog: [220, 1000] });
    this.track = buildTrack(this.trackData, this.game.assets, this.physics.world);
    this.scene.add(this.track.root);
    this.checkpointCount = this.track.gates.filter((g) => g.kind === 'checkpoint').length;
    this.finishDir = finishDirections(this.trackData, this.track.gates);

    const sel = this.state.selectedCar;
    this.spec = params?.spec ?? (sel ? { blueprint: sel.blueprint as CarSpec['blueprint'], parts: sel.parts } : LOANER_SPEC);
    this.carId = params?.spec ? null : (sel?.id ?? null);
    const stats = computeCarStats(this.spec);
    this.carModel = new CarModel(this.game.assets, this.spec);
    this.scene.add(this.carModel.root);
    this.vehicle = new Vehicle(this.physics.world, this.carModel.geometry, tuningFromStats(stats), this.track.spawn);
    this.vehicle.offroad = this.track.ground;
    this.chase = new ChaseCamera(this.camera, this.physics.world, this.vehicle.collider);
    this.buildHud();
    this.restart();
    if (new URLSearchParams(location.search).has('tune')) this.toggleTuning(true);
  }

  // ------------------------------------------------------------------ flow

  /** An unfinished run that gets interrupted still counts as an attempt. */
  private countUnfinished(): void {
    if (this.session?.phase === 'running' && !this.params.test) {
      countAttempt(this.state.records, this.trackData.id);
      SaveManager.save(this.state);
    }
  }

  restart(): void {
    this.countUnfinished();
    this.session = new RaceSession(this.checkpointCount, PHYS_DT * 1000, RACE.COUNTDOWN_TICKS);
    this.respawnPoint = { position: this.track.spawn.position.clone(), yaw: this.track.spawn.yaw };
    this.vehicle.reset(this.respawnPoint.position, this.respawnPoint.yaw);
    this.prevStep.copy(this.vehicle.curPos);
    this.chase.snap();
    this.finished = false;
    this.pending = [];
    this.hud.finish?.remove();
    delete this.hud.finish;
    this.splitTimer = 0;
    if (this.hud.split) this.hud.split.style.opacity = '0';
  }

  respawn(): void {
    if (this.session.phase === 'finished') return;
    this.session.respawns++;
    this.vehicle.reset(this.respawnPoint.position, this.respawnPoint.yaw);
    this.prevStep.copy(this.vehicle.curPos);
    this.chase.snap();
  }

  private respawnAt(gate: Gate, dir: 1 | -1): void {
    const fwd = gate.forward.clone().multiplyScalar(dir);
    this.respawnPoint = {
      position: gate.center.clone().addScaledVector(fwd, RACE.RESPAWN_AHEAD).add(new THREE.Vector3(0, 0.6, 0)),
      yaw: Math.atan2(fwd.x, fwd.z),
    };
  }

  private exitTo(): void {
    this.countUnfinished();
    void this.game.switchMode(this.params.returnTo ?? 'tracks', this.params.returnParams ?? { selected: this.trackData.id });
  }

  // ------------------------------------------------------------------ simulation

  fixedUpdate(dt: number): void {
    const input = this.game.input;
    if (input.consume('restart')) this.restart();
    if (input.consume('respawn')) this.respawn();

    for (const ev of this.session.step()) this.pending.push(ev);
    const phase = this.session.phase;
    let controls = phase === 'running' ? readVehicleControls(input) : NO_CONTROLS;
    if (phase === 'finished') controls = { ...NO_CONTROLS, brake: 0.4 };
    this.prevStep.copy(this.vehicle.curPos);
    this.vehicle.step(dt, controls);
    this.physics.step(dt);
    this.vehicle.afterWorldStep();
    // The car waits on the line during the countdown.
    if (phase === 'countdown') this.vehicle.hold();

    if (phase === 'running') {
      for (const g of this.track.gates) {
        if (g.kind === 'start') continue;
        const hit = crossGate(this.prevStep, this.vehicle.curPos, g);
        if (!hit) continue;
        const forward = hit.dir === (this.finishDir.get(g.piece) ?? hit.dir);
        for (const e of this.session.cross(g.kind, g.piece, hit.t, forward)) {
          if (e.type === 'checkpoint') this.respawnAt(g, hit.dir);
          this.pending.push(e);
        }
      }
    }
    if (this.vehicle.curPos.y < this.track.minY - RACE.FALL_LIMIT || this.vehicle.flippedTime > VEHICLE.FLIP_RESPAWN_S) this.respawn();
  }

  // ------------------------------------------------------------------ frame

  update(dt: number, alpha: number): void {
    const input = this.game.input;
    if (input.wasPressed('cancel')) {
      this.exitTo();
      return;
    }
    if (this.finished && input.wasPressed('retry')) this.restart();

    for (const e of this.pending) this.onEvent(e);
    this.pending = [];

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
    this.updateHud(dt);
    this.physics.updateDebug();
  }

  private onEvent(e: RaceEvent): void {
    const rec = this.state.records[this.trackData.id];
    switch (e.type) {
      case 'go':
        this.flashCountdown('GO !');
        break;
      case 'checkpoint': {
        const pb = rec?.splits?.[e.index];
        const delta = pb !== undefined && !this.params.test ? e.ms - pb : null;
        this.showSplit(e.ms, delta, `CP ${e.index + 1}/${this.checkpointCount}`);
        break;
      }
      case 'missingCheckpoints':
        toast(`Il manque ${e.remaining} checkpoint${e.remaining > 1 ? 's' : ''} !`, 'error');
        break;
      case 'finish':
        this.onFinish(e.ms);
        break;
    }
  }

  private onFinish(ms: number): void {
    this.finished = true;
    let improved = false;
    let previous: number | null = null;
    if (!this.params.test) {
      const r = submitRun(this.state.records, this.trackData.id, ms, this.session.splits, this.carId);
      improved = r.improved;
      previous = r.previous;
      if (this.carId) this.state.objectives.race = true;
      SaveManager.save(this.state);
    } else {
      this.params.onTestFinish?.(ms);
    }
    this.showFinish(ms, medalFor(ms, this.trackData.medals), improved, previous);
  }

  // ------------------------------------------------------------------ HUD

  private buildHud(): void {
    this.layer = createLayer('race-hud');
    const h = this.hud;
    h.timer = el('div', { class: 'race-timer mono' }, '0:00.000');
    h.cp = el('div', { class: 'race-cp' });
    h.split = el('div', { class: 'race-split mono' });
    h.countdown = el('div', { class: 'race-countdown' });
    h.speed = el('div', { class: 'speedo' }, '0');
    h.info = el('div', { class: 'panel top-left race-info' });
    this.layer.append(
      el('div', { class: 'top-center race-top' }, h.timer, h.cp, h.split),
      h.countdown,
      el('div', { class: 'speedo-wrap bottom-right' }, h.speed, el('div', { class: 'speedo-unit' }, 'km/h')),
      h.info,
      el('div', { class: 'bottom-left race-keys muted small' },
        el('kbd', {}, 'Retour arrière'), ' respawn · ', el('kbd', {}, 'Suppr'), ' recommencer · ', el('kbd', {}, 'Échap'), ' quitter'),
    );
    this.renderInfo();
  }

  private renderInfo(): void {
    const info = this.hud.info!;
    clear(info);
    const rec = this.state.records[this.trackData.id];
    info.append(el('b', {}, this.trackData.name), el('div', { class: 'muted small' }, this.params.test ? 'Essai depuis l’éditeur' : `Record : ${formatTime(rec?.bestMs)}`));
    const medals = this.trackData.medals;
    if (medals) {
      const best = medalFor(rec?.bestMs, medals);
      const list = el('div', { class: 'medal-list' });
      for (const m of MEDAL_ORDER) {
        const got = best !== null && MEDAL_ORDER.indexOf(best) <= MEDAL_ORDER.indexOf(m);
        list.appendChild(
          el('div', { class: `medal-row${got ? ' got' : ''}` },
            el('span', { class: `medal medal-${m}` }), el('span', {}, MEDAL_LABEL[m]), el('span', { class: 'spacer' }), el('span', { class: 'mono' }, formatTime(medals[m]))),
        );
      }
      info.appendChild(list);
    }
  }

  private flashCountdown(text: string): void {
    const c = this.hud.countdown!;
    c.textContent = text;
    c.classList.remove('pop');
    void c.offsetWidth;
    c.classList.add('pop');
  }

  private showSplit(ms: number, delta: number | null, label: string): void {
    const s = this.hud.split!;
    clear(s);
    s.append(el('span', {}, `${label}  ${formatTime(ms)}`));
    if (delta !== null) s.append(el('span', { class: delta <= 0 ? 'good' : 'bad' }, `  ${formatDelta(delta)}`));
    s.style.opacity = '1';
    this.splitTimer = 2.5;
  }

  private showFinish(ms: number, medal: Medal | null, improved: boolean, previous: number | null): void {
    const test = !!this.params.test;
    const box = el('div', { class: 'panel center finish-panel' },
      el('h2', {}, test ? 'Essai terminé' : 'Arrivée !'),
      el('div', { class: 'finish-time mono' }, formatTime(ms)),
      medal
        ? el('div', { class: 'finish-medal' }, el('span', { class: `medal big medal-${medal}` }), `Médaille ${MEDAL_LABEL[medal]}`)
        : el('div', { class: 'muted' }, this.trackData.medals ? 'Pas de médaille cette fois' : ''),
      improved && previous !== null ? el('div', { class: 'good' }, `Nouveau record ! ${formatDelta(ms - previous)}`) : null,
      improved && previous === null && !test ? el('div', { class: 'good' }, 'Premier temps enregistré') : null,
      !improved && previous !== null ? el('div', { class: 'bad' }, `Record : ${formatTime(previous)} (${formatDelta(ms - previous)})`) : null,
      test ? el('div', { class: 'muted small' }, 'Ce temps devient le temps auteur du circuit.') : null,
      el('div', { class: 'row', style: 'margin-top:12px;justify-content:center' },
        el('button', { class: 'primary', onclick: () => this.restart() }, 'Réessayer (Entrée)'),
        el('button', { onclick: () => this.exitTo() }, test ? 'Retour à l’éditeur' : 'Circuits'),
        !test ? el('button', { onclick: () => void this.game.switchMode('garage') }, 'Garage') : null,
      ),
    );
    this.hud.finish = box;
    this.layer?.appendChild(box);
    this.renderInfo();
  }

  private updateHud(dt: number): void {
    const s = this.session;
    this.hud.timer!.textContent = formatTime(s.timeMs);
    this.hud.cp!.textContent = this.checkpointCount ? `CP ${s.passed.size}/${this.checkpointCount}` : '';
    this.hud.speed!.textContent = String(Math.round(Math.abs(this.vehicle.speed) * 3.6));
    if (s.phase === 'countdown') {
      const label = String(Math.max(1, Math.ceil(s.countdownMs / 500)));
      if (this.hud.countdown!.textContent !== label) this.flashCountdown(label);
    }
    if (this.splitTimer > 0) {
      this.splitTimer -= dt;
      if (this.splitTimer <= 0) this.hud.split!.style.opacity = '0';
    }
  }

  // ------------------------------------------------------------------ dev

  private toggleTuning(on: boolean): void {
    if (on && !this.tuningPanel) this.tuningPanel = new TuningPanel(this.vehicle.tuning, (t) => this.vehicle.applyTuning(t));
    else if (!on && this.tuningPanel) {
      this.tuningPanel.dispose();
      this.tuningPanel = null;
    }
  }

  setDebug(enabled: boolean): void {
    this.physics.setDebug(this.scene, enabled);
    this.toggleTuning(enabled);
  }

  debugInfo(): string {
    const v = this.vehicle;
    return `speed ${(v.speed * 3.6).toFixed(1)} km/h  contact ${v.wheelsInContact}  offroad ${v.wheelsOffroad}  drift ${v.drifting}\npos ${v.curPos.toArray().map((n) => n.toFixed(1)).join(' ')}`;
  }

  /** Dev/test: road centerline points (see track/layout.ts). */
  pathWaypoints(): [number, number, number?][] {
    return centerline(this.trackData);
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
      phase: this.session.phase,
      timeMs: Math.round(this.session.timeMs),
      cp: this.session.passed.size,
      cpTotal: this.checkpointCount,
      finished: this.session.phase === 'finished',
      respawns: this.session.respawns,
      blueprint: this.spec.blueprint,
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
