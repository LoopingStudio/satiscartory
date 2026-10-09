import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { fakeAssets, kitMaterial } from './helpers/carAssets';
import { CarModel, wornMaterial } from '../src/car/CarModel';
import { DEALER } from '../src/data/balance';
import type { Inventory } from '../src/data/items';
import { FactorySim } from '../src/factory/sim/FactorySim';
import type { DealerB } from '../src/factory/sim/types';
import { DealerShow } from '../src/factory/view/BuildingVisuals';
import { DEALER_BAR, DEALER_DISPLAY } from '../src/factory/view/dealerLayout';

// The dealer's live showroom (the car on show, its progress bar, its sales) on a real sim, CarModel on fake assets.
// The price label needs a canvas: browser only.

const FULL: Inventory = { chassis: 1, engine: 1, wheel_racing: 4, panel: 4, spoiler: 1 };
const T = DEALER.SELL_TICKS;
const DT = 1 / 60;

/** A dealer with its showroom; its sales play there, as FactoryView wires them. */
function setup(stock: Inventory) {
  const sim = new FactorySim({ width: 32, height: 32, storage: { plate: 10_000, iron_rod: 10_000, bolt: 10_000 }, hub: null });
  const r = sim.place('dealer', 10, 10, 0);
  if (!r.ok) throw new Error(`cannot place dealer: ${r.check.error}`);
  const d = r.building as DealerB;
  d.stock = { ...stock };
  const root = new THREE.Group();
  const show = new DealerShow(fakeAssets(), root, d.id);
  sim.events.on('sold', (e) => {
    if (e.dealer === d.id) show.onSold(e.price);
  });
  const frame = () => show.update(sim, d, DT);
  /** One sim tick, then the three frames until the next one. */
  const tick = () => {
    sim.tick();
    for (let i = 0; i < 3; i++) frame();
  };
  // The bar is the only mesh among the showroom's own children; the cars are groups.
  const bar = root.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh;
  const cars = () => root.children.filter((c) => c !== bar);
  return { sim, d, show, frame, tick, cars, bar };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dealer showroom', () => {
  it('puts the car on show together part by part, re-applying its look only when it changes', () => {
    const looks = vi.spyOn(CarModel.prototype, 'setBuildLook');
    const { d, frame, tick, cars, bar } = setup(FULL);
    frame();
    expect(cars()).toEqual([]);
    expect(bar.visible).toBe(false);
    tick();
    expect(d.car?.blueprint).toBe('sport');
    const [car] = cars();
    expect(cars()).toHaveLength(1);
    expect(car!.position.toArray()).toEqual([DEALER_DISPLAY.x, DEALER_DISPLAY.y, DEALER_DISPLAY.z]);
    expect(car!.rotation.y).toBe(DEALER_DISPLAY.yaw);
    expect(looks.mock.calls.map((c) => c[0])).toEqual([{ body: 'ghost', wheels: 0, wheelItem: null, engine: false, spoiler: false }]);
    expect(bar.visible).toBe(true);
    for (let k = 1; k < T; k++) tick();
    // Same model all along; 9 looks: ghost, chassis, engine, wheels one by one, the 4th panel (the first three do
    // not show), the spoiler.
    expect(cars()).toEqual([car]);
    expect(looks).toHaveBeenCalledTimes(9);
    expect(looks.mock.calls.at(-1)![0]).toEqual({ body: 'solid', wheels: 4, wheelItem: 'wheel_racing', engine: true, spoiler: true });
    expect(bar.scale.x).toBeCloseTo((2 * DEALER_BAR.halfW * (T - 1)) / T, 9);
    // Aimed at, the car is the dealer (the engine and stands added by the looks too).
    car!.traverse((o) => expect(o.userData.buildingId).toBe(d.id));
  });

  it('a sold car sinks through the podium and is freed, while the next one appears on a model of its own', () => {
    const two = Object.fromEntries(Object.entries(FULL).map(([k, n]) => [k, 2 * n!]));
    const { sim, d, frame, tick, cars, bar } = setup(two);
    for (let k = 0; k < T; k++) tick();
    const [first] = cars();
    const disposed = vi.spyOn(CarModel.prototype, 'dispose');
    tick();
    expect(sim.carsSold).toBe(1);
    // The same car again, on a new model standing on the podium; the sold one is going down.
    expect(d.car?.blueprint).toBe('sport');
    expect(cars()).toHaveLength(2);
    const [sinking, next] = cars();
    expect(sinking).toBe(first);
    expect(first!.position.y).toBeLessThan(DEALER_DISPLAY.y);
    expect(next!.position.y).toBe(DEALER_DISPLAY.y);
    let last = first!.position.y;
    for (let i = 0; i < 60 && first!.parent; i++) {
      frame();
      if (first!.parent) expect(first!.position.y).toBeLessThan(last);
      last = first!.position.y;
    }
    // Gone after 0.9 s, about 2 m down.
    expect(first!.parent).toBeNull();
    expect(last).toBeLessThan(DEALER_DISPLAY.y - 1.5);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(cars()).toEqual([next]);
    // The second sale: nothing left to show, the bar goes out.
    for (let k = 0; k < T; k++) tick();
    expect(sim.carsSold).toBe(2);
    expect(d.car).toBeNull();
    expect(bar.visible).toBe(false);
    expect(cars()).toEqual([next]);
    for (let i = 0; i < 60; i++) frame();
    expect(cars()).toEqual([]);
    expect(disposed).toHaveBeenCalledTimes(2);
  });

  it('the car on show is always new: never worn in 3D, its meshes on the kit material or the build look’s own', () => {
    const wear = vi.spyOn(CarModel.prototype, 'setWear');
    const two = Object.fromEntries(Object.entries(FULL).map(([k, n]) => [k, 2 * n!]));
    const { tick, cars } = setup(two);
    for (let k = 0; k <= T + 2; k++) tick();
    expect(cars().length).toBeGreaterThan(0);
    expect(wear.mock.calls.every(([code]) => code === 0)).toBe(true);
    const worn = new Set([1, 2, 3].flatMap((l) => [wornMaterial(kitMaterial, 'tire', l as 1 | 2 | 3), wornMaterial(kitMaterial, 'body', l as 1 | 2 | 3)]));
    for (const car of cars()) {
      car.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) expect(worn.has(m.material as THREE.Material)).toBe(false);
      });
    }
  });

  it('dispose frees the car on show and the sinking one', () => {
    const two = Object.fromEntries(Object.entries(FULL).map(([k, n]) => [k, 2 * n!]));
    const { show, tick, cars } = setup(two);
    for (let k = 0; k <= T; k++) tick();
    expect(cars()).toHaveLength(2);
    const disposed = vi.spyOn(CarModel.prototype, 'dispose');
    show.dispose();
    expect(disposed).toHaveBeenCalledTimes(2);
    expect(cars()).toEqual([]);
  });
});
