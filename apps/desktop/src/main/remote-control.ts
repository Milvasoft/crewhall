import {
  BrowserWindow,
  globalShortcut,
  ipcMain,
  screen,
  shell,
  systemPreferences,
  type Display,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import {
  LocalPointerWatch,
  RemoteControlSession,
  parseControlMessage,
  type Controller,
  type DesktopOs,
  type InputDriver,
  type RevokeReason,
  type SharedDisplay,
} from '../common/remote-control';
import { RC } from '../common/ipc';
import { isServerUrl } from '../common/server';
import type { DesktopApp } from './app';
import { createRobotDriver } from './input-driver';
import { openLocalWindow, lastScreenShare } from './windows';

/** Also in the banner text; Control on every OS so it never clashes with Cmd shortcuts. */
export const REVOKE_SHORTCUT = 'Control+Alt+Shift+X';
const ASK_TIMEOUT_MS = 30_000;
const WATCH_MS = 100;

const person = (v: unknown): Controller | null => {
  if (!v || typeof v !== 'object') return null;
  const { identity, name } = v as { identity?: unknown; name?: unknown };
  if (typeof identity !== 'string' || !identity) return null;
  const n = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : identity;
  return { identity, name: n };
};

/**
 * The sharer's side of remote control in the desktop app. The meeting page (main or a meeting
 * window) owns the protocol: it collects requests, posts grant/deny/revoke and records them. Here:
 * an always-on-top question for each request (answered back to the page, so the page's own prompt
 * and this one stay one decision), the input of the granted person, the "is controlling · Stop"
 * band, the revoke shortcut and the local-mouse watch.
 */
export class RemoteControlHost {
  private readonly os: DesktopOs;
  private readonly driver: InputDriver | null;
  private readonly session: RemoteControlSession;
  private readonly watch = new LocalPointerWatch();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The open question: whose request, and its window. */
  private consent: {
    who: Controller;
    win: BrowserWindow;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** Requests already put to the sharer (answered here or in the page). */
  private asked = new Set<string>();
  private overlays: BrowserWindow[] = [];
  private shareDisplayId: number | null = null;
  /** The page relaying control (its window may be the main one or a meeting window). */
  private page: WebContents | null = null;

  constructor(private readonly d: DesktopApp) {
    this.os = (
      ['win32', 'darwin'].includes(process.platform) ? process.platform : 'linux'
    ) as DesktopOs;
    this.driver = createRobotDriver(this.os);
    this.session = new RemoteControlSession({
      os: this.os,
      driver: this.driver ?? {
        move: () => undefined,
        button: () => undefined,
        scroll: () => undefined,
        key: () => undefined,
        type: () => undefined,
      },
      canInject: () => this.canInject(),
      onController: (controller, display) => this.onController(controller, display),
      requestRevoke: (reason) => this.requestRevoke(reason),
      onInjectedPointer: (p) => this.watch.injected(p),
    });
    screen.on('display-metrics-changed', () => this.refreshDisplay());
    screen.on('display-removed', () => this.refreshDisplay());
  }

  /** Native input works on this OS (the robotjs build is present). */
  get supported(): boolean {
    return this.driver !== null;
  }

  register(): void {
    // The meeting runs in the main window or in a meeting window; the last one that spoke is
    // where the answers go.
    const fromMeeting = (e: IpcMainEvent | IpcMainInvokeEvent) => {
      const origin = this.d.origin;
      const ok =
        !!origin && this.d.isAppPage(e.sender) && isServerUrl(e.senderFrame?.url ?? '', origin);
      if (ok && this.page !== e.sender) {
        // Another window took over (the meeting moved): whatever ran in the old one ends.
        if (this.page && !this.page.isDestroyed()) this.end();
        this.page = e.sender;
      }
      return ok;
    };
    ipcMain.handle(RC.share, (e, active: unknown) => {
      if (!fromMeeting(e)) return { controllable: false };
      return { controllable: this.shareChanged(active === true) };
    });
    ipcMain.on(RC.allowed, (e, allowed: unknown) => {
      if (fromMeeting(e)) this.session.setAllowed(allowed === true);
    });
    ipcMain.on(RC.requests, (e, list: unknown) => {
      if (!fromMeeting(e) || !Array.isArray(list)) return;
      this.requests(list.map(person).filter((p): p is Controller => p !== null));
    });
    ipcMain.on(RC.controller, (e, value: unknown) => {
      if (fromMeeting(e)) this.session.setController(person(value));
    });
    ipcMain.on(RC.input, (e, identity: unknown, json: unknown) => {
      if (!fromMeeting(e) || typeof identity !== 'string' || typeof json !== 'string') return;
      if (json.length > 8192) return;
      const message = parseControlMessage(json);
      if (message) this.session.receive(identity, message);
    });
    ipcMain.on(RC.end, (e) => {
      if (fromMeeting(e)) this.end();
    });
  }

  /** The page that relays control (main or a meeting window) reloaded, crashed or closed. */
  endFor(contents: WebContents): void {
    if (this.page === contents) this.end();
  }

  /** The page left the room or is gone: stop applying input; nothing to tell any more. */
  end(): void {
    this.closeConsent();
    this.asked.clear();
    this.session.clear();
    this.session.setShare(null);
    this.shareDisplayId = null;
  }

  /** Stop button on the band, or the shortcut. */
  stop(): void {
    this.session.stop('stopped');
  }

  /** "Ver" / "Reddet" in the question window: the page grants or denies. */
  answer(yes: boolean): void {
    const c = this.consent;
    // The permission window's "Kapat" also lands here.
    this.closeConsent();
    if (!c) return;
    const canGrant = yes && this.canInject();
    this.toPage(RC.answer, c.who.identity, canGrant);
  }

  openAccessibilitySettings(): void {
    if (this.os !== 'darwin') return;
    // Asks macOS to list the app (and prompts once), then opens the right settings pane.
    systemPreferences.isTrustedAccessibilityClient(true);
    void shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    );
  }

  private canInject(): boolean {
    if (!this.driver) return false;
    if (this.os === 'darwin') return systemPreferences.isTrustedAccessibilityClient(false);
    return true;
  }

  private toPage(channel: string, ...args: unknown[]): void {
    const page = this.page;
    if (page && !page.isDestroyed()) page.send(channel, ...args);
  }

  private requestRevoke(reason: RevokeReason): void {
    this.toPage(RC.revoke, reason);
    if (reason === 'permission') this.showPermission(null);
  }

  /**
   * The page's list of people asking. A new one gets the always-on-top question; one that left
   * the list (answered in the page, or gone) closes it.
   */
  private requests(list: Controller[]): void {
    const ids = new Set(list.map((p) => p.identity));
    for (const id of [...this.asked]) if (!ids.has(id)) this.asked.delete(id);
    if (this.consent && !ids.has(this.consent.who.identity)) this.closeConsent();
    if (this.consent || !this.session.sharing) return;
    const next = list.find((p) => !this.asked.has(p.identity));
    if (!next) return;
    this.asked.add(next.identity);
    if (this.os === 'darwin' && !this.canInject()) {
      // Cannot be granted: explain the permission, and say no to the page.
      this.showPermission(next);
      this.toPage(RC.answer, next.identity, false);
      return;
    }
    this.ask(next);
  }

  private display(): Display | null {
    const all = screen.getAllDisplays();
    if (this.shareDisplayId !== null) {
      const found = all.find((x) => x.id === this.shareDisplayId);
      if (found) return found;
    }
    // The OS did not say which screen: only safe when there is a single one.
    return all.length === 1 ? all[0]! : null;
  }

  private shared(): SharedDisplay | null {
    const display = this.display();
    return display ? { id: display.id, bounds: display.bounds } : null;
  }

  /** Returns whether this share can be controlled (a whole screen, native input available). */
  private shareChanged(active: boolean): boolean {
    const share = active ? lastScreenShare() : null;
    if (!share || !this.driver) {
      this.shareDisplayId = null;
      this.session.setShare(null);
      this.closeConsent();
      return false;
    }
    this.shareDisplayId = share.displayId;
    const shared = this.shared();
    this.session.setShare(shared);
    return shared !== null;
  }

  private refreshDisplay(): void {
    if (!this.session.sharing) return;
    const shared = this.shared();
    this.session.setShare(shared);
    if (shared && this.session.current) this.placeOverlays(this.session.current, shared);
  }

  private questionWindow(
    view: 'control-request' | 'control-permission',
    who: Controller | null,
  ): BrowserWindow {
    const display = this.display() ?? screen.getPrimaryDisplay();
    const width = 440;
    const height = view === 'control-permission' ? 250 : 220;
    const win = openLocalWindow(
      this.d,
      view,
      { name: who?.name ?? '', app: this.d.appName },
      {
        width,
        height,
        x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
        y: Math.round(display.workArea.y + 48),
        useContentSize: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
      },
    );
    win.setAlwaysOnTop(true, 'screen-saver');
    win.flashFrame(true);
    return win;
  }

  /** The sharer is probably looking at another app: the question comes on top of everything. */
  private ask(who: Controller): void {
    const win = this.questionWindow('control-request', who);
    const timer = setTimeout(() => this.answer(false), ASK_TIMEOUT_MS);
    this.consent = { who, win, timer };
    win.on('closed', () => {
      if (this.consent?.win === win) this.answer(false);
    });
  }

  private permissionWin: BrowserWindow | null = null;

  /** macOS without Accessibility: say why and offer the settings (closed with "Kapat"). */
  private showPermission(who: Controller | null): void {
    if (this.permissionWin && !this.permissionWin.isDestroyed()) {
      this.permissionWin.focus();
      return;
    }
    this.permissionWin = this.questionWindow('control-permission', who);
  }

  private closeConsent(): void {
    const c = this.consent;
    this.consent = null;
    if (c) {
      clearTimeout(c.timer);
      if (!c.win.isDestroyed()) c.win.destroy();
    }
    if (this.permissionWin && !this.permissionWin.isDestroyed()) this.permissionWin.destroy();
    this.permissionWin = null;
  }

  private onController(controller: Controller | null, display: SharedDisplay | null): void {
    this.closeOverlays();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    globalShortcut.unregister(REVOKE_SHORTCUT);
    this.watch.reset();
    if (!controller || !display) return;

    this.placeOverlays(controller, display);
    globalShortcut.register(REVOKE_SHORTCUT, () => this.stop());
    // The sharer touching their own mouse takes control back at once.
    this.timer = setInterval(() => {
      if (this.watch.movedLocally(screen.getCursorScreenPoint())) this.session.stop('local_input');
    }, WATCH_MS);
  }

  /** The band (top centre, always on top) and a frame around the controlled screen. */
  private placeOverlays(controller: Controller, display: SharedDisplay): void {
    this.closeOverlays();
    const b = display.bounds;
    const width = 460;
    const overlay = {
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
    } as const;
    const band = openLocalWindow(
      this.d,
      'control-banner',
      { name: controller.name },
      {
        ...overlay,
        width,
        height: 52,
        x: Math.round(b.x + (b.width - width) / 2),
        y: b.y + 8,
        movable: true,
      },
      { inactive: true },
    );
    const frame = openLocalWindow(
      this.d,
      'control-border',
      {},
      { ...overlay, ...b, movable: false },
      { inactive: true },
    );
    frame.setIgnoreMouseEvents(true);
    for (const w of [frame, band]) {
      w.setAlwaysOnTop(true, 'screen-saver');
      w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      // Kept out of the shared picture: the controller sees the screen, not our marks.
      w.setContentProtection(true);
    }
    this.overlays = [frame, band];
  }

  private closeOverlays(): void {
    for (const w of this.overlays) if (!w.isDestroyed()) w.destroy();
    this.overlays = [];
  }
}
