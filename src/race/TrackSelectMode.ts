import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Mode } from '../core/ModeManager';
import { addLightRig, type LightRig } from '../core/Renderer';
import { PhysicsWorld } from '../core/physics/PhysicsWorld';
import { GRAVITY_RACE } from '../config/constants';
import type { GameState } from '../state/GameState';
import { TrackStore } from '../state/TrackStore';
import { buildTrack, type BuiltTrack } from '../track/TrackBuilder';
import type { TrackData } from '../track/TrackData';
import { analyzeTrack } from '../track/validate';
import { clear, createLayer, el, formatTime, toast } from '../ui/dom';
import { confirmDialog } from '../ui/confirm';
import { dual, html, padGlyph } from '../ui/padHints';
import { MEDAL_LABEL, MEDAL_ORDER, medalFor } from './medals';
import { BLUEPRINTS } from '../data/blueprints';
import { worstWear } from '../data/wear';
import { LOANER_STATE, NEW_STATE, RACE_LOANER, blockText, blockedOption, blockedRaceLine, blockedRaceTip, effectsText, needAtGarage, needOf, stateText, wearTone } from '../data/wearText';
import { fuelGauge, fuelText } from '../ui/fuelGauge';
import { openTrackdayPanel, trackdayStatus } from '../ui/menus/TrackdayPanel';
import { challengeKey, challengeTrack, sanitizeChallenge, type Challenge } from './challenge';
import { decodeShare } from '../share/codec';
import { openImportPanel } from '../ui/menus/SharePanel';
import { SaveManager } from '../state/SaveManager';
import { satisfactionText } from '../data/trackday';
import { formatCredits } from '../data/sales';
import { fuelUsed, fuelTone } from '../data/fuel';
import { LOANER_SPEC, specOf, type CarInstance } from '../garage/assembly';
import { selectRaceCar } from '../garage/actions';
import { carStatsBlock } from '../ui/carStats';
import { wearGauge } from '../ui/wearGauge';
import { wearEffects } from '../car/wornTuning';
import type { CarSpec } from '../car/stats';
import type { EditorParams } from '../track/editor/TrackEditorMode';
import type { RaceParams } from './RaceMode';

/** Screen the track selection goes back to (Escape, back button), carried through races and the editor. */
export type TrackOrigin = 'menu' | 'factory';

export interface TrackSelectParams {
  selected?: string;
  /** A received challenge to show (its key, race/challenge.ts challengeKey). */
  challenge?: string;
  /** Opened from the factory (garage « Courir »): back goes to the factory. Default: the main menu. */
  origin?: TrackOrigin;
}

/** Track list with medals/records, car choice and a live 3D preview of the selected track. */
export class TrackSelectMode implements Mode {
  readonly name = 'tracks' as const;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private disposeCamera: () => void;
  private physics = new PhysicsWorld(GRAVITY_RACE);
  private built: BuiltTrack | null = null;
  private tracks: TrackData[] = [];
  private selected: TrackData | null = null;
  /** The received challenge shown (its circuit is `selected`). */
  private challenge: Challenge | null = null;
  private layer: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private t = 0;
  private center = new THREE.Vector3();
  private radius = 60;
  private origin: TrackOrigin = 'menu';
  /** The « Supprimer » dialog is open: a second click (Space on the button behind it) opens no other. */
  private confirming = false;
  private rig: LightRig | null = null;

  constructor(private readonly game: Game, private readonly state: GameState) {
    const { camera, dispose } = game.makeCamera(50, 1, 4000);
    this.camera = camera;
    this.disposeCamera = dispose;
  }

  enter(params?: TrackSelectParams): void {
    this.rig = addLightRig(this.scene, { shadowSize: 120, sky: 0x9fc0f0, fog: [400, 1600] });
    this.rig.follow(new THREE.Vector3());
    this.tracks = TrackStore.all();
    this.origin = params?.origin === 'factory' ? 'factory' : 'menu';
    this.layer = createLayer('tracks-screen');
    // Both panels are one pad menu. Every render rebuilds them: rows and buttons carry data-track-id /
    // data-action so the pad focus finds its control again.
    this.layer.setAttribute('data-pad-scope', '');
    this.listEl = el('div', { class: 'panel track-list' });
    this.detailEl = el('div', { class: 'panel track-detail' });
    this.layer.append(this.listEl, this.detailEl);
    const ch = params?.challenge ? this.state.challenges.find((c) => challengeKey(c) === params.challenge) : undefined;
    if (ch) return this.selectChallenge(ch);
    const initial = this.tracks.find((t) => t.id === params?.selected) ?? this.tracks[0] ?? null;
    this.select(initial);
  }

