import type { Input } from '../core/Input';
import type { VehicleControls } from './Vehicle';

/** Keyboard (+ first gamepad) → vehicle controls. */
export function readVehicleControls(input: Input): VehicleControls {
  let throttle = input.isDown('throttle') ? 1 : 0;
  let brake = input.isDown('brake') ? 1 : 0;
  let steer = input.axis('steerRight', 'steerLeft');
  let handbrake = input.isDown('handbrake');
  const pad = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads()[0] : null;
  if (pad) {
    const rt = pad.buttons[7]?.value ?? 0;
    const lt = pad.buttons[6]?.value ?? 0;
    const sx = pad.axes[0] ?? 0;
    if (rt > 0.05) throttle = Math.max(throttle, rt);
    if (lt > 0.05) brake = Math.max(brake, lt);
    if (Math.abs(sx) > 0.12) steer = -sx;
    if (pad.buttons[0]?.pressed) handbrake = true;
  }
  return { throttle, brake, steer, handbrake };
}
