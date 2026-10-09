import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { fakeAssets, kitMaterial } from './helpers/carAssets';
import { CarModel, WORN_TINTS, makeCarPreview, wornMaterial } from '../src/car/CarModel';
import type { CarSpec } from '../src/car/stats';
import type { Game } from '../src/core/Game';
import type { BuildLook } from '../src/garage/build';
import type { GameState } from '../src/state/GameState';
import { applySettings } from '../src/ui/menus/SettingsPanel';

// The wear's 3D look (CarModel.setWear) on fake assets: shared darkened copies of the kit material, by look group.

const KART: CarSpec = { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' } };
const KART_R: CarSpec = { blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing' } };
const SPORT_FULL: CarSpec = { blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' } };

const tire = (l: 1 | 2 | 3) => wornMaterial(kitMaterial, 'tire', l);
const body = (l: 1 | 2 | 3) => wornMaterial(kitMaterial, 'body', l);
const look = (wheels: number, b: number, spoiler: number) => wheels + 4 * b + 16 * spoiler;

function meshes(model: CarModel): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  model.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}
const named = (model: CarModel, name: string) => meshes(model).filter((m) => m.name === name);
const mat = (m: THREE.Mesh) => m.material as THREE.Material;
/** The 4 wheel meshes turning under their spinners, front first (the racing ones, or the original ones moved there; not the original ones hidden under the body). */
const wheelMeshes = (model: CarModel) => meshes(model).filter((m) => m.name.startsWith('wheel-') && m.visible);

describe('wear look (CarModel.setWear)', () => {
  it('never touches the kit material, uses 6 shared materials at most, the same instance for the same step', () => {
    const version = kitMaterial.version;
    const assets = fakeAssets();
    const models = [KART, KART_R, SPORT_FULL].map((s) => new CarModel(assets, s));
    const seen = new Set<THREE.Material>();
    for (let code = 0; code < 64; code++) {
      for (const m of models) {
        m.setWear(code);
        for (const x of meshes(m)) seen.add(mat(x));
      }
    }
    expect(kitMaterial.color.getHex()).toBe(0xffffff);
    expect(kitMaterial.version).toBe(version);
    expect(kitMaterial.transparent).toBe(false);
    seen.delete(kitMaterial);
    expect(seen.size).toBe(6);
    for (const l of [1, 2, 3] as const) {
      expect(seen.has(tire(l))).toBe(true);
      expect(seen.has(body(l))).toBe(true);
    }
    // Two models at the same step share it; it copies the kit material (its map too) with a darker color only.
    const [a, b] = [new CarModel(assets, KART), new CarModel(assets, SPORT_FULL)];
    a.setWear(look(2, 0, 0));
    b.setWear(look(2, 0, 0));
    expect(mat(wheelMeshes(a)[0]!)).toBe(mat(wheelMeshes(b)[0]!));
    for (const kind of ['tire', 'body'] as const) {
      let last = 1;
      for (const l of [1, 2, 3] as const) {
        const w = wornMaterial(kitMaterial, kind, l) as THREE.MeshStandardMaterial;
        expect(w.type).toBe(kitMaterial.type);
        expect(w.map).toBe(kitMaterial.map);
        expect(w.color.getHex()).toBe(new THREE.Color(WORN_TINTS[kind][l - 1]).getHex());
        expect(w.color.r).toBeLessThan(last);
        last = w.color.r;
      }
    }
  });

  it('wheels, body, spoiler: each its own step; the driver never changes; 0 is the kit material again', () => {
    const assets = fakeAssets();
    for (const spec of [KART, KART_R]) {
      const m = new CarModel(assets, spec);
      expect(wheelMeshes(m)).toHaveLength(4);
      m.setWear(look(3, 1, 2));
      for (const w of wheelMeshes(m)) expect(mat(w)).toBe(tire(3));
      // The kart's frame (its body) shows the chassis' step; its seated driver stays as it is.
      expect(mat(named(m, 'kart-oopi')[0]!)).toBe(body(1));
      expect(mat(named(m, 'character')[0]!)).toBe(kitMaterial);
      // The racing kart's original wheels, hidden under the body, are left alone.
      if (spec === KART_R) for (const w of meshes(m).filter((x) => x.name.startsWith('wheel-') && x.name !== 'wheel-racing')) expect(mat(w)).toBe(kitMaterial);
      m.setWear(0);
      for (const x of meshes(m)) expect(mat(x)).toBe(kitMaterial);
    }
    const s = new CarModel(assets, SPORT_FULL);
    expect(named(s, 'spoiler')).toHaveLength(1);
    s.setWear(look(1, 2, 3));
    expect(mat(named(s, 'body')[0]!)).toBe(body(2));
    expect(mat(named(s, 'spoiler')[0]!)).toBe(body(3));
    for (const w of wheelMeshes(s)) expect(mat(w)).toBe(tire(1));
    // A worn spoiler on a fresh body.
    s.setWear(look(0, 0, 1));
    expect(mat(named(s, 'body')[0]!)).toBe(kitMaterial);
    expect(mat(named(s, 'spoiler')[0]!)).toBe(body(1));
  });

  it('under construction: the see-through or bare body and the missing wheels win, the wear stays across looks', () => {
    const assets = fakeAssets();
    const m = new CarModel(assets, SPORT_FULL);
    const at: BuildLook = { body: 'ghost', wheels: 2, wheelItem: 'wheel_racing', engine: false, spoiler: false };
    m.setBuildLook(at);
    m.setWear(look(3, 3, 0));
    const ghost = mat(named(m, 'body')[0]!) as THREE.MeshStandardMaterial;
    expect(ghost.transparent).toBe(true);
    expect(ghost.opacity).toBe(0.3);
    const wheels = wheelMeshes(m);
    expect(wheels.slice(0, 2).map(mat)).toEqual([tire(3), tire(3)]);
    expect(wheels.slice(2).map(mat)).toEqual([ghost, ghost]);
    expect(wheels.map((w) => w.castShadow)).toEqual([true, true, false, false]);
    // Bare metal until every panel is in.
    m.setBuildLook({ ...at, body: 'bare', wheels: 4 });
    const bare = mat(named(m, 'body')[0]!) as THREE.MeshStandardMaterial;
    expect(bare).not.toBe(ghost);
    expect(bare.metalness).toBe(0.55);
    expect(wheelMeshes(m).map(mat)).toEqual([tire(3), tire(3), tire(3), tire(3)]);
    // Complete: the worn panels show, and keep showing through another look.
    m.setBuildLook({ ...at, body: 'solid', wheels: 4, engine: true, spoiler: true });
    expect(mat(named(m, 'body')[0]!)).toBe(body(3));
    expect(mat(named(m, 'spoiler')[0]!)).toBe(kitMaterial);
    m.setWear(0);
    expect(mat(named(m, 'body')[0]!)).toBe(kitMaterial);
    expect(wheelMeshes(m).map(mat)).toEqual([kitMaterial, kitMaterial, kitMaterial, kitMaterial]);
    // A ghost preview (the garage's draft) ignores the wear.
    const p = makeCarPreview(assets, KART);
    const before = meshes(p.model).map(mat);
    p.model.setWear(63);
    expect(meshes(p.model).map(mat)).toEqual(before);
    p.dispose();
  });

  it('dispose never frees the shared worn materials, and still frees the model’s own ghost', () => {
    const assets = fakeAssets();
    let freed = 0;
    const worn = [1, 2, 3].flatMap((l) => [tire(l as 1 | 2 | 3), body(l as 1 | 2 | 3)]);
    const count = () => freed++;
    for (const w of worn) w.addEventListener('dispose', count);
    const m = new CarModel(assets, SPORT_FULL);
    m.setBuildLook({ body: 'ghost', wheels: 1, wheelItem: 'wheel_racing', engine: false, spoiler: true });
    m.setWear(63);
    const ghost = mat(wheelMeshes(m)[3]!);
    let ghostFreed = false;
    ghost.addEventListener('dispose', () => (ghostFreed = true));
    const parked = new CarModel(assets, KART);
    parked.setWear(look(3, 3, 0));
    m.dispose();
    parked.dispose();
    expect(ghostFreed).toBe(true);
    expect(freed).toBe(0);
    for (const w of worn) w.removeEventListener('dispose', count);
  });

  it('a shadows toggle flags the shared materials no car shows any more, only when it changed (applySettings)', () => {
    const assets = fakeAssets();
    // Tires at step 1 then repaired, a bare body then complete: no mesh shows tire(1) or the bare metal at the toggle.
    const m = new CarModel(assets, SPORT_FULL);
    m.setBuildLook({ body: 'bare', wheels: 4, wheelItem: 'wheel_racing', engine: true, spoiler: true });
    const bare = mat(named(m, 'body')[0]!);
    m.setWear(look(1, 3, 0));
    m.setBuildLook({ body: 'solid', wheels: 4, wheelItem: 'wheel_racing', engine: true, spoiler: true });
    m.setWear(look(0, 3, 0));
    expect(meshes(m).map(mat)).not.toContain(tire(1));
    expect(meshes(m).map(mat)).not.toContain(bare);
    const shared = [tire(1), body(3), bare];
    const versions = () => shared.map((x) => x.version);
    const kit = kitMaterial.version;
    const before = versions();
    let changed = false;
    const game = { renderer: { setShadows: () => changed } } as unknown as Game;
    const state = { settings: { shadows: false } } as GameState;
    applySettings(game, state);
    expect(versions()).toEqual(before);
    // Changed: three re-checks their program the next time they are drawn (shadows on or off).
    changed = true;
    applySettings(game, state);
    expect(versions()).toEqual(before.map((v) => v + 1));
    // The kit material is the scene's (the renderer flags it where it shows), never this module's.
    expect(kitMaterial.version).toBe(kit);
    m.dispose();
  });
});
