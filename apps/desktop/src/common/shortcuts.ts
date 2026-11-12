/** The part of Electron's before-input-event input the shortcuts look at. */
export interface KeyInput {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  isAutoRepeat?: boolean;
}

/**
 * Reload shortcuts of the app's windows, without a menu (Windows has none, so menu accelerators
 * never fire): Ctrl+R / F5 reload, Ctrl+Shift+R / Ctrl+F5 / Shift+F5 reload ignoring the cache
 * (a new web version the cache still hides). Cmd instead of Ctrl on macOS.
 */
export function reloadShortcut(i: KeyInput, platform: string): 'reload' | 'hard' | null {
  if (i.type !== 'keyDown' || i.alt || i.isAutoRepeat) return null;
  const key = i.key.toLowerCase();
  if (key === 'f5') return i.control || i.meta || i.shift ? 'hard' : 'reload';
  const mod = platform === 'darwin' ? i.meta : i.control;
  if (mod && key === 'r') return i.shift ? 'hard' : 'reload';
  return null;
}
