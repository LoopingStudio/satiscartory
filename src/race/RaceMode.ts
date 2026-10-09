import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Mode, ModeName } from '../core/ModeManager';
import { addLightRig, type LightRig } from '../core/Renderer';
import { PhysicsWorld } from '../core/physics/PhysicsWorld';
import { GRAVITY_RACE, PHYS_DT } from '../config/constants';
import type { Action } from '../config/keybinds';
import type { GameState } from '../state/GameState';
import { SaveManager } from '../state/SaveManager';
import { buildTrack, type BuiltTrack, type Gate } from '../track/TrackBuilder';
import type { TrackData } from '../track/TrackData';
import { centerline, finishDirections } from '../track/layout';
import { CarModel } from '../car/CarModel';
import { computeCarStats, type CarSpec } from '../car/stats';
import { tuningFromStats, type VehicleTuning } from '../car/tuning';
import { WearMeter, autoResetCause, type ResetCause } from '../car/wearMeter';
import { wornTuning } from '../car/wornTuning';
import { Vehicle, NO_CONTROLS } from '../vehicle/Vehicle';
import { ChaseCamera } from '../vehicle/ChaseCamera';
import { readVehicleControls } from '../vehicle/VehicleInput';
import { VEHICLE } from '../data/vehicle';
import { RACE } from '../data/race';
import { TuningPanel } from '../dev/TuningPanel';
import { TEST_TRACK } from '../dev/testTrack';
import { clear, createLayer, el, formatDelta, formatTime, toast } from '../ui/dom';
import { dual, html, keyLabel, padGlyph, padLabel } from '../ui/padHints';
import { RaceSession, type RaceEvent } from './RaceSession';
import { crossGate } from './crossing';
import { MEDAL_LABEL, MEDAL_ORDER, medalFor, type Medal } from './medals';
import { countAttempt, submitRun } from './records';
import { endAttempt, raceCarFor, type RaceCar } from './raceCar';
import { LOANER_SPEC, type CarInstance } from '../garage/assembly';
import { isBlocked, type CarWear, type RaceBlock } from '../data/wear';
import { HALTED_NOTE, RACE_LOANER, TO_REPAIR_AT_GARAGE, attemptText, blockText, fallbackText, finishBlockedText, haltedText, lastAttemptText } from '../data/wearText';
import { WearHud } from '../ui/wearHud';

export interface RaceParams {
  track?: TrackData;
  /** Car to drive (defaults to the car of `carId`, else the selected car, else the loaner kart). */
  spec?: CarSpec;
  /**
   * Assembled car this run is for (null = the loaner): drives it unless `spec` is given, and goes in the
   * records and the « race » objective. Defaults to the selected car, or to none when `spec` is forced.
   */
  carId?: string | null;
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
  /** The raced car (race/raceCar.ts): whether it wears, and whether another attempt may start (attemptGate). */
  private raced!: RaceCar;
  /**
   * « Recommencer » with a car that wore past the race limit: back on the line, the session frozen in its countdown
   * (no timer, no wear, no respawn), the halted panel offers the loaner.
   */
  private halted = false;
  /** The finish panel offers the loaner instead of « Réessayer »: Entrée does what its button does. */
  private finishLoaner = false;
  /** The player's car when it wears in this race, and its meter (null: the loaner, a forced spec, a test drive). */
  private wearCar: CarInstance | null = null;
  private meter: WearMeter | null = null;
  /** The car's wear when the attempt started (one copy per attempt): the finish panel says what the attempt wore. */
  private attemptWear: CarWear | null = null;
  /** The race limit was crossed in this race: said once (a toast), the next attempt halts. */
  private limitWarned = false;
  /** The car's tuning when new; an attempt drives it worn as the car was when it started (attemptTuning). */
  private baseTuning!: VehicleTuning;
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
  /** Pill and damage flash of a car that wears (null: the loaner, a forced spec, a test drive show nothing). */
  private wearHud: WearHud | null = null;
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

    // A car to repair never starts: the loaner races instead (whatever led here: the menu, ?mode=race…).
    const raced = raceCarFor(this.state, { carId: params?.carId, spec: params?.spec, test: params?.test });
    this.raced = raced;
    this.spec = raced.spec;
    this.carId = raced.car?.id ?? null;
    if (raced.fallback) toast(fallbackText(raced.fallback.car.name), 'info', 3200);
    // Wear: the player's own car only. The loaner, a forced spec (?car=) and the editor's test drive never wear.
    this.wearCar = raced.wears ? raced.car : null;
    this.meter = this.wearCar ? new WearMeter(this.wearCar) : null;
    const stats = computeCarStats(this.spec);
    this.baseTuning = tuningFromStats(stats);
    this.carModel = new CarModel(this.game.assets, this.spec);
    this.scene.add(this.carModel.root);
    this.vehicle = new Vehicle(this.physics.world, this.carModel.geometry, this.attemptTuning(), this.track.spawn);
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

