/**
 * The system-wide shortcut that opens or focuses the app. Kept apart from Electron: what the
 * main process does with it is `main/app.ts` (`globalShortcut` is the registrar).
 */

/** Ctrl+Alt is AltGr on many layouts (@ on a Turkish keyboard), so the default stays off it. */
export const DEFAULT_GLOBAL_SHORTCUT = 'CommandOrControl+Shift+Y';

export type ShortcutProblem =
  /** No Ctrl, Cmd or Alt, or a key we do not take. */
  | 'invalid'
  /** The system's, or one everyone uses for editing text. */
  | 'reserved'
  /** Ctrl+Alt on Windows: the same as AltGr, it would swallow typed characters. */
  | 'altGr'
  /** Used inside Crewhall (the command palette, reload...). */
  | 'inApp'
  /** Another program holds it. */
  | 'taken';

export type ShortcutStatus =
  | { state: 'off'; accelerator: null }
  | { state: 'active'; accelerator: string }
  /** Saved, but another program holds it right now. */
  | { state: 'taken'; accelerator: string };

/** The part of a keydown event a shortcut is made from. */
export interface KeyPress {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Keys by position, not by letter: `code` does not change with the keyboard layout's modifiers. */
function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!;
  const fn = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (fn) return code;
  return code === 'Space' ? 'Space' : null;
}

const isModifier = (code: string) => /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code);

/**
 * The accelerator for a key press in the settings window. Null while only modifiers are down or
 * for a key we do not take.
 */
export function acceleratorFromKey(e: KeyPress, platform: string): string | null {
  if (isModifier(e.code)) return null;
  const key = keyName(e.code);
  if (!key) return null;
  const mac = platform === 'darwin';
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push('CommandOrControl');
  if (mac && e.ctrlKey) parts.push('Control');
  if (!mac && e.metaKey) parts.push('Super');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** Shortcuts the OS keeps, and the ones people use all day to edit text. */
const RESERVED = new Set(
  [
    'CommandOrControl+A',
    'CommandOrControl+C',
    'CommandOrControl+V',
    'CommandOrControl+X',
    'CommandOrControl+Z',
    'CommandOrControl+Y',
    'CommandOrControl+S',
    'CommandOrControl+P',
    'CommandOrControl+F',
    'CommandOrControl+N',
    'CommandOrControl+O',
    'CommandOrControl+T',
    'CommandOrControl+W',
    'CommandOrControl+Q',
    'CommandOrControl+Shift+Z',
    'CommandOrControl+Shift+Esc',
    'Alt+F4',
    'Alt+Space',
    'CommandOrControl+Space',
    'Super+Space',
  ].map((a) => a.toLowerCase()),
);

/** Shortcuts Crewhall itself listens for (web CommandPalette, AskPanel; common/shortcuts). */
const IN_APP = new Set(
  [
    'CommandOrControl+K',
    'CommandOrControl+J',
    'CommandOrControl+E',
    'CommandOrControl+R',
    'CommandOrControl+Shift+R',
    'CommandOrControl+Shift+M',
    'CommandOrControl+F5',
    'F5',
  ].map((a) => a.toLowerCase()),
);

/** What is wrong with this as a shortcut, before trying to register it. */
export function shortcutProblem(accelerator: string, platform: string): ShortcutProblem | null {
  const parts = accelerator.split('+');
  const key = parts.at(-1) ?? '';
  const mods = parts.slice(0, -1);
  const known = ['CommandOrControl', 'Control', 'Super', 'Alt', 'Shift'];
  if (!mods.every((m) => known.includes(m))) return 'invalid';
  if (
    !keyName(
      key === 'Space'
        ? 'Space'
        : /^[A-Z]$/.test(key)
          ? `Key${key}`
          : /^[0-9]$/.test(key)
            ? `Digit${key}`
            : key,
    )
  ) {
    return 'invalid';
  }
  // Function keys may stand alone or with Shift; everything else needs a real modifier.
  const strong = mods.some((m) => m !== 'Shift');
  if (!strong && !/^F\d+$/.test(key)) return 'invalid';
  const lower = accelerator.toLowerCase();
  if (RESERVED.has(lower)) return 'reserved';
  if (platform !== 'darwin' && mods.includes('Super')) return 'reserved';
  // The web's own keyboard scheme: Alt+Shift plus a letter or digit opens a module.
  if (IN_APP.has(lower) || /^alt\+shift\+[a-z0-9]$/.test(lower)) return 'inApp';
  if (platform === 'win32' && mods.includes('CommandOrControl') && mods.includes('Alt')) {
    return 'altGr';
  }
  return null;
}

const MAC_SYMBOL: Record<string, string> = {
  CommandOrControl: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
};
const PC_NAME: Record<string, string> = { CommandOrControl: 'Ctrl', Control: 'Ctrl', Super: 'Win' };

/** How the shortcut reads on this computer: "Ctrl + Shift + Y", "⌘⇧Y". */
export function formatShortcut(accelerator: string, platform: string): string {
  const parts = accelerator.split('+');
  if (platform === 'darwin') return parts.map((p) => MAC_SYMBOL[p] ?? p).join('');
  return parts.map((p) => PC_NAME[p] ?? p).join(' + ');
}

/** `globalShortcut` in the app; false when another program holds it. */
export interface ShortcutRegistrar {
  register(accelerator: string, run: () => void): boolean;
  unregister(accelerator: string): void;
}

/**
 * Keeps one shortcut registered. A new one only replaces the old once it is really ours, so a
 * conflict leaves the person with the shortcut they had.
 */
export class GlobalShortcut {
  private held: string | null = null;
  private wanted: string | null = null;

  constructor(
    private readonly registrar: ShortcutRegistrar,
    private readonly run: () => void,
    private readonly platform: string,
  ) {}

  /** At startup, and on the settings screen (the other program may have gone). */
  apply(accelerator: string | null): ShortcutStatus {
    this.wanted = accelerator;
    if (this.held && this.held !== accelerator) {
      this.registrar.unregister(this.held);
      this.held = null;
    }
    if (accelerator && this.held !== accelerator && this.tryRegister(accelerator)) {
      this.held = accelerator;
    }
    return this.status();
  }

  /** Changes the shortcut; on a problem nothing changes. */
  change(accelerator: string): { ok: true } | { ok: false; error: ShortcutProblem } {
    const problem = shortcutProblem(accelerator, this.platform);
    if (problem) return { ok: false, error: problem };
    if (accelerator === this.held) return { ok: true };
    if (!this.tryRegister(accelerator)) return { ok: false, error: 'taken' };
    if (this.held) this.registrar.unregister(this.held);
    this.held = accelerator;
    this.wanted = accelerator;
    return { ok: true };
  }

  status(): ShortcutStatus {
    if (!this.wanted) return { state: 'off', accelerator: null };
    return { state: this.held === this.wanted ? 'active' : 'taken', accelerator: this.wanted };
  }

  private tryRegister(accelerator: string): boolean {
    try {
      return this.registrar.register(accelerator, this.run);
    } catch {
      // Electron throws on an accelerator it cannot read (an edited settings file).
      return false;
    }
  }
}
