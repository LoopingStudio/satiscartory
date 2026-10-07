import * as THREE from 'three';
import type { Game } from '../../core/Game';
import type { Mode } from '../../core/ModeManager';
import { addLightRig, type LightRig } from '../../core/Renderer';
import { LEVEL_H, TRACK_CELL } from '../../config/constants';
import type { Action } from '../../config/keybinds';
import { NavRepeat, stickCurve } from '../../core/gamepad';
import { TRACK_PIECES, type PieceDef } from '../../data/trackPieces';
import { DX, DZ, type Rot } from '../../factory/sim/dirs';
import type { GameState } from '../../state/GameState';
import { TrackStore } from '../../state/TrackStore';
import { confirmDialog } from '../../ui/confirm';
import { clear, createLayer, el, formatTime, toast } from '../../ui/dom';
import { dual, html, keyCap, keyLabel, padGlyph, padLabel } from '../../ui/padHints';
import { pieceCells, pieceConnectors, edgeKey } from '../connectors';
import { History, MAX_LEVEL, inBounds, overlapping, pieceAt, placePiece, removeAt } from '../editing';
import { SaveManager } from '../../state/SaveManager';
import { pieceMatrix } from '../layout';
import { buildTrack, type BuiltTrack } from '../TrackBuilder';
import { emptyTrack, type TrackData, type TrackPiece } from '../TrackData';
import { analyzeTrack, type TrackAnalysis } from '../validate';
import { medalsFromAuthor } from '../../race/medals';
import type { RaceParams } from '../../race/RaceMode';
import type { TrackOrigin, TrackSelectParams } from '../../race/TrackSelectMode';

export interface EditorParams {
  trackId?: string;
  copyOf?: string;
  /** Working copy coming back from a test drive. */
  track?: TrackData;
  /** Unsaved-changes flag carried through a test drive. */
  dirty?: boolean;
  /** Where the track selection goes back to when leaving the editor (carried through test drives). */
  origin?: TrackOrigin;
}

type Tool = { kind: 'piece'; id: string } | { kind: 'erase' };

const CATEGORIES: PieceDef['category'][] = ['spécial', 'route', 'virage', 'pente'];
/** Palette order (as rendered), then the eraser: what the pad's ◀ ▶ step through. */
const TOOL_ORDER: Tool[] = [
  ...CATEGORIES.flatMap((cat) => Object.values(TRACK_PIECES).filter((d) => d.palette && d.category === cat).map((d): Tool => ({ kind: 'piece', id: d.id }))),
  { kind: 'erase' },
];
const toolKey = (t: Tool) => (t.kind === 'erase' ? 'erase' : t.id);
// Camera limits (shared by the mouse and the pad).
const PITCH_MIN = 0.25;
const PITCH_MAX = 1.45;
const DIST_MIN = 25;
const DIST_MAX = 600;
/** Right stick at full tilt (rad/s, times the pad sensitivity setting). */
const PAD_YAW_RATE = 2.2;
const PAD_PITCH_RATE = 1.4;
/** Full trigger zooms by a factor e^rate per second. */
const PAD_ZOOM_RATE = 1.4;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ghostOk = new THREE.MeshStandardMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.55, depthWrite: false });
const ghostReplace = new THREE.MeshStandardMaterial({ color: 0xffb347, transparent: true, opacity: 0.55, depthWrite: false });
const ghostBad = new THREE.MeshStandardMaterial({ color: 0xff5d5d, transparent: true, opacity: 0.5, depthWrite: false });
const openMat = new THREE.MeshBasicMaterial({ color: 0xffa31a });
const errorMat = new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.35, depthWrite: false });
const arrowGeo = new THREE.ConeGeometry(0.9, 2.2, 10).rotateX(Math.PI / 2);

/**
 * Saves a user track. When its layout differs from the stored version, the old
 * personal best no longer applies (like a new map UID in Trackmania): drop it.
 */
function persistTrack(track: TrackData, state: GameState): void {
  const stored = TrackStore.get(track.id);
  if (stored && JSON.stringify(stored.pieces) !== JSON.stringify(track.pieces) && state.records[track.id]) {
    delete state.records[track.id];
    SaveManager.save(state);
  }
  TrackStore.save(track);
}

