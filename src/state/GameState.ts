import { FactorySim } from '../factory/sim/FactorySim';

/** Persistent game state shared by all modes (the factory keeps running in every mode). */
export class GameState {
  sim: FactorySim;

  constructor(sim?: FactorySim) {
    this.sim = sim ?? FactorySim.newGame();
  }
}
