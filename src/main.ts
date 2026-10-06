import './ui/styles/main.css';
import { Game } from './core/Game';
import { initRapier } from './core/physics/PhysicsWorld';
import type { ModeName } from './core/ModeManager';
import { AssetGalleryMode } from './dev/AssetGalleryMode';
import { MenuMode, type MenuEntry } from './ui/menus/MenuMode';
import { el } from './ui/dom';
import { GameState } from './state/GameState';
import { SaveManager } from './state/SaveManager';
import { FactoryMode } from './factory/FactoryMode';
import { RaceMode } from './race/RaceMode';
import { fr } from './ui/i18n/fr';

function loadingScreen() {
  const bar = el('div');
  const label = el('div', { class: 'muted' }, fr.loadingRapier);
  const root = el('div', { id: 'loading' }, el('h1', {}, fr.title), el('div', { class: 'bar' }, bar), label);
  document.body.appendChild(root);
  return {
    progress(done: number, total: number) {
      bar.style.width = `${Math.round((done / total) * 100)}%`;
      label.textContent = `${fr.loading} ${done}/${total}`;
    },
    hide() {
      root.classList.add('hidden');
      setTimeout(() => root.remove(), 500);
    },
  };
}

async function main() {
  const loading = loadingScreen();
  await initRapier();
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const game = new Game(canvas);
  await game.assets.loadMany(game.assets.allKeys(), (d, t) => loading.progress(d, t));

  const state = SaveManager.load() ?? new GameState();
  const menuEntries = (): MenuEntry[] => [
    { label: SaveManager.hasSave() ? fr.menu.continue : fr.menu.play, mode: 'factory', primary: true },
    { label: fr.menu.garage, mode: 'garage' },
    { label: fr.menu.race, mode: 'race' },
    { label: fr.menu.editor, mode: 'editor' },
    { label: fr.menu.gallery, mode: 'gallery' },
    {
      label: fr.menu.newGame,
      action: () => {
        if (!SaveManager.hasSave() || window.confirm(fr.menu.confirmNewGame)) {
          SaveManager.clear();
          state.replaceWith(new GameState());
          void game.switchMode('factory');
        }
      },
    },
  ];
  game.modes.register('menu', () => new MenuMode(game, menuEntries));
  game.modes.register('gallery', () => new AssetGalleryMode(game));

  game.modes.register('factory', () => new FactoryMode(game, state));
  game.modes.register('race', () => new RaceMode(game, state));
  // The factory keeps producing whatever mode is active.
  game.addFactoryTicker(() => state.sim.tick());

  // Autosave: every 30 s, on every mode switch and when the page is hidden/closed.
  let saveTimer = 0;
  game.addFrameListener((dt) => {
    saveTimer += dt;
    if (saveTimer >= 30) {
      saveTimer = 0;
      SaveManager.save(state);
    }
  });
  game.onModeChange(() => SaveManager.save(state));
  window.addEventListener('beforeunload', () => SaveManager.save(state));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') SaveManager.save(state);
  });

  const params = new URLSearchParams(location.search);
  const requested = params.get('mode') as ModeName | null;
  const modeParams: Record<string, unknown> = Object.fromEntries(params);
  if (import.meta.env.DEV && requested === 'race') {
    const { DEV_TRACKS } = await import('./dev/testTrack');
    const { DEV_SPECS } = await import('./race/RaceMode');
    const t = params.get('track');
    if (t && DEV_TRACKS[t]) modeParams.track = DEV_TRACKS[t];
    const c = params.get('car');
    if (c && DEV_SPECS[c]) modeParams.spec = DEV_SPECS[c];
  }
  await game.switchMode(requested && game.modes.has(requested) ? requested : 'menu', modeParams);
  game.start();
  loading.hide();

  if (import.meta.env.DEV) {
    Object.assign(window, { __game: game, __state: state, __save: SaveManager });
    const { installTestHelpers } = await import('./dev/testHelpers');
    installTestHelpers(game);
  }
}

main().catch((err) => {
  console.error(err);
  document.body.appendChild(el('pre', { style: 'color:#ff8080;padding:20px;position:fixed;inset:0;z-index:999;background:#111' }, String(err?.stack ?? err)));
});
