import { describe, expect, it } from 'vitest';
import { TRACKDAY, carRefusal, forecastTrackday, type TrackdayPlan } from './trackday';
import { GameState } from '../state/GameState';
import { raceCarFor } from '../race/raceCar';
import type { CarInstance } from '../garage/assembly';

const kart = (id: string, extra: Partial<CarInstance> = {}): CarInstance => ({
  id, name: `Kart ${id}`, blueprint: 'kart', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel' }, ...extra,
});
const sport = (id: string): CarInstance => ({
  id, name: `Sportive ${id}`, blueprint: 'sport', parts: { chassis: 'chassis', engine: 'engine', wheels: 'wheel_racing', panels: 'panel', spoiler: 'spoiler' },
});
const plan = (carIds: string[], over: Partial<TrackdayPlan> = {}): TrackdayPlan => ({ trackId: 'oval', carIds, meal: 'sandwich', drink: 'water', coaching: 'none', price: 300, ...over });
const ctx = { medal: null, official: true, reputation: 20 };

describe('trackday forecast', () => {
  it('fills the places when the ticket is fair, empties them when too dear', () => {
    const cars = [kart('a'), kart('b')];
    const cheap = forecastTrackday(plan(['a', 'b'], { price: 150 }), cars, ctx);
    expect(cheap.places).toBe(2 * TRACKDAY.GUESTS_PER_CAR);
    expect(cheap.guests).toBe(cheap.places);
    expect(cheap.revenue).toBe(cheap.guests * 150);
    const dear = forecastTrackday(plan(['a', 'b'], { price: 2000 }), cars, ctx);
    expect(dear.guests).toBe(0);
    expect(dear.revenue).toBe(0);
  });

  it('better cars, services and reputation make the day worth more and the guests happier', () => {
    const base = forecastTrackday(plan(['a']), [kart('a')], ctx);
    const better = forecastTrackday(plan(['s'], { meal: 'gourmet', drink: 'bar', coaching: 'pro' }), [sport('s')], { ...ctx, reputation: 80 });
    expect(better.fairPrice).toBeGreaterThan(base.fairPrice * 2);
    expect(better.satisfaction).toBeGreaterThan(base.satisfaction);
    expect(better.costs).toBe(better.guests * (150 + 45 + 90));
  });

  it('self coaching needs a medal on the circuit, and is as good as the medal', () => {
    expect(forecastTrackday(plan(['a'], { coaching: 'self' }), [kart('a')], ctx).problem).toMatch(/médaille/);
    const bronze = forecastTrackday(plan(['a'], { coaching: 'self' }), [kart('a')], { ...ctx, medal: 'bronze' });
    const gold = forecastTrackday(plan(['a'], { coaching: 'self' }), [kart('a')], { ...ctx, medal: 'gold' });
    expect(bronze.problem).toBeNull();
    expect(gold.satisfaction).toBeGreaterThan(bronze.satisfaction);
    // Coached guests drive cleaner: less wear per guest (a better coach also brings more of them).
    const perGuest = (f: typeof gold) => f.cars[0]!.wear.wheels! / f.cars[0]!.guests;
    expect(perGuest(gold)).toBeLessThan(perGuest(bronze));
  });

  it('cars to repair, to refuel or short of fuel for the day stay home', () => {
    expect(carRefusal(kart('a'))).toBeNull();
    expect(carRefusal(kart('a', { wear: { wheels: 900 } }))).toBe('à réparer');
    expect(carRefusal(kart('a', { fuel: 950 }))).toBe('à ravitailler');
    expect(carRefusal(kart('a', { fuel: 700 }))).toMatch(/pas assez d’essence/);
    expect(carRefusal({ id: 'l', name: 'Location', blueprint: 'loaner', parts: {} })).not.toBeNull();
    expect(forecastTrackday(plan(['a']), [kart('a', { fuel: 700 })], ctx).problem).toMatch(/essence/);
  });
});

describe('trackday in the game', () => {
  it('starts (catering paid), keeps the cars away, ends with tickets, wear, fuel and reputation', () => {
    const s = new GameState();
    s.cars = [kart('a'), kart('b')];
    s.sim.credits = 1000;
    const p = plan(['a']);
    const f = forecastTrackday(p, s.cars, { medal: null, official: true, reputation: s.trackdayRep });
    expect(s.startTrackday(p, f, 'Ovale')).toBeNull();
    expect(s.sim.credits).toBe(1000 - f.costs);
    expect(s.isAway('a')).toBe(true);
    expect(s.isAway('b')).toBe(false);
    expect(raceCarFor(s, { carId: 'a' }).away?.id).toBe('a');
    expect(s.startTrackday(p, f, 'Ovale')).toMatch(/déjà/);
    // Saved mid-way: it goes on after a reload.
    const back = GameState.fromSave(JSON.parse(JSON.stringify(s.serialize())));
    expect(back.isAway('a')).toBe(true);
    let done = null as unknown;
    s.onTrackdayDone = (r) => (done = r);
    s.sim.run(TRACKDAY.TICKS - 1);
    s.tickTrackday();
    expect(s.trackday).not.toBeNull();
    s.sim.tick();
    s.tickTrackday();
    expect(s.trackday).toBeNull();
    expect(done).toMatchObject({ trackName: 'Ovale', guests: f.guests, revenue: f.revenue });
    expect(s.sim.credits).toBe(1000 - f.costs + f.revenue);
    expect(s.cars[0]!.wear?.wheels).toBe(f.cars[0]!.wear.wheels);
    expect(s.cars[0]!.fuel).toBe(f.cars[0]!.fuel);
    expect(s.cars[1]!.wear).toBeUndefined();
    expect(s.trackdayRep).toBe(f.reputation);
    expect(s.trackdayLog).toHaveLength(1);
  });

  it('a saved trackday whose car is gone is dropped', () => {
    const s = new GameState();
    s.cars = [kart('a')];
    s.sim.credits = 1000;
    const p = plan(['a']);
    s.startTrackday(p, forecastTrackday(p, s.cars, ctx), 'Ovale');
    const data = JSON.parse(JSON.stringify(s.serialize()));
    data.cars = [];
    expect(GameState.fromSave(data).trackday).toBeNull();
  });
});
