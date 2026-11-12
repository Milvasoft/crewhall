import { describe, expect, it } from 'vitest';
import { reloadShortcut, type KeyInput } from '../src/common/shortcuts';

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  type: 'keyDown',
  key: k,
  control: false,
  meta: false,
  shift: false,
  alt: false,
  ...mods,
});

describe('reload shortcuts (no menu on Windows)', () => {
  it('reloads with Ctrl+R and F5', () => {
    expect(reloadShortcut(key('r', { control: true }), 'win32')).toBe('reload');
    expect(reloadShortcut(key('R', { control: true }), 'win32')).toBe('reload');
    expect(reloadShortcut(key('F5'), 'win32')).toBe('reload');
  });

  it('reloads ignoring the cache with Ctrl+Shift+R, Ctrl+F5 and Shift+F5', () => {
    expect(reloadShortcut(key('R', { control: true, shift: true }), 'win32')).toBe('hard');
    expect(reloadShortcut(key('F5', { control: true }), 'win32')).toBe('hard');
    expect(reloadShortcut(key('F5', { shift: true }), 'win32')).toBe('hard');
  });

  it('uses Cmd on macOS', () => {
    expect(reloadShortcut(key('r', { meta: true }), 'darwin')).toBe('reload');
    expect(reloadShortcut(key('r', { meta: true, shift: true }), 'darwin')).toBe('hard');
    expect(reloadShortcut(key('r', { control: true }), 'darwin')).toBeNull();
  });

  it('leaves other keys, key-up, repeats and Alt combinations alone', () => {
    expect(reloadShortcut(key('r'), 'win32')).toBeNull();
    expect(reloadShortcut(key('r', { control: true, alt: true }), 'win32')).toBeNull();
    expect(reloadShortcut({ ...key('r', { control: true }), type: 'keyUp' }, 'win32')).toBeNull();
    expect(reloadShortcut(key('F5', { isAutoRepeat: true }), 'win32')).toBeNull();
    expect(reloadShortcut(key('t', { control: true }), 'win32')).toBeNull();
  });
});
