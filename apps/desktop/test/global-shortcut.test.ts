import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GLOBAL_SHORTCUT,
  GlobalShortcut,
  acceleratorFromKey,
  formatShortcut,
  shortcutProblem,
  type KeyPress,
} from '../src/common/global-shortcut';

const press = (code: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('reading a shortcut from the keyboard', () => {
  it('waits for a real key and writes the combination out', () => {
    expect(acceleratorFromKey(press('ControlLeft', { ctrlKey: true }), 'win32')).toBeNull();
    expect(acceleratorFromKey(press('KeyY', { ctrlKey: true, shiftKey: true }), 'win32')).toBe(
      'CommandOrControl+Shift+Y',
    );
    expect(acceleratorFromKey(press('Digit1', { altKey: true }), 'win32')).toBe('Alt+1');
    expect(acceleratorFromKey(press('F9'), 'win32')).toBe('F9');
  });

  it('uses Cmd as the main modifier on macOS', () => {
    expect(acceleratorFromKey(press('KeyY', { metaKey: true }), 'darwin')).toBe(
      'CommandOrControl+Y',
    );
    expect(acceleratorFromKey(press('KeyY', { ctrlKey: true }), 'darwin')).toBe('Control+Y');
  });

  it('does not take keys that differ per layout', () => {
    expect(acceleratorFromKey(press('Semicolon', { ctrlKey: true }), 'win32')).toBeNull();
  });
});

describe('which shortcuts are allowed', () => {
  it('accepts the default on every platform', () => {
    for (const p of ['win32', 'darwin', 'linux']) {
      expect(shortcutProblem(DEFAULT_GLOBAL_SHORTCUT, p)).toBeNull();
    }
  });

  it('needs a real modifier, except for function keys', () => {
    expect(shortcutProblem('Y', 'win32')).toBe('invalid');
    expect(shortcutProblem('Shift+Y', 'win32')).toBe('invalid');
    expect(shortcutProblem('F9', 'win32')).toBeNull();
    expect(shortcutProblem('Bogus+Y', 'win32')).toBe('invalid');
  });

  it('refuses what the system or text editing uses', () => {
    expect(shortcutProblem('CommandOrControl+C', 'win32')).toBe('reserved');
    expect(shortcutProblem('Alt+F4', 'win32')).toBe('reserved');
    expect(shortcutProblem('Super+Y', 'win32')).toBe('reserved');
  });

  it("refuses Crewhall's own shortcuts", () => {
    expect(shortcutProblem('CommandOrControl+K', 'win32')).toBe('inApp');
    expect(shortcutProblem('CommandOrControl+Shift+M', 'darwin')).toBe('inApp');
    expect(shortcutProblem('Alt+Shift+8', 'win32')).toBe('inApp');
    expect(shortcutProblem('Alt+Shift+F2', 'win32')).toBeNull();
  });

  it('refuses Ctrl+Alt on Windows, where it is AltGr', () => {
    expect(shortcutProblem('CommandOrControl+Alt+Q', 'win32')).toBe('altGr');
    expect(shortcutProblem('CommandOrControl+Alt+Q', 'darwin')).toBeNull();
  });
});

describe('showing a shortcut', () => {
  it('reads like the keyboard of this computer', () => {
    expect(formatShortcut('CommandOrControl+Shift+Y', 'win32')).toBe('Ctrl + Shift + Y');
    expect(formatShortcut('CommandOrControl+Shift+Y', 'darwin')).toBe('⌘⇧Y');
  });
});

describe('keeping the shortcut registered', () => {
  function setup(takenByOthers: string[] = []) {
    const taken = new Set(takenByOthers);
    const held = new Set<string>();
    const registrar = {
      register: vi.fn((a: string) => {
        if (taken.has(a)) return false;
        held.add(a);
        return true;
      }),
      unregister: vi.fn((a: string) => void held.delete(a)),
    };
    const run = vi.fn();
    return { shortcut: new GlobalShortcut(registrar, run, 'win32'), registrar, held, taken };
  }

  it('registers at startup and does nothing when switched off', () => {
    const { shortcut, held } = setup();
    expect(shortcut.apply('Alt+1')).toEqual({ state: 'active', accelerator: 'Alt+1' });
    expect(held.has('Alt+1')).toBe(true);
    expect(shortcut.apply(null)).toEqual({ state: 'off', accelerator: null });
    expect(held.size).toBe(0);
  });

  it('says so when another program holds it, and takes it once that program is gone', () => {
    const { shortcut, taken } = setup(['Alt+1']);
    expect(shortcut.apply('Alt+1')).toEqual({ state: 'taken', accelerator: 'Alt+1' });
    taken.clear();
    expect(shortcut.apply('Alt+1')).toEqual({ state: 'active', accelerator: 'Alt+1' });
  });

  it('keeps the old shortcut when the new one is taken', () => {
    const { shortcut, held } = setup(['Alt+2']);
    shortcut.apply('Alt+1');
    expect(shortcut.change('Alt+2')).toEqual({ ok: false, error: 'taken' });
    expect(held.has('Alt+1')).toBe(true);
    expect(shortcut.status()).toEqual({ state: 'active', accelerator: 'Alt+1' });
  });

  it('swaps only after the new one is ours', () => {
    const { shortcut, held, registrar } = setup();
    shortcut.apply('Alt+1');
    expect(shortcut.change('Alt+2')).toEqual({ ok: true });
    expect(registrar.unregister).toHaveBeenCalledWith('Alt+1');
    expect([...held]).toEqual(['Alt+2']);
    expect(shortcut.status()).toEqual({ state: 'active', accelerator: 'Alt+2' });
  });

  it('refuses a bad shortcut without touching the system', () => {
    const { shortcut, registrar } = setup();
    expect(shortcut.change('CommandOrControl+C')).toEqual({ ok: false, error: 'reserved' });
    expect(registrar.register).not.toHaveBeenCalled();
  });

  it('survives an accelerator Electron cannot read', () => {
    const { shortcut, registrar } = setup();
    registrar.register.mockImplementation(() => {
      throw new Error('bad accelerator');
    });
    expect(shortcut.apply('nonsense')).toEqual({ state: 'taken', accelerator: 'nonsense' });
  });
});
