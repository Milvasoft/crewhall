import { BrowserWindow, ipcMain, shell, type WebContents } from 'electron';
import { FILES } from '../common/ipc';
import { fileNameOf, windowOpenDecision } from '../common/window-policy';
import type { DesktopApp } from './app';

/**
 * Our own files (an image, PDF or video a page opens as a pop-up, sonraki-isler "Masaüstünde
 * resim tarayıcıda açılıyor") never go to the browser. A page with the shared viewer (bridge
 * `onOpenFile`) gets them back and shows them inside the window. Only a page without one (an
 * older web app) falls back to a plain viewer window: one, reused, Chromium's own image, PDF and
 * media viewers, no preload, Esc closes it.
 */
export class ViewerWindow {
  private win: BrowserWindow | null = null;
  /** Pages (webContents ids) that show files in their own viewer. */
  private readonly listening = new Set<number>();

  constructor(private readonly d: DesktopApp) {}

  register(): void {
    ipcMain.on(FILES.listen, (e, on: unknown) => {
      if (!this.d.isAppPage(e.sender)) return;
      const contents = e.sender;
      if (on === true) {
        if (this.listening.has(contents.id)) return;
        this.listening.add(contents.id);
        const forget = () => this.listening.delete(contents.id);
        contents.once('destroyed', forget);
        // A new document has to say it again.
        contents.once('did-start-navigation', (details) => {
          if (details.isMainFrame && !details.isSameDocument) forget();
        });
      } else {
        this.listening.delete(contents.id);
      }
    });
  }

  /** Shows one of our files the page `from` opened: in its own viewer when it has one. */
  show(from: WebContents, url: string): void {
    if (this.listening.has(from.id) && !from.isDestroyed()) {
      from.send(FILES.open, { url, name: fileNameOf(url) });
      return;
    }
    this.open(url);
  }

  /** The plain viewer window (pages without their own viewer). */
  open(url: string): void {
    const origin = this.d.origin;
    if (!origin) return;
    let win = this.win;
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
        width: 1100,
        height: 800,
        show: false,
        title: this.d.appName,
        icon: this.d.icon,
        autoHideMenuBar: true,
        backgroundColor: '#0e0f0f',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      this.win = win;
      const contents = win.webContents;
      win.once('ready-to-show', () => win?.show());
      win.on('closed', () => (this.win = null));
      contents.on('before-input-event', (e, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') {
          e.preventDefault();
          win?.close();
        }
      });
      // Links inside a PDF go to the browser; the window only ever shows our files.
      contents.setWindowOpenHandler(({ url: next }) => {
        if (/^https?:/i.test(next)) void shell.openExternal(next);
        return { action: 'deny' };
      });
      contents.on('will-navigate', (e, next) => {
        if (windowOpenDecision(next, origin).kind === 'viewer') return;
        e.preventDefault();
        if (/^https?:/i.test(next)) void shell.openExternal(next);
      });
    } else {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    void win.loadURL(url);
  }
}
