import { sanitizeLook, cleanName, type CharacterLook } from '../data/character';
import { GameState, type PlayerSave, type SaveData } from '../state/GameState';

/*
 * Sharing a world (« Voir le monde d'un ami »): the save of a game, without what belongs to the player alone (their
 * settings, the challenges they received), with who made it. The friend visits it (GameState.visit): never saved,
 * their own game set aside and loaded back untouched when they leave.
 */

export interface WorldShare {
  format: 'satiscartory-monde';
  version: 1;
  from: string;
  look: CharacterLook;
  at: number;
  save: SaveData;
}

/** The share of `state`: its save, stripped of the player's own settings and received challenges. */
export function worldShare(state: GameState): WorldShare {
  const save = state.serialize();
  delete save.settings;
  delete save.challenges;
  return { format: 'satiscartory-monde', version: 1, from: state.look.name, look: { ...state.look }, at: Date.now(), save };
}

/** What a visit shows of the friend: their name, their character and where they left it. */
export interface Visit {
  from: string;
  look: CharacterLook;
  player: PlayerSave | null;
  at: number;
}

/**
 * A friend's world from their code: the game to visit and who they are. Throws a French message when it cannot be
 * loaded (not a world, another version, a broken save).
 */
export function parseWorld(raw: unknown): { state: GameState; visit: Visit } {
  const r = raw as Partial<WorldShare> | null;
  if (!r || typeof r !== 'object' || r.format !== 'satiscartory-monde') throw new Error('Ce n’est pas un monde Satiscartory');
  if (r.version !== 1) throw new Error('Ce monde vient d’une autre version du jeu');
  const save = r.save;
  if (!save || save.version !== 1 || !save.factory || !Array.isArray(save.factory.buildings)) throw new Error('Ce monde est abîmé');
  let state: GameState;
  try {
    state = GameState.fromSave(save);
  } catch {
    throw new Error('Ce monde est abîmé');
  }
  const visit: Visit = { from: cleanName(r.from), look: sanitizeLook(r.look), player: state.player, at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0 };
  // The visitor arrives at the spawn by the hub; the friend's character stands where they left it.
  state.player = null;
  state.ephemeral = true;
  state.visit = visit;
  return { state, visit };
}
