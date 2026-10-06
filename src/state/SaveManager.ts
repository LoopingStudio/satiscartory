import { GameState, type SaveData } from './GameState';

export const SAVE_KEY = 'satiscartory.save.v1';
const BACKUP_KEY = 'satiscartory.save.v1.bak';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): SaveData | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as SaveData;
    if (data?.version !== 1 || !data.factory || !Array.isArray(data.factory.buildings)) return null;
    return data;
  } catch {
    return null;
  }
}

/** localStorage persistence with a backup slot (a corrupt save falls back to the previous one). */
export const SaveManager = {
  save(state: GameState): boolean {
    const ls = storage();
    if (!ls || state.ephemeral) return false;
    try {
      const prev = ls.getItem(SAVE_KEY);
      if (prev) ls.setItem(BACKUP_KEY, prev);
      ls.setItem(SAVE_KEY, JSON.stringify(state.serialize()));
      return true;
    } catch (e) {
      console.warn('Save failed', e);
      return false;
    }
  },

  load(): GameState | null {
    const ls = storage();
    if (!ls) return null;
    for (const key of [SAVE_KEY, BACKUP_KEY]) {
      const data = parse(ls.getItem(key));
      if (!data) continue;
      try {
        return GameState.fromSave(data);
      } catch (e) {
        console.warn(`Save ${key} unreadable`, e);
      }
    }
    return null;
  },

  hasSave(): boolean {
    return !!storage()?.getItem(SAVE_KEY);
  },

  clear(): void {
    const ls = storage();
    ls?.removeItem(SAVE_KEY);
    ls?.removeItem(BACKUP_KEY);
  },
};