/** Trackmania-style tile editor. */
export class TrackEditorMode implements Mode {
  readonly name = 'editor' as const;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private disposeCamera: () => void;
  private track!: TrackData;
  private analysis!: TrackAnalysis;
  private built: BuiltTrack | null = null;
  private tool: Tool = { kind: 'piece', id: 'straight' };
  private rot: Rot = 0;
  private level = 0;
  private hover: [number, number] | null = null;
  private ghost: THREE.Object3D | null = null;
  private ghostKey = '';
  private markers = new THREE.Group();
  private errors = new THREE.Group();
  private grid!: THREE.GridHelper;
  private history = new History();
  private rig!: LightRig;
  private dirty = false;
  private origin: TrackOrigin | undefined;
  /** The « quit without saving » dialog is open: the editor ignores its input until it closes. */
  private confirming = false;
  /** Held D-pad ◀ ▶ keeps stepping through the palette. */
  private readonly toolRepeat = new NavRepeat();
  // camera
  private target = new THREE.Vector3(48, 0, 24);
  private yaw = Math.PI * 0.75;
  private pitch = 0.95;
  private dist = 95;
  private rmbMoved = 0;
  // ui
  private layer: HTMLElement | null = null;
  private palette!: HTMLElement;
  private status!: HTMLElement;
  private nameInput!: HTMLInputElement;
  private levelEl!: HTMLElement;
  private readonly raycaster = new THREE.Raycaster();

  constructor(private readonly game: Game, private readonly state: GameState) {
    const { camera, dispose } = game.makeCamera(50, 1, 5000);
    this.camera = camera;
    this.disposeCamera = dispose;
  }

  enter(params?: EditorParams): void {
    this.origin = params?.origin;
    if (params?.track) {
      this.track = params.track;
      this.dirty = params.dirty ?? true;
    }
    else if (params?.trackId) this.track = TrackStore.get(params.trackId) ?? this.newTrack();
    else if (params?.copyOf) {
      const src = TrackStore.get(params.copyOf);
      this.track = src ? { ...src, id: TrackStore.newId(), name: `${src.name} (copie)`, author: 'Moi', builtin: undefined, medals: null, pieces: src.pieces.map((p) => ({ ...p })) } : this.newTrack();
      this.dirty = true;
    } else this.track = this.newTrack();

    this.rig = addLightRig(this.scene, { shadowSize: 160, sky: 0x9fc0f0 });
    this.grid = new THREE.GridHelper(TRACK_CELL * 96, 96, 0xffb347, 0x7f86b8);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.35;
    this.scene.add(this.grid, this.markers, this.errors);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0x6b7a5a, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.buildUi();
    this.rebuild(true);
    this.game.renderer.canvas.addEventListener('contextmenu', this.prevent);
    window.addEventListener('keydown', this.onKey);
  }

  private newTrack(): TrackData {
    const t = emptyTrack(TrackStore.newId(), 'Mon circuit');
    t.pieces.push({ t: 'start', x: 0, z: 0, y: 0, r: 0 });
    this.dirty = true;
    return t;
  }

  private prevent = (e: Event) => e.preventDefault();

  /** Shortcuts that depend on the typed character (Ctrl+Z / Ctrl+S work on every layout). */
  private onKey = (e: KeyboardEvent) => {
    if (this.confirming || (e.target as HTMLElement)?.tagName === 'INPUT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      this.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.save();
    }
  };

  // ------------------------------------------------------------------ model

  private apply(next: TrackData): void {
    if (next === this.track) return;
    this.history.push(this.track);
    this.track = next;
    this.dirty = true;
    this.rebuild(false);
  }

  private undo(): void {
    const prev = this.history.undo(this.track);
    if (prev) {
      this.track = prev;
      this.dirty = true;
      this.rebuild(false);
    }
  }

  private rebuild(frame: boolean): void {
    this.built?.dispose();
    this.built = buildTrack(this.track, this.game.assets, null, { ground: false });
    this.scene.add(this.built.root);
    this.analysis = analyzeTrack(this.track);
    this.rebuildMarkers();
    this.renderStatus();
    if (frame && !this.built.bounds.isEmpty()) this.built.bounds.getCenter(this.target).setY(0);
  }

