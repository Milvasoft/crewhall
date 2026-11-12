import { MeetControlMessage, type MeetControlInput } from '@crewhall/shared';

/**
 * Remote control of a shared screen ("Denetimi ver"), the sharer's desktop side. The meeting page
 * owns the protocol (packages/shared `MeetControlMessage`): it shows who asks, posts grant, deny
 * and revoke and writes the audit log. The desktop app applies the input of the person the page
 * granted, shows that someone is in control, and asks the page to revoke when the sharer takes
 * control back. No Electron or native code here: those are injected, so every rule is tested.
 */

export type ControlInput = MeetControlInput;
type KeyInput = Extract<ControlInput, { k: 'key' }>;

export function parseControlMessage(json: string): MeetControlMessage | null {
  try {
    const parsed = MeetControlMessage.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---- coordinates ----------------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A point in the shared frame (0..1 on both axes) to the display's global coordinates in DIP
 * (Electron's `screen` space; the native layer converts to physical pixels where it must).
 * Clamped to the display so a stray value never lands on another monitor.
 */
export function framePointToScreen(x: number, y: number, display: Rect): { x: number; y: number } {
  const cx = Math.min(1, Math.max(0, x));
  const cy = Math.min(1, Math.max(0, y));
  return {
    x: Math.round(display.x + cx * (display.width - 1)),
    y: Math.round(display.y + cy * (display.height - 1)),
  };
}

// ---- keyboard -------------------------------------------------------------------------------

export type DesktopOs = 'win32' | 'darwin' | 'linux';

/**
 * System shortcuts a remote person must never trigger: the secure attention sequence, task
 * manager / force quit, lock, the Windows key and its combinations, and our own revoke shortcut.
 */
export function isBlockedKey(ev: KeyInput, os: DesktopOs): boolean {
  const { code } = ev;
  const m = ev.mods;
  if (m.ctrl && m.alt && m.shift && code === 'KeyX') return true;
  if (m.ctrl && m.alt && (code === 'Delete' || code === 'NumpadDecimal' || code === 'End')) {
    return true;
  }
  if (m.ctrl && m.shift && code === 'Escape') return true;
  if (code === 'Power' || code === 'Sleep' || code === 'WakeUp' || code === 'Eject') return true;
  if (os === 'win32') {
    // The Windows key alone opens Start; with others it locks (L), runs (R), shows the desktop…
    if (code === 'MetaLeft' || code === 'MetaRight' || m.meta) return true;
  }
  if (os === 'darwin') {
    if (m.meta && m.alt && code === 'Escape') return true; // force quit
    if (m.meta && m.ctrl && (code === 'KeyQ' || code === 'Power')) return true; // lock, shut down
    if (m.meta && m.ctrl && m.alt && code === 'Eject') return true;
  }
  return false;
}

const NAMED: Record<string, string> = {
  Enter: 'enter',
  NumpadEnter: 'enter',
  Backspace: 'backspace',
  Tab: 'tab',
  Escape: 'escape',
  Space: 'space',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ShiftLeft: 'shift',
  ShiftRight: 'right_shift',
  ControlLeft: 'control',
  ControlRight: 'right_control',
  AltLeft: 'alt',
  AltRight: 'right_alt',
  MetaLeft: 'command',
  MetaRight: 'command',
  CapsLock: 'capslock',
  PrintScreen: 'printscreen',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  NumpadAdd: 'numpad_+',
  NumpadSubtract: 'numpad_-',
  NumpadMultiply: 'numpad_*',
  NumpadDivide: 'numpad_/',
  NumpadDecimal: 'numpad_.',
};

/**
 * robotjs key name for a KeyboardEvent.code. Physical codes (not the produced character), so the
 * controller's keyboard layout does not matter; text goes as `text` events instead.
 */
export function robotKeyName(code: string): string | null {
  if (NAMED[code]) return NAMED[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1]!.toLowerCase();
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1]!;
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return `numpad_${m[1]}`;
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (m) return `f${m[1]}`;
  return null;
}

export function robotModifiers(mods: Partial<KeyInput['mods']>): string[] {
  const out: string[] = [];
  if (mods.ctrl) out.push('control');
  if (mods.alt) out.push('alt');
  if (mods.shift) out.push('shift');
  if (mods.meta) out.push('command');
  return out;
}

// ---- session --------------------------------------------------------------------------------

/**
 * Browser wheel deltas (pixels, positive = down/right) to robotjs `scrollMouse` arguments:
 * Windows wants wheel units (120 a notch, positive = up/right), macOS pixels (positive =
 * up/left), X11 whole notches (positive = up/left).
 */
export function scrollUnits(os: DesktopOs, dx: number, dy: number): { x: number; y: number } {
  if (os === 'win32') return { x: Math.round(dx * 1.2), y: Math.round(-dy * 1.2) };
  if (os === 'darwin') return { x: Math.round(-dx), y: Math.round(-dy) };
  const notches = (v: number) =>
    v === 0 ? 0 : Math.sign(v) * Math.max(1, Math.round(Math.abs(v) / 100));
  return { x: -notches(dx), y: -notches(dy) };
}

/** What the native layer does; tested with a fake, implemented with robotjs. */
export interface InputDriver {
  /** Global DIP coordinates (Electron's `screen` space). */
  move(x: number, y: number): void;
  button(button: 'left' | 'middle' | 'right', down: boolean): void;
  /** Browser wheel deltas in pixels, positive = down/right. */
  scroll(dx: number, dy: number): void;
  key(name: string, down: boolean, modifiers: string[]): void;
  type(text: string): void;
}

export interface SharedDisplay {
  /** Electron display id. */
  id: number;
  bounds: Rect;
}

/** Why the sharer's app wants control back (the page then revokes it). */
export type RevokeReason =
  | 'stopped' // the Stop button or the shortcut
  | 'local_input' // the sharer used their own mouse
  | 'share_ended'
  | 'not_allowed'
  | 'permission'; // the OS does not let the app inject input (macOS Accessibility)

export interface Controller {
  identity: string;
  name: string;
}

export interface SessionDeps {
  os: DesktopOs;
  driver: InputDriver;
  /** The OS lets the app inject input (macOS Accessibility). */
  canInject: () => boolean;
  /** Shows the "<name> is controlling your screen · Stop" band, or hides it (null). */
  onController: (controller: Controller | null, display: SharedDisplay | null) => void;
  /** Asks the meeting page to revoke (it posts `revoke` and records it). */
  requestRevoke: (reason: RevokeReason) => void;
  /** The point the app moved the pointer to last, so local mouse use can be told apart. */
  onInjectedPointer?: (point: { x: number; y: number }) => void;
}

const BUTTONS = ['left', 'middle', 'right'] as const;

export class RemoteControlSession {
  private display: SharedDisplay | null = null;
  private allowed = true;
  private controller: Controller | null = null;
  /** Keys held down by the controller, released when control ends so none stays stuck. */
  private held = new Map<string, string[]>();
  private buttons = new Set<'left' | 'middle' | 'right'>();

  constructor(private readonly d: SessionDeps) {}

  get current(): Controller | null {
    return this.controller;
  }

  get sharing(): SharedDisplay | null {
    return this.display;
  }

  /** A whole screen is shared (display) or not (null: nothing, or a window). */
  setShare(display: SharedDisplay | null): void {
    this.display = display;
    if (!display) this.stop('share_ended');
  }

  /** Org or moderator switched remote control off (or on). */
  setAllowed(allowed: boolean): void {
    this.allowed = allowed;
    if (!allowed) this.stop('not_allowed');
  }

  /**
   * The page granted control (or took it away: null). A grant the app cannot honour (no whole
   * screen shared, switched off, no OS permission) is handed straight back.
   */
  setController(controller: Controller | null): void {
    if (!controller) {
      this.clear();
      return;
    }
    if (this.controller?.identity === controller.identity) return;
    const problem: RevokeReason | null = !this.display
      ? 'share_ended'
      : !this.allowed
        ? 'not_allowed'
        : !this.d.canInject()
          ? 'permission'
          : null;
    this.clear();
    if (problem) {
      this.d.requestRevoke(problem);
      return;
    }
    this.controller = controller;
    this.d.onController(controller, this.display);
  }

  /** A message on `meet.control`; only the controller's input is applied. */
  receive(from: string, message: MeetControlMessage): void {
    if (message.type !== 'input') return;
    if (this.controller?.identity !== from || !this.display) return;
    this.apply(message.ev, this.display);
  }

  /** The sharer takes control back: stop applying at once and ask the page to revoke. */
  stop(reason: RevokeReason): void {
    if (!this.controller) return;
    this.clear();
    this.d.requestRevoke(reason);
  }

  /** Control is gone (the page revoked, the controller released or left): just stop. */
  clear(): void {
    if (!this.controller) return;
    this.releaseHeld();
    this.controller = null;
    this.d.onController(null, null);
  }

  private releaseHeld(): void {
    for (const [name, mods] of this.held) {
      try {
        this.d.driver.key(name, false, mods);
      } catch {
        // best effort
      }
    }
    this.held.clear();
    for (const b of this.buttons) {
      try {
        this.d.driver.button(b, false);
      } catch {
        // best effort
      }
    }
    this.buttons.clear();
  }

  private apply(ev: ControlInput, display: SharedDisplay): void {
    const drv = this.d.driver;
    switch (ev.k) {
      case 'move': {
        const p = framePointToScreen(ev.x, ev.y, display.bounds);
        drv.move(p.x, p.y);
        this.d.onInjectedPointer?.(p);
        return;
      }
      case 'down':
      case 'up': {
        const button = BUTTONS[ev.b];
        const p = framePointToScreen(ev.x, ev.y, display.bounds);
        drv.move(p.x, p.y);
        this.d.onInjectedPointer?.(p);
        drv.button(button, ev.k === 'down');
        if (ev.k === 'down') this.buttons.add(button);
        else this.buttons.delete(button);
        return;
      }
      case 'wheel': {
        const clamp = (v: number) => Math.max(-1000, Math.min(1000, v));
        drv.scroll(clamp(ev.dx), clamp(ev.dy));
        return;
      }
      case 'key': {
        if (isBlockedKey(ev, this.d.os)) return;
        const name = robotKeyName(ev.code);
        if (!name) return;
        const mods = robotModifiers(ev.mods);
        drv.key(name, ev.down, mods);
        if (ev.down) this.held.set(name, mods);
        else this.held.delete(name);
        return;
      }
      case 'text': {
        drv.type(ev.text);
        return;
      }
    }
  }
}

/**
 * Tells the sharer's own mouse from the injected one: after the app moves the pointer, the cursor
 * must stay there; a cursor somewhere else (beyond a few pixels) that the app did not put there
 * means the sharer moved the mouse.
 */
export class LocalPointerWatch {
  private expected: { x: number; y: number } | null = null;
  private injectedAt = 0;

  constructor(
    private readonly tolerance = 4,
    private readonly settleMs = 120,
  ) {}

  injected(point: { x: number; y: number }, now = Date.now()): void {
    this.expected = point;
    this.injectedAt = now;
  }

  reset(): void {
    this.expected = null;
  }

  /** True when the cursor moved on its own (call on a short interval while controlled). */
  movedLocally(cursor: { x: number; y: number }, now = Date.now()): boolean {
    if (!this.expected) {
      this.expected = cursor;
      return false;
    }
    if (now - this.injectedAt < this.settleMs) return false;
    const far =
      Math.abs(cursor.x - this.expected.x) > this.tolerance ||
      Math.abs(cursor.y - this.expected.y) > this.tolerance;
    return far;
  }
}
