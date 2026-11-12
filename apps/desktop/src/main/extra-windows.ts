import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { OPEN_WINDOW_CHANNEL } from '../common/client';
import { sameAppPage, windowOpenDecision } from '../common/window-policy';
import type { DesktopApp } from './app';
import { createExtraWindow } from './windows';

/** More than this is a mistake, not a way of working: the next one goes to the main window. */
const MAX_WINDOWS = 8;

/**
 * Further windows of the app, opened only by the person: a middle click on a link or "Yeni
 * pencerede aç" in a menu. Unlike the main window, closing one really closes it.
 */
export class ExtraWindows {
  private readonly windows = new Set<BrowserWindow>();

  constructor(private readonly d: DesktopApp) {}

  has(contents: WebContents): boolean {
    return [...this.windows].some((w) => !w.isDestroyed() && w.webContents === contents);
  }

  anyFocused(): boolean {
    return [...this.windows].some((w) => !w.isDestroyed() && w.isFocused());
  }

  register(): void {
    ipcMain.handle(OPEN_WINDOW_CHANNEL, (e, url: unknown) => {
      if (!this.d.isAppPage(e.sender) || typeof url !== 'string') return false;
      return this.openUrl(url);
    });
  }

  /** A link of the server's own pages, absolute or a bare path; false for anything else. */
  openUrl(url: string): boolean {
    const origin = this.d.origin;
    if (!origin) return false;
    let absolute: string;
    try {
      absolute = new URL(url, origin).href;
    } catch {
      return false;
    }
    const decision = windowOpenDecision(absolute, origin);
    if (decision.kind === 'meeting') return this.d.meetings.open(decision.url);
    if (decision.kind !== 'navigate') return false;
    this.open(decision.path);
    return true;
  }

  /** Opens `path` in a new window, or brings up the window that already shows it. */
  open(path: string): void {
    const origin = this.d.origin;
    if (!origin) return;
    const target = this.d.serverPath(path);
    const open = [...this.windows].filter((w) => !w.isDestroyed());
    const same = open.find((w) => sameAppPage(w.webContents.getURL(), target, origin));
    if (same) {
      if (same.isMinimized()) same.restore();
      same.show();
      same.focus();
      return;
    }
    if (open.length >= MAX_WINDOWS) {
      this.d.showMain();
      this.d.navigate(path);
      return;
    }
    const from = BrowserWindow.getFocusedWindow() ?? this.d.main;
    const near = from && !from.isDestroyed() ? from.getNormalBounds() : null;
    const win = createExtraWindow(this.d, origin, target, near);
    this.windows.add(win);
    win.on('closed', () => this.windows.delete(win));
  }

  closeAll(): void {
    for (const win of this.windows) if (!win.isDestroyed()) win.destroy();
    this.windows.clear();
  }
}