  /**
   * Tuning of an attempt: the car worn as it is now (car/wornTuning.ts), the very same object as baseTuning when it
   * does not wear or is new. Fixed for the whole attempt: a respawn does not change it.
   */
  private attemptTuning(): VehicleTuning {
    const car = this.wearCar;
    return car ? wornTuning(this.baseTuning, car.wear, car.parts) : this.baseTuning;
  }

  /**
   * Another attempt (Suppr, Entrée / Y and « Réessayer » at the finish, View): counts the one interrupted, puts the car
   * back on the line. A car that wore past the race limit during the session does not start it: halted (see
   * `halted`). Never switches modes: it runs from fixedUpdate too, and a switch frees the world it steps.
   */
  restart(): void {
    // The interrupted attempt's last shock counts first: in the gate, the save and the copy taken for the next one.
    const block = endAttempt(this.raced, this.meter);
    this.countUnfinished();
    // A worn car starts each attempt with its wear of now. Without wear nothing is applied again (the dev tuning
    // panel keeps its values); the panel follows a new tuning object.
    if (this.wearCar && !block) {
      const t = this.attemptTuning();
      if (t !== this.vehicle.tuning) {
        this.vehicle.applyTuning(t);
        if (this.tuningPanel) {
          this.toggleTuning(false);
          this.toggleTuning(true);
        }
      }
    }
    this.session = new RaceSession(this.checkpointCount, PHYS_DT * 1000, RACE.COUNTDOWN_TICKS);
    this.respawnPoint = { position: this.track.spawn.position.clone(), yaw: this.track.spawn.yaw };
    this.vehicle.reset(this.respawnPoint.position, this.respawnPoint.yaw);
    this.prevStep.copy(this.vehicle.curPos);
    this.chase.snap();
    this.finished = false;
    this.finishLoaner = false;
    this.pending = [];
    this.hud.finish?.remove();
    delete this.hud.finish;
    this.hud.halt?.remove();
    delete this.hud.halt;
    this.splitTimer = 0;
    if (this.hud.split) this.hud.split.style.opacity = '0';
    this.halted = block !== null;
    if (block) this.showHalted(block);
    else if (this.wearCar) this.attemptWear = { ...this.wearCar.wear };
  }

  /**
   * Races the same track with the loaner instead of a car to repair (halted or finish panel). From a click, or from
   * update() followed by a return: the switch frees this mode at once.
   */
  private raceLoaner(): void {
    void this.game.switchMode('race', { ...this.params, carId: null } satisfies RaceParams);
  }

  /** Back to the last checkpoint; once started, it wears the car by its cause (see WEAR.RESET). Not while halted. */
  respawn(cause: ResetCause = 'key'): void {
    if (this.halted || this.session.phase === 'finished') return;
    this.session.respawns++;
    this.vehicle.reset(this.respawnPoint.position, this.respawnPoint.yaw);
    this.prevStep.copy(this.vehicle.curPos);
    this.chase.snap();
    if (this.session.phase === 'running') this.meter?.putBack(cause);
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
    if (input.consume('respawn')) this.respawn('key');

    // Halted: the session stays in its countdown (the car held on the line, nothing timed nor worn).
    if (!this.halted) for (const ev of this.session.step()) this.pending.push(ev);
    const phase = this.session.phase;
    let controls = phase === 'running' ? readVehicleControls(input) : NO_CONTROLS;
    if (phase === 'finished') controls = { ...NO_CONTROLS, brake: 0.4 };
    this.prevStep.copy(this.vehicle.curPos);
    this.vehicle.step(dt, controls);
    // Only the race itself wears the car: not the countdown, nor the braking after the line.
    if (phase === 'running') this.meter?.step(dt, this.vehicle, controls);
    else this.meter?.closeShock();
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
    const fell = this.vehicle.curPos.y < this.track.minY - RACE.FALL_LIMIT;
    if (fell || this.vehicle.flippedTime > VEHICLE.FLIP_RESPAWN_S) this.respawn(autoResetCause(fell, this.vehicle.curQuat));
  }

  // ------------------------------------------------------------------ frame

