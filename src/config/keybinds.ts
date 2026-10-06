// Actions are bound to physical keys (KeyboardEvent.code), so WASD maps to ZQSD on AZERTY.
export const KEYBINDS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  interact: ['KeyE'],
  buildMenu: ['KeyQ'], // A on AZERTY (Q is "left" in ZQSD)
  rotate: ['KeyR'],
  dismantle: ['KeyF'],
  cancel: ['Escape'],
  garage: ['KeyG'],
  inventory: ['Tab', 'KeyI'],
  hotbar1: ['Digit1'],
  hotbar2: ['Digit2'],
  hotbar3: ['Digit3'],
  hotbar4: ['Digit4'],
  hotbar5: ['Digit5'],
  hotbar6: ['Digit6'],
  // vehicle
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  respawn: ['Backspace'],
  retry: ['Enter', 'NumpadEnter'],
  restart: ['Delete'],
  // editor
  levelUp: ['PageUp'],
  levelDown: ['PageDown'],
  delete: ['KeyX'],
  // dev
  debug: ['F3'],
} as const satisfies Record<string, readonly string[]>;

export type Action = keyof typeof KEYBINDS;
