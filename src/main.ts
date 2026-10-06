import './ui/styles/main.css';
import { Game } from './core/Game';
import { initRapier } from './core/physics/PhysicsWorld';
import type { ModeName } from './core/ModeManager';
import { AssetGalleryMode } from './dev/AssetGalleryMode';
import { MenuMode, type MenuEntry } from './ui/menus/MenuMode';
import { el } from './ui/dom';
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

  const menuEntries = (): MenuEntry[] => [
    { label: fr.menu.play, mode: 'factory', primary: true },
    { label: fr.menu.garage, mode: 'garage' },
    { label: fr.menu.race, mode: 'race' },
    { label: fr.menu.editor, mode: 'editor' },
    { label: fr.menu.gallery, mode: 'gallery' },
  ];
  game.modes.register('menu', () => new MenuMode(game, menuEntries));
  game.modes.register('gallery', () => new AssetGalleryMode(game));

  const params = new URLSearchParams(location.search);
  const requested = params.get('mode') as ModeName | null;
  await game.switchMode(requested && game.modes.has(requested) ? requested : 'menu', Object.fromEntries(params));
  game.start();
  loading.hide();

  if (import.meta.env.DEV) {
    (window as unknown as { __game: Game }).__game = game;
  }
}

main().catch((err) => {
  console.error(err);
  document.body.appendChild(el('pre', { style: 'color:#ff8080;padding:20px;position:fixed;inset:0;z-index:999;background:#111' }, String(err?.stack ?? err)));
});