  /** Shows a received challenge: its circuit, who set what time with what car, « Relever le défi ». */
  private selectChallenge(c: Challenge): void {
    this.select(challengeTrack(c, this.tracks.filter((t) => t.builtin)), c);
  }

  /** « Importer un défi »: a code, a link or a file from a friend. */
  private importChallenge(): void {
    openImportPanel({
      title: 'Importer un défi',
      intro: 'Colle le code ou le lien qu’un ami t’a envoyé, ou ouvre son fichier.',
      onCode: async (code) => {
        const c = sanitizeChallenge(await decodeShare('defi', code));
        this.state.addChallenge(c);
        SaveManager.save(this.state);
        toast(`Défi de ${c.from} : ${c.track.name} en ${formatTime(c.timeMs)}`, 'success', 2600);
        this.selectChallenge(c);
      },
    });
  }

  private select(track: TrackData | null, challenge: Challenge | null = null): void {
    this.selected = track;
    this.challenge = challenge;
    this.built?.dispose();
    this.built = null;
    if (track) {
      this.physics.dispose();
      this.physics = new PhysicsWorld(GRAVITY_RACE);
      this.built = buildTrack(track, this.game.assets, this.physics.world);
      this.scene.add(this.built.root);
      const b = this.built.bounds;
      if (!b.isEmpty()) {
        b.getCenter(this.center);
        this.radius = Math.max(40, b.getSize(new THREE.Vector3()).length() * 0.75);
      }
    }
    this.renderList();
    this.renderDetail();
  }

  private renderList(): void {
    const list = this.listEl!;
    // Selecting a track re-renders the list: keep its scroll, then bring the selected row into view (LB/RB).
    const top = list.scrollTop;
    clear(list);
    const backBtn = el('button', { class: 'small', 'data-action': 'back', 'data-pad-btn': 'b', onclick: () => this.back() }, html(dual('', `${padGlyph('b')} `)), this.origin === 'factory' ? 'Usine' : 'Menu');
    list.appendChild(el('div', { class: 'row' }, el('h2', {}, 'Circuits'), el('span', { class: 'spacer' }), backBtn));
    list.appendChild(el('div', { class: 'muted small pad-only' }, html(`${padGlyph('lb')} ${padGlyph('rb')} circuit précédent / suivant`)));
    const section = (title: string, items: TrackData[]) => {
      list.appendChild(el('h3', { style: 'margin-top:10px' }, title));
      if (!items.length) list.appendChild(el('div', { class: 'muted small' }, 'Aucun pour l’instant — crée-en un dans l’éditeur.'));
      for (const t of items) {
        const rec = this.state.records[t.id];
        const medal = medalFor(rec?.bestMs, t.medals);
        list.appendChild(
          // Rows are pad tabs: LB/RB click the previous/next one (in list order, the selected one is current).
          el('button', { class: `track-row${t.id === this.selected?.id && !this.challenge ? ' selected' : ''}`, 'data-track-id': t.id, 'data-pad-tab': '', onclick: () => this.select(t) },
            el('span', { class: `medal ${medal ? `medal-${medal}` : 'medal-none'}` }),
            el('span', { class: 'track-name' }, t.name),
            el('span', { class: 'spacer' }),
            el('span', { class: 'mono small' }, formatTime(rec?.bestMs)),
          ),
        );
      }
    };
    section('Officiels', this.tracks.filter((t) => t.builtin));
    section('Mes circuits', this.tracks.filter((t) => !t.builtin));
    list.appendChild(el('button', { style: 'margin-top:10px', 'data-action': 'new', onclick: () => this.openEditor({}) }, '+ Nouveau circuit'));
    // Challenges received from friends: race their ghost.
    list.appendChild(el('h3', { style: 'margin-top:14px' }, 'Défis reçus'));
    if (!this.state.challenges.length) list.appendChild(el('div', { class: 'muted small' }, 'Aucun : à l’arrivée d’une course, « Défier un ami » crée un défi à envoyer.'));
    for (const c of this.state.challenges) {
      const key = challengeKey(c);
      const current = !!this.challenge && challengeKey(this.challenge) === key;
      list.appendChild(
        el('button', { class: `track-row${current ? ' selected' : ''}`, 'data-challenge': key, 'data-pad-tab': '', onclick: () => this.selectChallenge(c) },
          el('span', { class: 'medal medal-none' }),
          el('span', { class: 'track-name' }, `${c.from} · ${c.track.name}`),
          el('span', { class: 'spacer' }),
          el('span', { class: 'mono small' }, formatTime(c.timeMs)),
        ),
      );
    }
    list.appendChild(el('button', { style: 'margin-top:8px', 'data-action': 'import-challenge', onclick: () => this.importChallenge() }, 'Importer un défi…'));
    list.scrollTop = top;
    list.querySelector('.track-row.selected')?.scrollIntoView({ block: 'nearest' });
  }

