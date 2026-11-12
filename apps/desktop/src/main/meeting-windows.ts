import { BrowserWindow, ipcMain, nativeImage, screen, type WebContents } from 'electron';
import { log, pathOnly } from './log';
import { MEETING } from '../common/ipc';
import {
  MEETING_WEB_PREFERENCES,
  closedItself,
  fitBounds,
  leftMeeting,
  meetingKey,
} from '../common/meeting';
import { LIVE_GREEN, discBitmap } from '../common/badge';
import type { DesktopApp } from './app';
import { PRELOAD } from './paths';
import { attachTitleBar, titleBarOptions } from './titlebar';
import { configureSession, guardWebPage } from './windows';

const secure = {
  preload: PRELOAD,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: true,
} as const;

interface Meeting {
  key: string;
  url: string;
  win: BrowserWindow;
}

/**
 * Meetings in their own window (like Teams): same session as the main window (signed in), own
 * remembered size and place, one window per meeting. Closing the main window to the tray leaves
 * meetings open. When a meeting window closes, or its page leaves the meeting, it closes and the
 * main window's page is told (`crewhallDesktop.onMeetingClosed`).
 */
export class MeetingWindows {
  private readonly meetings = new Map<string, Meeting>();
  private liveIcon = nativeImage.createEmpty();

  constructor(private readonly d: DesktopApp) {}

  get count(): number {
    return this.meetings.size;
  }

  /** Titles of open meetings, for the tray. */
  titles(): string[] {
    return [...this.meetings.values()].map((m) => m.win.webContents.getTitle());
  }

  /** Sends an event to every meeting window's page. */
  send(channel: string, ...args: unknown[]): void {
    for (const m of this.meetings.values()) {
      if (!m.win.isDestroyed()) m.win.webContents.send(channel, ...args);
    }
  }

  has(contents: WebContents): boolean {
    return [...this.meetings.values()].some((m) => m.win.webContents === contents);
  }

  register(): void {
    ipcMain.handle(MEETING.open, (e, url: unknown) => {
      if (!this.d.isAppPage(e.sender) || typeof url !== 'string') return false;
      return this.open(url);
    });
    ipcMain.handle(MEETING.kind, (e) => (this.has(e.sender) ? 'meeting' : 'main'));
  }

  /** Opens (or brings up) the meeting at `url`; false when it is not a page of the server. */
  open(url: string): boolean {
    const origin = this.d.origin;
    if (!origin) return false;
    // meetingKey also refuses other servers and unparsable addresses.
    const key = meetingKey(url, origin);
    if (!key) return false;
    const existing = this.meetings.get(key);
    if (existing && !existing.win.isDestroyed()) {
      if (existing.win.isMinimized()) existing.win.restore();
      existing.win.show();
      existing.win.focus();
      return true;
    }

    const bounds = fitBounds(
      this.d.settings.get().meetingBounds,
      screen.getAllDisplays().map((x) => x.workArea),
    );
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 640,
      minHeight: 420,
      show: false,
      title: this.d.t('desktop.meeting.inMeeting'),
      icon: this.d.icon,
      // The meeting room is dark; no white flash while it loads.
      backgroundColor: '#0d0e0f',
      autoHideMenuBar: true,
      // The meeting's header is the title bar (main/titlebar).
      ...titleBarOptions({ bg: '#0d0e0f', fg: '#F2F2F1' }),
      webPreferences: { ...secure, ...MEETING_WEB_PREFERENCES },
    });
    attachTitleBar(win);
    // Old or new address, loaded in the form this server serves (common/paths).
    const given = new URL(url, origin);
    const href = new URL(this.d.serverPath(`${given.pathname}${given.search}${given.hash}`), origin)
      .href;
    const meeting: Meeting = { key, url: href, win };
    this.meetings.set(key, meeting);
    const contents = win.webContents;
    // Same session as the main window; make sure camera and microphone rules are in place even
    // when the meeting opens before the main window ever loaded.
    configureSession(this.d, contents.session, origin);
    guardWebPage(this.d, contents, origin);

    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });
    // "Toplantıda · <meeting>" on the taskbar button.
    win.on('page-title-updated', (e, title) => {
      e.preventDefault();
      win.setTitle(this.title(title));
      this.d.tray.refresh();
    });
    // Why a meeting window closes, in the log file (main/log): "arama cevaplanınca pencere
    // kapanıyor" could not be reproduced on the web.
    let closing: string | null = null;
    log('meeting', `open ${pathOnly(meeting.url)} (key ${key})`);
    const onNavigate = (_e: unknown, url: string) => {
      log('meeting', `page at ${pathOnly(url)}`);
      if (leftMeeting(url, key, origin)) {
        closing = `left the meeting for ${pathOnly(url)}`;
        win.close();
      }
    };
    contents.on('did-navigate', onNavigate);
    contents.on('did-navigate-in-page', onNavigate);
    contents.on('did-fail-load', (_e, code, desc, url, mainFrame) => {
      if (mainFrame) log('meeting', `load failed ${code} ${desc} ${pathOnly(url)}`);
    });
    contents.on('render-process-gone', (_e, d) => log('meeting', `page crashed: ${d.reason}`));
    // window.close() from the page (the web leaves the meeting and closes its own tab).
    contents.on('dom-ready', () => {
      void contents
        .executeJavaScript(
          `(() => { const c = window.close.bind(window); window.close = () => { console.warn('[meeting] page called window.close at ' + location.pathname); c(); }; })()`,
        )
        .catch(() => undefined);
    });
    contents.on('console-message', (e) => {
      if (e.message.startsWith('[meeting]')) {
        if (closedItself(e.message)) closing ??= 'the page closed itself';
        log('meeting', e.message.slice(10));
      }
    });
    win.on('close', () => {
      log('meeting', `closing: ${closing ?? 'closed by the person or the app'}`);
      this.d.settings.update({ meetingBounds: win.getNormalBounds() });
    });
    win.on('closed', () => {
      this.meetings.delete(key);
      this.d.remote.endFor(contents);
      this.d.tellMainPage(MEETING.closed, meeting.url);
      this.d.tray.refresh();
    });

    if (process.platform === 'win32') {
      if (this.liveIcon.isEmpty()) {
        // A green dot over the taskbar button: this window is a live meeting.
        this.liveIcon = nativeImage.createFromBitmap(discBitmap(32, LIVE_GREEN), {
          width: 32,
          height: 32,
          scaleFactor: 2,
        });
      }
      win.setOverlayIcon(this.liveIcon, this.d.t('desktop.meeting.inMeeting'));
    }

    void win.loadURL(meeting.url);
    this.d.tray.refresh();
    return true;
  }

  /** Brings the latest meeting window up (tray "back to the meeting"). */
  focusLatest(): void {
    const last = [...this.meetings.values()].at(-1);
    if (!last || last.win.isDestroyed()) return;
    if (last.win.isMinimized()) last.win.restore();
    last.win.show();
    last.win.focus();
  }

  closeAll(): void {
    for (const m of this.meetings.values()) if (!m.win.isDestroyed()) m.win.destroy();
    this.meetings.clear();
  }

  private title(pageTitle: string): string {
    const label = this.d.t('desktop.meeting.inMeeting');
    return pageTitle && pageTitle !== label ? `${label} · ${pageTitle}` : label;
  }
}
