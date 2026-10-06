import GUI from 'lil-gui';
import type { VehicleTuning } from '../car/tuning';

const RANGES: Partial<Record<keyof VehicleTuning, [number, number, number]>> = {
  // massKg / comY are baked into the rigid body at creation (not live-tunable).
  engineN: [500, 30000, 100],
  rearBias: [0, 1, 0.05],
  dragK: [0, 10, 0.01],
  rollingK: [0, 200, 1],
  brakeN: [0, 40000, 100],
  frictionSlip: [0.2, 12, 0.05],
  sideFrictionStiffness: [0.1, 4, 0.05],
  driftSideFriction: [0.05, 2, 0.05],
  downforceK: [0, 10, 0.05],
  steerMaxRad: [0.1, 1.2, 0.01],
  steerAtTopSpeed: [0.05, 1, 0.01],
  steerSpeed: [0.5, 20, 0.5],
  suspensionStiffness: [5, 200, 1],
  suspensionCompression: [0.1, 20, 0.1],
  suspensionRelaxation: [0.1, 20, 0.1],
  suspensionTravel: [0.05, 1, 0.01],
  airControl: [0, 20, 0.5],
};

/** Live vehicle tuning (dev, shown with F3). */
export class TuningPanel {
  private gui: GUI;

  constructor(tuning: VehicleTuning, onChange: (t: VehicleTuning) => void) {
    this.gui = new GUI({ title: 'Réglages véhicule (dev)' });
    for (const [key, range] of Object.entries(RANGES) as [keyof VehicleTuning, [number, number, number]][]) {
      this.gui.add(tuning, key, range[0], range[1], range[2]).onChange(() => onChange(tuning));
    }
    this.gui.add({ copier: () => navigator.clipboard?.writeText(JSON.stringify(tuning, null, 2)) }, 'copier').name('Copier JSON');
  }

  dispose(): void {
    this.gui.destroy();
  }
}