  /** The loaner, then the player's cars; a car past the race limit is labelled « (à réparer) ». */
  private carOptions(): { id: string | null; label: string; spec: CarSpec; car: CarInstance | null }[] {
    return [
      { id: null, label: BLUEPRINTS.loaner.name, spec: LOANER_SPEC, car: null },
      ...this.state.cars.map((c) => {
        const need = needOf(c);
        const label = this.state.isAway(c.id) ? `${c.name} (au trackday)` : need ? blockedOption(c.name, need) : c.name;
        return { id: c.id, label, spec: specOf(c), car: c };
      }),
    ];
  }

  /**
   * The chosen car's state under its stats: « État : roues 46 % » with a mini gauge and the effects of its wear,
   * « État : neuve », or the loaner's « Prêté par le circuit : il ne s’use pas. ».
   */
  private wearSummary(car: CarInstance | null): HTMLElement {
    if (!car) return el('div', { class: 'muted wear-summary' }, LOANER_STATE);
    const state = stateText(car);
    const fuel = fuelText(car);
    const used = fuelUsed(car);
    const fuelRow = fuel
      ? el('div', { class: 'row wear-summary' }, el('b', { class: fuelTone(used) === 'good' ? '' : fuelTone(used) }, fuel), fuelGauge(used, 'mini'))
      : null;
    if (!state) return el('div', {}, el('div', { class: 'muted wear-summary' }, NEW_STATE), fuelRow);
    const w = worstWear(car);
    const effects = effectsText(wearEffects(specOf(car), car.wear));
    return el('div', {},
      el('div', { class: 'row wear-summary' },
        el('span', { class: 'muted' }, 'État : '), el('b', { class: wearTone(w) }, state), wearGauge(w, 'mini', `État : ${state}`)),
      effects ? el('div', { class: 'muted small' }, `Effets de l’usure : ${effects}`) : null,
      fuelRow,
    );
  }

