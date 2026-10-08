import { describe, expect, it } from 'vitest';
import { dualKey, keyFor, padLabel, padText, renderTokens } from './padHints';
import { OBJECTIVES } from '../data/objectives';
import { KEYBINDS, PADBINDS, type Action } from '../config/keybinds';
import { BUILD_MENU } from '../data/buildings';

describe('pad hints', () => {
  it('labels keys on AZERTY and pad buttons by context', () => {
    expect(keyFor('kbm', 'buildMenu', 'foot')).toBe('<kbd>A</kbd>');
    expect(keyFor('pad', 'buildMenu', 'foot')).toContain('pad-y');
    expect(keyFor('pad', 'interact', 'drive')).toContain('pad-x');
    expect(keyFor('pad', 'respawn', 'race')).toContain('pad-b');
    // No pad button in that context: the key stays.
    expect(keyFor('pad', 'debug', 'foot')).toBe('<kbd>F3</kbd>');
    expect(padLabel('jump', 'none')).toBe('');
    expect(dualKey('interact', 'foot')).toMatch(/kbm-only.*E.*pad-only.*pad-x/);
    expect(padText('a', 'ps')).toBe('✕');
    expect(padText('x', 'nintendo')).toBe('Y');
    expect(padText('left', 'xbox')).toBe('←');
  });

  it('renders every objective hint without leftover tokens, escaping the text', () => {
    for (const o of OBJECTIVES) {
      const out = renderTokens(o.hint);
      expect(out, o.id).not.toMatch(/\{\w+\}/);
    }
    expect(renderTokens('a < b {interact}')).toMatch(/^a &lt; b <span class="kbm-only"><kbd>E<\/kbd>/);
    expect(renderTokens('{hotkey2}')).toContain('(touche 2)');
    expect(renderTokens('{hotkey9}')).toContain('(touche 9)');
  });

  it('every building of the build menu has its number key (one digit: 9 at most)', () => {
    expect(BUILD_MENU.length).toBeLessThanOrEqual(9);
    BUILD_MENU.forEach((t, i) => expect(KEYBINDS, t).toHaveProperty(`hotbar${i + 1}`, [`Digit${i + 1}`]));
  });
});

describe('pad bindings', () => {
  it('bind only known actions, and no button twice in one context', () => {
    for (const [profile, binds] of Object.entries(PADBINDS)) {
      const seen = new Map<string, string>();
      for (const [action, buttons] of Object.entries(binds) as [Action, readonly string[]][]) {
        expect(KEYBINDS, `${profile}.${action}`).toHaveProperty(action);
        for (const b of buttons) {
          // Steering keys share the move keys on the keyboard; on the pad each button means one thing.
          expect(seen.get(b), `${profile}: ${b} on ${action} and ${seen.get(b)}`).toBeUndefined();
          seen.set(b, action);
        }
      }
    }
  });

  it('cover what the factory needs on foot and in a car', () => {
    const foot: Action[] = ['jump', 'interact', 'buildMenu', 'primary', 'secondary', 'rotate', 'rotateBack', 'dismantle', 'inventory', 'pause', 'sprint', 'prevTool', 'nextTool'];
    for (const a of foot) expect(PADBINDS.foot[a], a).toBeDefined();
    for (const a of ['handbrake', 'interact', 'retry', 'respawn', 'pause'] as Action[]) expect(PADBINDS.drive[a], a).toBeDefined();
    // Getting in and out of a car is the same button on foot and at the wheel.
    expect(PADBINDS.drive.interact).toEqual(PADBINDS.foot.interact);
    for (const a of ['handbrake', 'respawn', 'restart', 'cancel'] as Action[]) expect(PADBINDS.race[a], a).toBeDefined();
  });
});
