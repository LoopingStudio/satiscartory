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
import { MEDAL_LABEL, MEDAL_ORDER, medalFor } from './medals';
import { BLUEPRINTS } from '../data/blueprints';
import { computeCarStats, statBars, type CarSpec } from '../car/stats';
import { LOANER_SPEC } from '../garage/assembly';
import type { RaceParams } from './RaceMode';

export interface TrackSelectParams {
  selected?: string;
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

  constructor(private readonly game: Game, private readonly state: GameState) {
    const { camera, dispose } = game.makeCamera(50, 1, 4000);
    this.camera = camera;
    this.disposeCamera = dispose;
  }

  enter(params?: TrackSelectParams): void {
    addLightRig(this.scene, { shadowSize: 120, sky: 0x9fc0f0, fog: [400, 1600] }).follow(new THREE.Vector3());
    this.tracks = TrackStore.all();
    this.layer = createLayer('tracks-screen');
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
    clear(list);
    list.appendChild(el('div', { class: 'row' }, el('h2', {}, 'Circuits'), el('span', { class: 'spacer' }), el('button', { class: 'small', onclick: () => void this.game.switchMode('menu') }, 'Menu')));
    const section = (title: string, items: TrackData[]) => {
      list.appendChild(el('h3', { style: 'margin-top:10px' }, title));
      if (!items.length) list.appendChild(el('div', { class: 'muted small' }, 'Aucun pour l’instant — crée-en un dans l’éditeur.'));
      for (const t of items) {
        const rec = this.state.records[t.id];
        const medal = medalFor(rec?.bestMs, t.medals);
        list.appendChild(
          el('button', { class: `track-row${t.id === this.selected?.id ? ' selected' : ''}`, onclick: () => this.select(t) },
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
    list.appendChild(el('button', { style: 'margin-top:10px', onclick: () => void this.game.switchMode('editor', {}) }, '+ Nouveau circuit'));
  }

  private carOptions(): { id: string | null; label: string; spec: CarSpec }[] {
    return [
      { id: null, label: BLUEPRINTS.loaner.name, spec: LOANER_SPEC },
      ...this.state.cars.map((c) => ({ id: c.id, label: c.name, spec: { blueprint: c.blueprint as CarSpec['blueprint'], parts: c.parts } })),
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
    const select = el('select', {
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        this.state.selectedCarId = v === '' ? null : v;
        this.renderDetail();
      },
    });
    for (const o of options) {
      const opt = el('option', { value: o.id ?? '' }, o.label);
      if ((o.id ?? null) === (this.state.selectedCar?.id ?? null)) opt.selected = true;
      select.appendChild(opt);
    }
    const current = options.find((o) => (o.id ?? null) === (this.state.selectedCar?.id ?? null)) ?? options[0]!;
    const bars = statBars(computeCarStats(current.spec));
    d.append(
      el('h3', { style: 'margin-top:12px' }, 'Voiture'),
      select,
      el('div', { class: 'stat-bars small' },
        ...(['speed', 'accel', 'grip', 'weight'] as const).map((k) =>
          el('div', { class: 'stat-bar' }, el('span', {}, { speed: 'Vitesse', accel: 'Accélération', grip: 'Adhérence', weight: 'Poids' }[k]), el('div', { class: 'bar' }, el('div', { style: `width:${bars[k] * 10}%` })))),
      ),
    );

    const buttons = el('div', { class: 'row', style: 'margin-top:12px;flex-wrap:wrap' });
    buttons.appendChild(
      el('button', {
        class: 'primary',
        disabled: !analysis.ok,
        onclick: () => {
          const p: RaceParams = { track: t };
          void this.game.switchMode('race', p);
        },
      }, analysis.ok ? 'Courir' : 'Circuit invalide'),
    );
    if (!t.builtin) {
      buttons.appendChild(el('button', { onclick: () => void this.game.switchMode('editor', { trackId: t.id }) }, 'Modifier'));
      buttons.appendChild(
        el('button', {
          class: 'danger',
          onclick: () => {
            if (!window.confirm(`Supprimer « ${t.name} » ?`)) return;
            TrackStore.remove(t.id);
            toast('Circuit supprimé', 'info');
            this.tracks = TrackStore.all();
            this.select(this.tracks[0] ?? null);
          },
        }, 'Supprimer'),
      );
    } else {
      buttons.appendChild(el('button', { onclick: () => void this.game.switchMode('editor', { copyOf: t.id }) }, 'Copier dans l’éditeur'));
    }
    buttons.appendChild(el('button', { onclick: () => void this.game.switchMode('garage') }, 'Garage'));
    d.appendChild(buttons);
  }

  fixedUpdate(): void {}

  update(dt: number): void {
    this.t += dt;
    const a = this.t * 0.12;
    this.camera.position.set(this.center.x + Math.cos(a) * this.radius, this.center.y + this.radius * 0.55, this.center.z + Math.sin(a) * this.radius);
    this.camera.lookAt(this.center);
    if (this.game.input.wasPressed('cancel')) void this.game.switchMode('menu');
  }

  debugState() {
    return { tracks: this.tracks.map((t) => t.id), selected: this.selected?.id ?? null };
  }

  exit(): void {
    this.built?.dispose();
    this.physics.dispose();
    this.layer?.remove();
    this.disposeCamera();
  }
}
