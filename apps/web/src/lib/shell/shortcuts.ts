import { RAIL_SHORTCUT_RE } from '@crewhall/shared';
import { useSyncExternalStore } from 'react';

/**
 * The rail's keyboard scheme. Two shapes only, because every other key is somebody's: Ctrl and Cmd
 * combinations belong to the browser and the OS, single letters to the page, and Alt alone to
 * browser menus on Windows and to typing on macOS.
 * - `g c`: G then a letter or digit, outside text fields, as in many web apps.
 * - `alt+shift+c`: works from anywhere but text fields too, and is free in browsers and OSes.
 * '' means the person removed the shortcut of that entry.
 */
export type RailCombo = string;

/** Out-of-the-box shortcuts of rail entries; a plugin or new entry has none until assigned. */
export const DEFAULT_RAIL_SHORTCUTS: Readonly<Record<string, RailCombo>> = {
  home: 'g h',
  chat: 'g c',
  drive: 'g d',
  pages: 'g p',
  boards: 'g b',
  drawings: 'g r',
  meet: 'g m',
  calendar: 'g t',
  contacts: 'g k',
  vault: 'g v',
  tables: 'g l',
  forms: 'g f',
  automations: 'g a',
  mail: 'g e',
  tools: 'g x',
  announcements: 'g n',
  portal: 'g o',
  admin: 'g y',
};

/** What an entry answers to: the person's choice, else the default. */
export function shortcutOf(
  id: string,
  mine: Readonly<Record<string, string>> | undefined,
): RailCombo {
  return mine?.[id] ?? DEFAULT_RAIL_SHORTCUTS[id] ?? '';
}

export function comboLabel(combo: RailCombo): string[] {
  if (!combo) return [];
  if (combo.startsWith('g ')) return ['G', combo.slice(2).toUpperCase()];
  return ['Alt', 'Shift', combo.slice('alt+shift+'.length).toUpperCase()];
}

/** The letter or digit of a key press, whatever Alt and Shift made of it on this layout. */
function keyOfCode(code: string): string | null {
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
  return m ? (m[1] ?? m[2]!).toLowerCase() : null;
}

/** Keys that only modify or navigate: the recorder waits on while these are pressed. */
const WAIT_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Tab']);

export type Recorded = { combo: RailCombo } | { reserved: true } | { waiting: true };

/**
 * The shortcut a key press in the settings stands for: a plain letter or digit becomes "G then
 * that key", Alt Shift plus one stays as it is, anything else clashes with the browser or the OS.
 */
export function recordCombo(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey'>,
): Recorded {
  if (WAIT_KEYS.has(e.key)) return { waiting: true };
  if (e.ctrlKey || e.metaKey) return { reserved: true };
  if (e.altKey && e.shiftKey) {
    const key = keyOfCode(e.code);
    return key ? { combo: `alt+shift+${key}` } : { reserved: true };
  }
  if (e.altKey || e.shiftKey) return { reserved: true };
  const combo = `g ${e.key.toLowerCase()}`;
  return RAIL_SHORTCUT_RE.test(combo) ? { combo } : { reserved: true };
}

/** Typing, or a widget whose keys are its own: no global shortcut here. */
export function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="grid"], [role="application"], .cm-editor, .excalidraw',
    ),
  );
}

/** How long G waits for its second key. */
export const CHORD_MS = 1200;

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

let helpOpen = false;
const listeners = new Set<() => void>();

/** The list of keys (components/shell/KeyboardShortcuts). */
export function setKeyboardHelpOpen(open: boolean): void {
  helpOpen = open;
  listeners.forEach((l) => l());
}

export function useKeyboardHelpOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => helpOpen,
  );
}
