import type { Input } from '../core/Input';
import type { VehicleControls } from './Vehicle';

/** Keyboard + gamepad (RT throttle, LT brake, left stick steering, A handbrake) → vehicle controls. */
export function readVehicleControls(input: Input): VehicleControls {
  let throttle = input.isDown('throttle') ? 1 : 0;
  let brake = input.isDown('brake') ? 1 : 0;
  let steer = input.axis('steerRight', 'steerLeft');
  // The handbrake button is the pad's A in the driving contexts (PADBINDS).
  const handbrake = input.isDown('handbrake');
  throttle = Math.max(throttle, input.padTrigger('right'));
  brake = Math.max(brake, input.padTrigger('left'));
  const sx = input.padStick('left').x;
  if (sx) steer = Math.max(-1, Math.min(1, steer - sx));
  return { throttle, brake, steer, handbrake };
}