  private renderDetail(): void {
    const d = this.detailEl!;
    clear(d);
    const t = this.selected;
    if (!t) {
      d.appendChild(el('div', { class: 'muted' }, 'Aucun circuit.'));
      return;
    }
    const rec = this.state.records[t.id];
    const analysis = analyzeTrack(t);
    d.append(el('h2', {}, t.name), el('div', { class: 'muted small' }, `par ${t.author} · ${t.pieces.length} pièces · ${analysis.checkpoints.length} checkpoint(s)`));
    const ch = this.challenge;
    if (ch) {
      const date = ch.at ? new Date(ch.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : '';
      d.appendChild(
        el('div', { class: 'challenge-card' },
          el('b', {}, `Défi de ${ch.from}`),
          el('div', {}, 'Temps à battre : ', el('b', { class: 'mono' }, formatTime(ch.timeMs)), ` avec ${ch.carName}${date ? ` (${date})` : ''}`),
          el('div', { class: 'muted small' }, 'Son fantôme court avec toi. À l’arrivée, tu peux lui renvoyer le défi.'),
          el('button', { class: 'small danger', style: 'margin-top:6px', 'data-action': 'delete-challenge', onclick: () => {
            this.state.removeChallenge(challengeKey(ch));
            SaveManager.save(this.state);
            this.select(this.tracks[0] ?? null);
          } }, 'Supprimer le défi'),
        ),
      );
    }
    if (t.medals) {
      const best = medalFor(rec?.bestMs, t.medals);
      const grid = el('div', { class: 'medal-list' });
      for (const m of MEDAL_ORDER) {
        const got = best !== null && MEDAL_ORDER.indexOf(best) <= MEDAL_ORDER.indexOf(m);
        grid.appendChild(el('div', { class: `medal-row${got ? ' got' : ''}` }, el('span', { class: `medal medal-${m}` }), el('span', {}, MEDAL_LABEL[m]), el('span', { class: 'spacer' }), el('span', { class: 'mono' }, formatTime(t.medals[m]))));
      }
      d.appendChild(grid);
    } else {
      d.appendChild(el('div', { class: 'muted small' }, 'Pas encore de médailles : termine un essai dans l’éditeur pour fixer le temps auteur.'));
    }
    d.appendChild(el('div', { style: 'margin-top:8px' }, `Ton record : `, el('b', { class: 'mono' }, formatTime(rec?.bestMs)), rec ? el('span', { class: 'muted small' }, ` · ${rec.attempts} essai(s)`) : null));

    // Car choice
    const options = this.carOptions();
    // The pad changes the car with left/right (PadNav dispatches 'change').
    const select = el('select', {
      'data-action': 'car',
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        selectRaceCar(this.state, v === '' ? null : v);
        this.renderDetail();
      },
    });
    for (const o of options) {
      const opt = el('option', { value: o.id ?? '' }, o.label);
      if ((o.id ?? null) === (this.state.selectedCar?.id ?? null)) opt.selected = true;
      select.appendChild(opt);
    }
    const current = options.find((o) => (o.id ?? null) === (this.state.selectedCar?.id ?? null)) ?? options[0]!;
    d.append(el('h3', { style: 'margin-top:12px' }, 'Voiture'), select, carStatsBlock(current.spec, null, 'small'), this.wearSummary(current.car));

    // A car to repair does not start: « Courir » is disabled, the loaner takes the default focus. It stays the race
    // car (selectedCarId): once repaired, it races again.
    const away = !!current.car && this.state.isAway(current.car.id);
    const blocked = current.car ? (away ? 'elle est au trackday' : blockText(current.car)) : null;
    const need = (current.car && needOf(current.car)) || 'repair';
    const blockedTip = analysis.ok && blocked !== null ? blockedRaceTip(blocked, need) : undefined;
    const race = (carId: string | null) => {
      const back: TrackSelectParams = { selected: t.id, origin: this.origin, ...(ch ? { challenge: challengeKey(ch) } : {}) };
      const p: RaceParams = { track: t, carId, returnTo: 'tracks', returnParams: back, ...(ch ? { challenge: ch } : {}) };
      void this.game.switchMode('race', p);
    };
    if (current.car && blocked !== null) d.appendChild(el('div', { class: 'bad small', style: 'margin-top:8px' }, away ? `${current.car.name} est au trackday : elle revient à la fin de la journée.` : blockedRaceLine(current.car.name, blocked, need)));
    const buttons = el('div', { class: 'row', style: 'margin-top:12px;flex-wrap:wrap' });
    buttons.appendChild(
      el('button', {
        class: 'primary',
        disabled: !analysis.ok || blocked !== null,
        title: blockedTip,
        'data-pad-tip': blockedTip,
        'data-action': 'race',
        'data-pad-default': blocked === null,
        onclick: () => race(this.state.selectedCar?.id ?? null),
      }, !analysis.ok ? 'Circuit invalide' : blocked !== null ? (away ? 'Au trackday' : needAtGarage(need)) : ch ? 'Relever le défi' : 'Courir'),
    );
    if (blocked !== null) {
      buttons.appendChild(
        el('button', {
          class: 'primary',
          disabled: !analysis.ok,
          title: analysis.ok ? undefined : 'Circuit invalide',
          'data-pad-tip': analysis.ok ? undefined : 'Circuit invalide',
          'data-action': 'race-loaner',
          'data-pad-default': true,
          onclick: () => race(null),
        }, RACE_LOANER),
      );
    }
    if (ch) {
      // A friend's circuit is raced as it came: not editable, not the player's to delete (« Supprimer le défi » above).
    } else if (!t.builtin) {
      buttons.appendChild(el('button', { 'data-action': 'edit', onclick: () => this.openEditor({ trackId: t.id }) }, 'Modifier'));
      buttons.appendChild(el('button', { class: 'danger', 'data-action': 'delete', onclick: () => void this.remove(t) }, 'Supprimer'));
    } else {
      buttons.appendChild(el('button', { 'data-action': 'copy', onclick: () => this.openEditor({ copyOf: t.id }) }, 'Copier dans l’éditeur'));
    }
    // Trackday: lend the player's cars to guests on this circuit (one at a time).
    const running = this.state.trackday;
    if (!ch) buttons.appendChild(
      el('button', {
        'data-action': 'trackday',
        disabled: !!running || !analysis.ok || !this.state.cars.length,
        title: running ? 'Un trackday est déjà en cours' : !this.state.cars.length ? 'Construis d’abord une voiture au garage' : 'Prête tes voitures à des clients pour la journée',
        onclick: () => openTrackdayPanel(this.state, t, { onStarted: () => this.renderDetail() }),
      }, 'Organiser un trackday'),
    );
    // From the factory, the back button of the list already says « Usine ».
    if (this.origin !== 'factory') buttons.appendChild(el('button', { 'data-action': 'factory', onclick: () => void this.game.switchMode('factory') }, 'Usine'));
    d.appendChild(buttons);
    d.appendChild(this.trackdayEl);
    this.trackdayEl.textContent = trackdayStatus(this.state) ?? '';
    const last = this.state.trackdayLog[0];
    if (!running && last) {
      d.appendChild(el('div', { class: 'muted small', style: 'margin-top:6px' },
        `Dernier trackday (${last.trackName}) : ${last.guests} client${last.guests > 1 ? 's' : ''} ${satisfactionText(last.satisfaction)}, +${formatCredits(last.revenue)}, réputation ${last.reputation}/100`));
    }
  }