  update(dt: number, alpha: number): void {
    const input = this.game.input;
    // PADBINDS.race: Menu quits like Échap, B respawns, View restarts, Y retries (the finish panel takes the pad).
    input.padProfile = 'race';
    if (input.wasPressed('cancel')) {
      this.exitTo();
      return;
    }
    if ((this.finished || this.halted) && input.wasPressed('retry')) {
      // Entrée does what the panel's first button shows (the pad's Y clicks it): the loaner when halted or offered at
      // the finish, else another attempt (restart() halts a car to repair, with its panel).
      if (this.halted || this.finishLoaner) {
        this.raceLoaner();
        return;
      }
      this.restart();
    }

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
    // The attempt ends at the line: a shock still open there counts now (in the save, the panel and its summary). Then
    // nothing wears the car any more (no respawn after the line): the panel's choice holds.
    const block = endAttempt(this.raced, this.meter);
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
    this.showFinish(ms, medalFor(ms, this.trackData.medals), improved, previous, block);
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
    // A car that wears: its state under « km/h », its damage flashing above the speed.
    const wear = this.wearCar ? (this.wearHud = new WearHud()) : null;
    this.layer.append(
      el('div', { class: 'top-center race-top' }, h.timer, h.cp, h.split),
      h.countdown,
      el('div', { class: 'speedo-wrap bottom-right' }, wear?.flash.el, h.speed, el('div', { class: 'speedo-unit' }, 'km/h'), wear?.pill),
      h.info,
      el('div', { class: 'bottom-left race-keys muted small' }, html(this.keysHint())),
    );
    this.renderInfo();
  }

