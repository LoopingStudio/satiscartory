import { describe, expect, it } from 'vitest';
import { GameState } from './GameState';
import { FACTORY_CELL } from '../config/constants';
import { LEGACY_MAP_OFFSET } from '../data/factoryMap';

describe('GameState migrations', () => {
  it('moves the player with the factory when loading a save from the 64×64 map', () => {
    const data = new GameState().serialize();
    data.factory.version = 2;
    data.factory.buildings = [{ type: 'hub', id: 1, x: 30, z: 30, rot: 0 }];
    data.player = { x: 63, y: 0.1, z: 54, yaw: 0 };
    const s = GameState.fromSave(data);
    const shift = LEGACY_MAP_OFFSET * FACTORY_CELL;
    expect(s.player).toEqual({ x: 63 + shift, y: 0.1, z: 54 + shift, yaw: 0 });
    // a current save is left untouched
    const again = GameState.fromSave(s.serialize());
    expect(again.player).toEqual(s.player);
  });
});
