import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Mode } from '../core/ModeManager';
import { addLightRig } from '../core/Renderer';
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
import { LOANER_SPEC, specOf } from '../garage/assembly';
import { selectRaceCar } from '../garage/actions';
import { carStatsBlock } from '../ui/carStats';
import type { CarSpec } from '../car/stats';
import type { EditorParams } from '../track/editor/TrackEditorMode';
import type { RaceParams } from './RaceMode';

/** Screen the track selection goes back to (Escape, back button), carried through races and the editor. */
export type TrackOrigin = 'menu' | 'factory';

export interface TrackSelectParams {
  selected?: string;
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
  private layer: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private detailEl: HTMLElement | null = null;
  private t = 0;
  private center = new THREE.Vector3();
  private radius = 60;
  private origin: TrackOrigin = 'menu';
  /** The « Supprimer » dialog is open: a second click (Space on the button behind it) opens no other. */
  private confirming = false;

  constructor(private readonly game: Game, private readonly state: GameState) {
    const { camera, dispose } = game.makeCamera(50, 1, 4000);
    this.camera = camera;
    this.disposeCamera = dispose;
  }

  enter(params?: TrackSelectParams): void {
    addLightRig(this.scene, { shadowSize: 120, sky: 0x9fc0f0, fog: [400, 1600] }).follow(new THREE.Vector3());
    this.tracks = TrackStore.all();
    this.origin = params?.origin === 'factory' ? 'factory' : 'menu';
    this.layer = createLayer('tracks-screen');
    // Both panels are one pad menu. Every render rebuilds them: rows and buttons carry data-track-id /
    // data-action so the pad focus finds its control again.
    this.layer.setAttribute('data-pad-scope', '');
    this.listEl = el('div', { class: 'panel track-list' });
    this.detailEl = el('div', { class: 'panel track-detail' });
    this.layer.append(this.listEl, this.detailEl);
    const initial = this.tracks.find((t) => t.id === params?.selected) ?? this.tracks[0] ?? null;
    this.select(initial);
  }

  private select(track: TrackData | null): void {
    this.selected = track;
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
          el('button', { class: `track-row${t.id === this.selected?.id ? ' selected' : ''}`, 'data-track-id': t.id, 'data-pad-tab': '', onclick: () => this.select(t) },
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
    list.scrollTop = top;
    list.querySelector('.track-row.selected')?.scrollIntoView({ block: 'nearest' });
  }

  private carOptions(): { id: string | null; label: string; spec: CarSpec }[] {
    return [
      { id: null, label: BLUEPRINTS.loaner.name, spec: LOANER_SPEC },
      ...this.state.cars.map((c) => ({ id: c.id, label: c.name, spec: specOf(c) })),
    ];
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
    d.append(el('h3', { style: 'margin-top:12px' }, 'Voiture'), select, carStatsBlock(current.spec, null, 'small'));

    const buttons = el('div', { class: 'row', style: 'margin-top:12px;flex-wrap:wrap' });
    buttons.appendChild(
      el('button', {
        class: 'primary',
        disabled: !analysis.ok,
        'data-action': 'race',
        'data-pad-default': true,
        onclick: () => {
          const back: TrackSelectParams = { selected: t.id, origin: this.origin };
          const p: RaceParams = { track: t, carId: this.state.selectedCar?.id ?? null, returnTo: 'tracks', returnParams: back };
          void this.game.switchMode('race', p);
        },
      }, analysis.ok ? 'Courir' : 'Circuit invalide'),
    );
    if (!t.builtin) {
      buttons.appendChild(el('button', { 'data-action': 'edit', onclick: () => this.openEditor({ trackId: t.id }) }, 'Modifier'));
      buttons.appendChild(el('button', { class: 'danger', 'data-action': 'delete', onclick: () => void this.remove(t) }, 'Supprimer'));
    } else {
      buttons.appendChild(el('button', { 'data-action': 'copy', onclick: () => this.openEditor({ copyOf: t.id }) }, 'Copier dans l’éditeur'));
    }
    // From the factory, the back button of the list already says « Usine ».
    if (this.origin !== 'factory') buttons.appendChild(el('button', { 'data-action': 'factory', onclick: () => void this.game.switchMode('factory') }, 'Usine'));
    d.appendChild(buttons);
  }

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
    this.layer?.remove();
    this.disposeCamera();
  }
}
