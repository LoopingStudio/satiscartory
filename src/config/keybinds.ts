import type { PadButton } from '../core/gamepad';

// Actions are bound to physical keys (KeyboardEvent.code), so WASD maps to ZQSD on AZERTY.
// An empty list is a pad-only action (see PADBINDS); the mouse buttons are read separately.
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
  inventory: ['Tab', 'KeyI'],
  hotbar1: ['Digit1'],
  hotbar2: ['Digit2'],
  hotbar3: ['Digit3'],
  hotbar4: ['Digit4'],
  hotbar5: ['Digit5'],
  hotbar6: ['Digit6'],
  hotbar7: ['Digit7'],
  hotbar8: ['Digit8'],
  // pad-only (keyboard: Escape pauses through the pointer lock, Shift+R, mouse buttons, wheel)
  pause: [],
  primary: [],
  secondary: [],
  rotateBack: [],
  prevTool: [],
  nextTool: [],
  zoomCycle: [],
  // vehicle
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  respawn: ['Backspace'],
  retry: ['Enter', 'NumpadEnter'],
  restart: ['Delete'],
  // editor (Ctrl+Z / Ctrl+S are read from KeyboardEvent.key by the editor itself)
  levelUp: ['PageUp'],
  levelDown: ['PageDown'],
  delete: ['KeyX'],
  undo: [],
  save: [],
  test: [],
  // dev
  debug: ['F3'],
} as const satisfies Record<string, readonly string[]>;

export type Action = keyof typeof KEYBINDS;

/**
 * Gameplay pad bindings per context; the active mode picks one (Input.padProfile). Sticks and triggers
 * are analog (Input.padStick / padTrigger): moving, camera, throttle, brake, steering, editor zoom.
 * Menus are driven by PadNav (D-pad / left stick, A, B, LB/RB, data-pad-btn), not by these.
 */
export type PadProfile = 'none' | 'foot' | 'drive' | 'race' | 'editor';
export const PADBINDS: Record<PadProfile, Partial<Record<Action, readonly PadButton[]>>> = {
  none: {},
  foot: {
    jump: ['a'],
    interact: ['x'],
    buildMenu: ['y'],
    secondary: ['b'],
    primary: ['rt'],
    rotate: ['rb'],
    rotateBack: ['lb'],
    prevTool: ['left'],
    nextTool: ['right'],
    zoomCycle: ['up'],
    dismantle: ['down'],
    inventory: ['view'],
    pause: ['start'],
    sprint: ['l3'],
  },
  drive: {
    handbrake: ['a'],
    interact: ['x'],
    retry: ['y'],
    respawn: ['b'],
    pause: ['start'],
  },
  race: {
    handbrake: ['a'],
    respawn: ['b'],
    restart: ['view'],
    retry: ['y'],
    cancel: ['start'],
  },
  editor: {
    primary: ['a'],
    delete: ['x'],
    rotate: ['rb'],
    rotateBack: ['lb'],
    prevTool: ['left'],
    nextTool: ['right'],
    levelUp: ['up'],
    levelDown: ['down'],
    undo: ['view'],
    test: ['y'],
    save: ['start'],
    cancel: ['b'],
  },
};

/** On-screen key names (AZERTY letters for the physical codes above). */
export const KEY_LABELS: Partial<Record<Action, string>> = {
  forward: 'Z',
  back: 'S',
  left: 'Q',
  right: 'D',
  jump: 'Espace',
  sprint: 'Maj',
  interact: 'E',
  buildMenu: 'A',
  rotate: 'R',
  dismantle: 'F',
  cancel: 'Échap',
  inventory: 'Tab',
  handbrake: 'Espace',
  respawn: 'Retour arrière',
  retry: 'Entrée',
  restart: 'Suppr',
  levelUp: 'Pg↑',
  levelDown: 'Pg↓',
  delete: 'X',
  undo: 'Ctrl+Z',
  save: 'Ctrl+S',
  debug: 'F3',
};