  /** Controls reminder: the race keys, or on the pad the driving controls too (on two lines, it is longer). */
  private keysHint(): string {
    const pad = (a: Action) => padLabel(a, 'race');
    return dual(
      `${keyLabel('respawn')} respawn · ${keyLabel('restart')} recommencer · ${keyLabel('cancel')} quitter`,
      `${padGlyph('rt')} accélérer · ${padGlyph('lt')} freiner / marche arrière · ${padGlyph('ls')} tourner · ${pad('handbrake')} dérapage<br>` +
        `${pad('respawn')} respawn · ${pad('restart')} recommencer · ${pad('cancel')} quitter`,
    );
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

  /** `block`: the car wore past the race limit during this run (endAttempt): no other attempt, the loaner instead. */
  private showFinish(ms: number, medal: Medal | null, improved: boolean, previous: number | null, block: RaceBlock<CarInstance> | null): void {
    const test = !!this.params.test;
    this.finishLoaner = block !== null;
    // What this attempt wore, from the copy taken at its start.
    const worn = this.wearCar ? attemptText(this.wearCar.blueprint, this.attemptWear ?? undefined, this.wearCar.wear) : null;
    // Same as the keys: Y (or View, like Suppr) retries, B (or Menu, like Échap) goes back.
    const retry = block
      ? el('button', { class: 'primary', 'data-action': 'loaner', onclick: () => this.raceLoaner(), 'data-pad-default': true, 'data-pad-btn': 'y view' },
        `${RACE_LOANER} `, html(dual('(Entrée)', padGlyph('y'))))
      : el('button', { class: 'primary', 'data-action': 'retry', onclick: () => this.restart(), 'data-pad-default': true, 'data-pad-btn': 'y view' },
        'Réessayer ', html(dual('(Entrée)', padGlyph('y'))));
    // A pad scope: while it shows, the pad drives it (PadNav) and the race reads nothing from the pad.
    // Passive: it pops up while driving; a handbrake or respawn tap just after the line must not answer it.
    const box = el('div', { class: 'panel center finish-panel', 'data-pad-scope': '', 'data-pad-passive': '' },
      el('h2', {}, test ? 'Essai terminé' : 'Arrivée !'),
      el('div', { class: 'finish-time mono' }, formatTime(ms)),
      medal
        ? el('div', { class: 'finish-medal' }, el('span', { class: `medal big medal-${medal}` }), `Médaille ${MEDAL_LABEL[medal]}`)
        : el('div', { class: 'muted' }, this.trackData.medals ? 'Pas de médaille cette fois' : ''),
      improved && previous !== null ? el('div', { class: 'good' }, `Nouveau record ! ${formatDelta(ms - previous)}`) : null,
      improved && previous === null && !test ? el('div', { class: 'good' }, 'Premier temps enregistré') : null,
      !improved && previous !== null ? el('div', { class: 'bad' }, `Record : ${formatTime(previous)} (${formatDelta(ms - previous)})`) : null,
      test ? el('div', { class: 'muted small' }, 'Ce temps devient le temps auteur du circuit.') : null,
      worn ? el('div', { class: 'muted finish-wear' }, worn) : null,
      block ? el('div', { class: 'bad', style: 'margin-top:6px' }, finishBlockedText(block.car.name, blockText(block.car) ?? '')) : null,
      el('div', { class: 'row', style: 'margin-top:12px;justify-content:center' },
        retry,
        el('button', { onclick: () => this.exitTo(), 'data-pad-btn': 'b start' },
          test ? 'Retour à l’éditeur' : 'Circuits', html(dual('', ` ${padGlyph('b')}`))),
        !test ? el('button', { onclick: () => void this.game.switchMode('factory') }, 'Usine') : null,
      ),
    );
    this.hud.finish = box;
    this.layer?.appendChild(box);
    this.renderInfo();
  }

  /**
   * The halted panel: the car is to repair, no attempt starts with it. Passive like the finish panel (a handbrake tap
   * just after Suppr or View must not change cars). Its buttons switch modes from a click only (PadNav clicks during
   * the poll); Entrée goes through update() (see raceLoaner), Échap like everywhere.
   */
  private showHalted(block: RaceBlock<CarInstance>): void {
    const c = this.hud.countdown;
    if (c) {
      c.textContent = '';
      c.classList.remove('pop');
    }
    const box = el('div', { class: 'panel center finish-panel', 'data-pad-scope': '', 'data-pad-passive': '' },
      el('h2', {}, TO_REPAIR_AT_GARAGE),
      el('div', {}, haltedText(block.car.name, blockText(block.car) ?? '')),
      el('div', { class: 'muted small', style: 'margin-top:4px' }, HALTED_NOTE),
      el('div', { class: 'row', style: 'margin-top:12px;justify-content:center;flex-wrap:wrap' },
        el('button', { class: 'primary', 'data-action': 'loaner', onclick: () => this.raceLoaner(), 'data-pad-default': true, 'data-pad-btn': 'y' },
          `${RACE_LOANER} `, html(dual('(Entrée)', padGlyph('y')))),
        el('button', { 'data-action': 'factory', onclick: () => void this.game.switchMode('factory') }, 'Usine'),
        el('button', { 'data-action': 'back', onclick: () => this.exitTo(), 'data-pad-btn': 'b start' }, 'Circuits', html(dual('', ` ${padGlyph('b')}`))),
      ),
    );
    this.hud.halt = box;
    this.layer?.appendChild(box);
  }

  private updateHud(dt: number): void {
    const s = this.session;
    this.hud.timer!.textContent = formatTime(s.timeMs);
    this.hud.cp!.textContent = this.checkpointCount ? `CP ${s.passed.size}/${this.checkpointCount}` : '';
    this.hud.speed!.textContent = String(Math.round(Math.abs(this.vehicle.speed) * 3.6));
    // Halted: the frozen countdown shows nothing.
    if (s.phase === 'countdown' && !this.halted) {
      const label = String(Math.max(1, Math.ceil(s.countdownMs / 500)));
      if (this.hud.countdown!.textContent !== label) this.flashCountdown(label);
    }
    if (this.splitTimer > 0) {
      this.splitTimer -= dt;
      if (this.splitTimer <= 0) this.hud.split!.style.opacity = '0';
    }
    this.updateWear();
  }

  /**
   * Wear of the raced car, every frame without allocating: its pill, the flash of a new hit, and once per race the
   * race limit crossed (this attempt goes on as it started; the next one halts). Not at the finish nor when halted
   * (a shock charged as the attempt ends): their panels say it.
   */
  private updateWear(): void {
    const car = this.wearCar;
    if (!car) return;
    this.wearHud?.update(car);
    if (this.meter) this.wearHud?.onHit(this.meter.last);
    if (!this.limitWarned && isBlocked(car)) {
      this.limitWarned = true;
      if (!this.finished && !this.halted) toast(lastAttemptText(blockText(car) ?? ''), 'info', 3200);
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
      /** Wear of the raced car (‰ per slot), null when it does not wear. */
      wear: this.wearCar ? { ...this.wearCar.wear } : null,
      /** Hits that wore the car 1 ‰ or more (WearMeter.last.seq), and the last one: what the flash showed. */
      hits: this.meter?.last.seq ?? 0,
      lastHit: this.meter && this.meter.last.seq ? { ...this.meter.last } : null,
      /** The car wore past the race limit: « Recommencer » halted it (the halted panel shows). */
      halted: this.halted,
      /** The loaner races instead of the car asked for (it was to repair). */
      fallback: this.raced.fallback?.car.id ?? null,
    };
  }

  exit(): void {
    // The fractions of a thousandth are rounded into the car before the mode switch saves.
    this.meter?.end();
    this.meter = null;
    this.wearCar = null;
    this.toggleTuning(false);
    this.vehicle.dispose();
    this.track.dispose();
    this.physics.dispose();
    this.rig.dispose();
    this.layer?.remove();
    this.disposeCamera();
  }
}
