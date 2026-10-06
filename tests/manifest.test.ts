import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { MODELS, KITS } from '../src/core/assets/manifest.gen';
import { ITEMS } from '../src/data/items';

describe('asset manifest', () => {
  it('lists the three Kenney kits', () => {
    expect([...KITS].sort()).toEqual(['car-kit', 'city-kit-roads', 'factory-kit']);
  });
  it('every model file exists with its shared texture and license', () => {
    for (const path of Object.values(MODELS)) expect(existsSync(`public/${path}`), path).toBe(true);
    for (const kit of KITS) {
      expect(existsSync(`public/assets/kenney/${kit}/Textures/colormap.png`)).toBe(true);
      expect(existsSync(`public/assets/kenney/${kit}/License.txt`)).toBe(true);
    }
  });
  it('contains the models the game relies on', () => {
    const required = [
      'car-kit/race', 'car-kit/kart-oopi', 'car-kit/sedan-sports', 'car-kit/wheel-default', 'car-kit/wheel-racing',
      'car-kit/debris-plate-a', 'car-kit/debris-bolt', 'car-kit/debris-tire', 'car-kit/debris-drivetrain',
      'factory-kit/conveyor', 'factory-kit/conveyor-corner', 'factory-kit/machine', 'factory-kit/oopi', 'factory-kit/robot-arm-a',
      // Factory buildings (view/BuildingVisuals, view/FactoryView).
      'factory-kit/conveyor-stripe', 'factory-kit/conveyor-junction-t', 'factory-kit/floor', 'factory-kit/floor-large',
      'factory-kit/machine-window', 'factory-kit/machine-connection-hole', 'factory-kit/piston-square', 'factory-kit/piston-round',
      'factory-kit/piston-thin-round', 'factory-kit/pipe-large-valve', 'factory-kit/structure-yellow-medium', 'factory-kit/hopper-high-round',
      'factory-kit/hopper-high-square', 'factory-kit/structure-yellow-tall', 'factory-kit/screen-panel-wide',
      // Hub crafting bench.
      'factory-kit/structure-yellow-short', 'factory-kit/box-large', 'factory-kit/lever-single', 'factory-kit/pipe-large-long',
      'car-kit/debris-plate-small-a',
      'city-kit-roads/road-straight', 'city-kit-roads/road-bend', 'city-kit-roads/road-curve', 'city-kit-roads/road-slant',
    ];
    for (const k of required) expect(Object.keys(MODELS)).toContain(k);
  });
  it('contains the model of every item', () => {
    for (const def of Object.values(ITEMS)) expect(Object.keys(MODELS), def.id).toContain(def.model);
  });
});