  /** The running trackday's status line (its clock ticks in update()). */
  private readonly trackdayEl = el('div', { class: 'good small', style: 'margin-top:8px' });

  /** Deletes a custom track once confirmed (in-page dialog: a pad can answer it, the game keeps running). */
  private async remove(t: TrackData): Promise<void> {
    if (this.confirming) return;
    this.confirming = true;
    const ok = await confirmDialog({ message: `Supprimer « ${t.name} » ?`, confirm: 'Supprimer', danger: true });
    this.confirming = false;
    // The mode may have exited while the dialog was open.
    if (!ok || !this.layer?.isConnected) return;
    TrackStore.remove(t.id);
    toast('Circuit supprimé', 'info');
    this.tracks = TrackStore.all();
    this.select(this.tracks[0] ?? null);
  }

  private openEditor(params: EditorParams): void {
    void this.game.switchMode('editor', { ...params, origin: this.origin } satisfies EditorParams);
  }

  private back(): void {
    void this.game.switchMode(this.origin);
  }

  fixedUpdate(): void {}

  update(dt: number): void {
    this.t += dt;
    // The trackday's clock; once it is over, the cars are back (re-render: they race again).
    const status = trackdayStatus(this.state) ?? '';
    if (this.trackdayEl.textContent !== status) {
      const ended = status === '' && this.trackdayEl.textContent !== '';
      this.trackdayEl.textContent = status;
      if (ended) this.renderDetail();
    }
    const a = this.t * 0.12;
    this.camera.position.set(this.center.x + Math.cos(a) * this.radius, this.center.y + this.radius * 0.55, this.center.z + Math.sin(a) * this.radius);
    this.camera.lookAt(this.center);
    if (this.game.input.wasPressed('cancel')) this.back();
  }

  debugState() {
    return { tracks: this.tracks.map((t) => t.id), selected: this.selected?.id ?? null, origin: this.origin };
  }

  exit(): void {
    this.built?.dispose();
    this.physics.dispose();
    this.rig?.dispose();
    this.layer?.remove();
    this.disposeCamera();
  }
}