  /** Arrows on open connectors + red boxes on pieces with errors. */
  private rebuildMarkers(): void {
    this.markers.clear();
    this.errors.clear();
    const all = this.track.pieces.flatMap((p, i) => pieceConnectors(p, i));
    const count = new Map<string, number>();
    for (const c of all) count.set(edgeKey(c.cx, c.cz, c.side, c.level), (count.get(edgeKey(c.cx, c.cz, c.side, c.level)) ?? 0) + 1);
    for (const c of all) {
      if ((count.get(edgeKey(c.cx, c.cz, c.side, c.level)) ?? 0) > 1) continue;
      const a = new THREE.Mesh(arrowGeo, openMat);
      a.position.set((c.cx + 0.5 + DX[c.side] * 0.5) * TRACK_CELL, c.level * LEVEL_H + 1.5, (c.cz + 0.5 + DZ[c.side] * 0.5) * TRACK_CELL);
      a.rotation.y = Math.atan2(DX[c.side], DZ[c.side]);
      this.markers.add(a);
    }
    const bad = new Set(this.analysis.issues.filter((i) => i.level === 'error').flatMap((i) => i.pieces));
    for (const i of bad) {
      const p = this.track.pieces[i];
      if (!p) continue;
      for (const [x, z] of pieceCells(p)) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(TRACK_CELL, 3, TRACK_CELL), errorMat);
        b.position.set((x + 0.5) * TRACK_CELL, p.y * LEVEL_H + 1.5, (z + 0.5) * TRACK_CELL);
        this.errors.add(b);
      }
    }
  }

  private save(): void {
    this.track.name = this.nameInput.value.trim() || 'Mon circuit';
    persistTrack(this.track, this.state);
    this.dirty = false;
    toast('Circuit enregistré', 'success');
    this.renderStatus();
  }

  private testDrive(): void {
    if (!this.analysis.ok) {
      toast('Corrige les erreurs avant de tester', 'error');
      return;
    }
    this.track.name = this.nameInput.value.trim() || 'Mon circuit';
    const working = this.track;
    const back: EditorParams = { track: working, dirty: this.dirty, origin: this.origin };
    const params: RaceParams = {
      track: working,
      test: true,
      returnTo: 'editor',
      returnParams: back,
      onTestFinish: (ms) => {
        // The author validation run sets the medals (keeps the best author time) and saves the track.
        if (!working.medals || ms < working.medals.author) working.medals = medalsFromAuthor(ms);
        persistTrack(working, this.state);
        back.dirty = false;
      },
    };
    void this.game.switchMode('race', params);
  }

  // ------------------------------------------------------------------ UI

  private buildUi(): void {
    this.layer = createLayer('editor-ui');
    this.nameInput = el('input', { type: 'text', value: this.track.name, maxlength: 40, class: 'interactive' }) as HTMLInputElement;
    this.nameInput.addEventListener('input', () => {
      this.track.name = this.nameInput.value;
      this.dirty = true;
    });
    this.levelEl = el('span', { class: 'mono' });
    // The editor is not a pad menu (the pad drives it directly): its buttons show their pad shortcut instead.
    const padHint = (action: Action) => html(`<span class="pad-only" style="margin-left:6px">${padLabel(action, 'editor')}</span>`);
    const top = el('div', { class: 'panel editor-top' },
      el('b', {}, 'Éditeur'), this.nameInput,
      el('button', { class: 'small', onclick: () => this.save() }, 'Enregistrer', padHint('save')),
      el('button', { class: 'small primary', onclick: () => this.testDrive() }, 'Tester', padHint('test')),
      el('button', { class: 'small', onclick: () => this.undo(), title: 'Ctrl+Z' }, 'Annuler', padHint('undo')),
      el('button', { class: 'small', onclick: () => navigator.clipboard?.writeText(JSON.stringify(this.track)).then(() => toast('JSON copié', 'info')) }, 'Copier JSON'),
      el('button', { class: 'small', onclick: () => this.leave() }, 'Circuits', padHint('cancel')),
    );
    this.palette = el('div', { class: 'panel editor-palette' });
    this.status = el('div', { class: 'panel editor-status' });
    const pad = (a: Action) => padLabel(a, 'editor');
    const kbmHelp = `Clic gauche : poser · ${keyLabel('rotate')} tourner · ${keyCap('Pg↑/Pg↓')} niveau · ${keyLabel('delete')} / clic droit : effacer · `
      + `${keyCap('ZQSD')} déplacer · clic droit glissé : pivoter · molette : zoom · ${keyLabel('save')} enregistrer`;
    const padHelp = `${pad('primary')} poser · ${pad('rotateBack')}/${pad('rotate')} tourner · ${pad('prevTool')}/${pad('nextTool')} pièce · `
      + `${pad('levelUp')}/${pad('levelDown')} niveau · ${pad('delete')} effacer · ${padGlyph('ls')} déplacer · ${padGlyph('rs')} pivoter · ${padGlyph('lt')}/${padGlyph('rt')} zoom`;
    const help = el('div', { class: 'editor-help muted small' }, html(dual(kbmHelp, padHelp)), ' · Niveau ', this.levelEl);
    // Pad aim: the cell under the screen center (the hovered cell follows it while the pad is in use).
    const reticle = el('div', {
      class: 'pad-only',
      style: 'position:absolute;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;pointer-events:none;'
        + 'border:2px solid rgba(255,255,255,0.9);box-shadow:0 0 0 1px rgba(0,0,0,0.45),inset 0 0 0 1px rgba(0,0,0,0.45);'
        + 'background:radial-gradient(circle,#fff 0 2px,transparent 2.5px)',
    });
    this.layer.append(top, this.palette, this.status, help, reticle);
    this.renderPalette();
  }

  private renderPalette(): void {
    clear(this.palette);
    for (const cat of CATEGORIES) {
      this.palette.appendChild(el('h3', {}, cat));
      const grid = el('div', { class: 'palette-grid' });
      for (const def of Object.values(TRACK_PIECES)) {
        if (!def.palette || def.category !== cat) continue;
        const active = this.tool.kind === 'piece' && this.tool.id === def.id;
        grid.appendChild(el('button', { class: `small piece-btn${active ? ' selected' : ''}`, 'data-piece': def.id, onclick: () => { this.tool = { kind: 'piece', id: def.id }; this.renderPalette(); } }, def.name));
      }
      this.palette.appendChild(grid);
    }
    const erase = this.tool.kind === 'erase';
    this.palette.appendChild(el('button', { class: `small${erase ? ' selected danger' : ''}`, style: 'margin-top:8px', onclick: () => { this.tool = { kind: 'erase' }; this.renderPalette(); } }, 'Gomme'));
  }

  /** Next or previous palette tool (pad ◀ ▶, wrapping, eraser included); the palette keeps it in view. */
  private stepTool(dir: 1 | -1): void {
    const n = TOOL_ORDER.length;
    const i = TOOL_ORDER.findIndex((t) => toolKey(t) === toolKey(this.tool));
    this.tool = TOOL_ORDER[i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n]!;
    this.renderPalette();
    this.palette.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }

  private renderStatus(): void {
    if (!this.status) return;
    clear(this.status);
    const a = this.analysis;
    this.status.appendChild(el('div', { class: a.ok ? 'good' : 'bad' }, a.ok ? '✔ Circuit valide' : '✖ Circuit incomplet'));
    for (const i of a.issues) this.status.appendChild(el('div', { class: `small ${i.level === 'error' ? 'bad' : 'muted'}` }, `• ${i.message}`));
    this.status.appendChild(el('div', { class: 'small muted', style: 'margin-top:6px' }, `${this.track.pieces.length} pièces · ${a.checkpoints.length} CP`));
    const m = this.track.medals;
    this.status.appendChild(
      el('div', { class: 'small', style: 'margin-top:4px' }, m ? `Temps auteur : ${formatTime(m.author)}` : a.ok ? 'Non validé : termine un essai (Tester) pour fixer les médailles.' : ''),
    );
    if (this.dirty) this.status.appendChild(el('div', { class: 'small muted' }, 'Modifications non enregistrées'));
    if (this.levelEl) this.levelEl.textContent = String(this.level);
  }

  private leave(): void {
    if (this.confirming) return;
    if (!this.dirty || this.track.pieces.length <= 1) return this.goToTracks();
    // In-page dialog (window.confirm freezes the loop and a pad cannot answer it).
    this.confirming = true;
    void confirmDialog({ message: 'Quitter sans enregistrer ?', confirm: 'Quitter', danger: true }).then((ok) => {
      this.confirming = false;
      // Modes are created fresh on each switch: only leave if this editor is still the one running.
      if (ok && this.game.modes.current === this) this.goToTracks();
    });
  }

  private goToTracks(): void {
    void this.game.switchMode('tracks', { selected: this.track.id, origin: this.origin } satisfies TrackSelectParams);
  }

  // ------------------------------------------------------------------ frame

  fixedUpdate(): void {}

  private currentPiece(): TrackPiece | null {
    if (!this.hover || this.tool.kind !== 'piece') return null;
    return { t: this.tool.id, x: this.hover[0], z: this.hover[1], y: this.level, r: this.rot };
  }

  /** Left click / pad A on the hovered cell: place the current piece, or erase with the eraser. */
  private primary(): void {
    if (!this.hover) return;
    if (this.tool.kind === 'erase') this.apply(removeAt(this.track, this.hover[0], this.hover[1]));
    else {
      const p = this.currentPiece();
      if (p) this.apply(placePiece(this.track, p));
    }
  }

  update(dt: number): void {
    const input = this.game.input;
    input.padProfile = 'editor';
    // The dialog owns the keys and the pad (PadNav) until it closes.
    if (this.confirming) return;
    const typing = document.activeElement === this.nameInput;
    // A pad cannot type: while the name field has focus, only its presses count.
    const pressed = (a: Action) => input.wasPressed(a) && (!typing || input.padHas(a));

    // Camera: pan with ZQSD/WASD or the left stick, rotate with right-drag or the right stick, zoom with the
    // wheel or the triggers.
    const ls = input.padStick('left');
    const f = clamp((typing ? 0 : input.axis('back', 'forward')) - ls.y, -1, 1);
    const r = clamp((typing ? 0 : input.axis('left', 'right')) + ls.x, -1, 1);
    const speed = this.dist * 0.9 * dt;
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    // forward = (fx, fz), screen-right = (-fz, fx)
    this.target.x += (fx * f - fz * r) * speed;
    this.target.z += (fz * f + fx * r) * speed;
    if (input.isButtonDown(2)) {
      this.yaw -= input.mouseDX * 0.005;
      this.pitch = clamp(this.pitch + input.mouseDY * 0.004, PITCH_MIN, PITCH_MAX);
      this.rmbMoved += Math.abs(input.mouseDX) + Math.abs(input.mouseDY);
    }
    const rs = input.padStick('right');
    if (rs.x || rs.y) {
      const k = this.state.settings.padSensitivity * dt;
      this.yaw -= stickCurve(rs.x) * PAD_YAW_RATE * k;
      this.pitch = clamp(this.pitch + stickCurve(rs.y) * PAD_PITCH_RATE * k, PITCH_MIN, PITCH_MAX);
    }
    if (input.wheel) this.dist = clamp(this.dist * (1 + input.wheel * 0.12), DIST_MIN, DIST_MAX);
    // RT zooms in, LT out.
    const zoom = input.padTrigger('left') - input.padTrigger('right');
    if (zoom) this.dist = clamp(this.dist * Math.exp(zoom * PAD_ZOOM_RATE * dt), DIST_MIN, DIST_MAX);
    this.target.y = this.level * LEVEL_H;
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * Math.cos(this.pitch) * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * Math.cos(this.pitch) * this.dist,
    );
    this.camera.lookAt(this.target);
    this.rig.follow(this.target);
    this.grid.position.set(Math.round(this.target.x / TRACK_CELL) * TRACK_CELL, this.level * LEVEL_H + 0.05, Math.round(this.target.z / TRACK_CELL) * TRACK_CELL);

    // Hovered cell on the current level plane: under the cursor, or under the reticle (screen center) with the pad.
    const padAim = input.device === 'pad';
    this.raycaster.setFromCamera(new THREE.Vector2(padAim ? 0 : input.ndcX, padAim ? 0 : input.ndcY), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.level * LEVEL_H);
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    this.hover = hit ? [Math.floor(hit.x / TRACK_CELL), Math.floor(hit.z / TRACK_CELL)] : null;

    if (pressed('rotate')) this.rot = ((this.rot + 1) & 3) as Rot;
    if (pressed('rotateBack')) this.rot = ((this.rot + 3) & 3) as Rot;
    if (pressed('levelUp')) this.level = Math.min(MAX_LEVEL, this.level + 1);
    if (pressed('levelDown')) this.level = Math.max(0, this.level - 1);
    if (pressed('levelUp') || pressed('levelDown')) this.renderStatus();
    if (pressed('delete') && this.hover) this.apply(removeAt(this.track, this.hover[0], this.hover[1]));
    // Pad-only actions (the keyboard has Ctrl+Z / Ctrl+S, the mouse the palette and the top bar).
    const toolStep = this.toolRepeat.update(input.isDown('nextTool') ? 'right' : input.isDown('prevTool') ? 'left' : null, performance.now());
    if (toolStep) this.stepTool(toolStep === 'right' ? 1 : -1);
    // A held A places once, like a held click (each placement rebuilds the track).
    if (pressed('primary')) this.primary();
    if (pressed('undo')) this.undo();
    if (pressed('save')) this.save();
    if (pressed('test')) return this.testDrive();
    if (pressed('cancel')) this.leave();
    // Mouse only: the pad aims at the screen center whatever the last cursor position.
    const overUi = (document.elementFromPoint(input.mouseX, input.mouseY) as HTMLElement | null)?.closest('.panel');
    if (!overUi) {
      if (input.buttonWasPressed(0)) this.primary();
      if (input.buttonWasPressed(2)) this.rmbMoved = 0;
      if (input.buttonWasReleased(2) && this.rmbMoved < 6 && this.hover) this.apply(removeAt(this.track, this.hover[0], this.hover[1]));
    }
    this.updateGhost();
  }

  private updateGhost(): void {
    const p = this.currentPiece();
    const key = p ? `${p.t}` : '';
    if (key !== this.ghostKey) {
      this.ghost?.removeFromParent();
      this.ghost = null;
      this.ghostKey = key;
      if (p) {
        const def = TRACK_PIECES[p.t]!;
        const g = new THREE.Group();
        for (const part of [{ model: def.model, rot: 0 }, ...(def.extras ?? [])]) {
          const o = this.game.assets.instantiate(part.model);
          o.rotation.y = (part.rot ?? 0) * (Math.PI / 2);
          const wrap = new THREE.Group();
          wrap.add(o);
          g.add(wrap);
        }
        this.ghost = g;
        this.scene.add(g);
      }
    }
    if (!this.ghost || !p) {
      if (this.ghost) this.ghost.visible = false;
      return;
    }
    this.ghost.visible = true;
    const m = pieceMatrix(p);
    m.decompose(this.ghost.position, this.ghost.quaternion, this.ghost.scale);
    this.ghost.position.y += 0.15;
    const replace = overlapping(this.track, p).length > 0 || (TRACK_PIECES[p.t]?.gate === 'start' && this.track.pieces.some((q) => q.t === 'start'));
    const mat = replace ? ghostReplace : ghostOk;
    const invalid = !inBounds(p);
    this.ghost.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.material = invalid ? ghostBad : mat;
        mesh.castShadow = false;
      }
    });
  }

  debugState() {
    return {
      pieces: this.track.pieces.length,
      ok: this.analysis.ok,
      issues: this.analysis.issues.map((i) => i.code),
      hover: this.hover,
      tool: this.tool,
      rot: this.rot,
      level: this.level,
      medals: this.track.medals,
      id: this.track.id,
      name: this.track.name,
      dirty: this.dirty,
      under: this.hover ? pieceAt(this.track, this.hover[0], this.hover[1]) : null,
      confirming: this.confirming,
      camera: { x: this.target.x, z: this.target.z, yaw: this.yaw, pitch: this.pitch, dist: this.dist },
    };
  }

  /** Dev/test helper: place the camera over a cell so that the cursor can target it. */
  debugFocus(x: number, z: number): void {
    this.target.set((x + 0.5) * TRACK_CELL, 0, (z + 0.5) * TRACK_CELL);
  }

  exit(): void {
    window.removeEventListener('keydown', this.onKey);
    this.game.renderer.canvas.removeEventListener('contextmenu', this.prevent);
    this.built?.dispose();
    this.layer?.remove();
    this.disposeCamera();
  }
}
