import { DEFAULT_THEME } from '@crewhall/shared';
import {
  BrowserWindow,
  desktopCapturer,
  session,
  shell,
  systemPreferences,
  webContents,
  type BrowserWindowConstructorOptions,
  type Rectangle,
  type Session,
  type WebContents,
} from 'electron';
import type { ScreenAccess, ScreenSource, View } from '../common/ipc';
import { isServerUrl } from '../common/server';
import type { DesktopApp } from './app';
import { attachContextMenu } from './menu';
import { PRELOAD, RENDERER_HTML, RENDERER_URL_PREFIX } from './paths';
import {
  allowPermissionCheck,
  allowPermissionRequest,
  macMediaAccess,
  screenAccessFor,
} from '../common/permissions';
import { asksForNewWindow, windowOpenDecision } from '../common/window-policy';
import { reloadShortcut } from '../common/shortcuts';
import { isOutdatedAnswer, withClientHeader } from '../common/client';
import { attachTitleBar, titleBarOptions } from './titlebar';
import { mayThrottle, mediaLogLine } from '../common/meeting';
import { log, pathOnly } from './log';

const secure = {
  preload: PRELOAD,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: true,
} as const;

/** Schemes handed to the OS instead of being opened in the app. */
const EXTERNAL = /^(https?|mailto|tel):/i;

/** A further window of the app (main/extra-windows): closing it really closes it. */
export function createExtraWindow(
  d: DesktopApp,
  origin: string,
  path: string,
  near: Rectangle | null,
): BrowserWindow {
  const win = new BrowserWindow({
    width: near?.width ?? 1280,
    height: near?.height ?? 820,
    // A little down and right of the one it came from, so both are seen.
    ...(near ? { x: near.x + 28, y: near.y + 28 } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: d.appName,
    icon: d.icon,
    backgroundColor: DEFAULT_THEME.light.bg,
    autoHideMenuBar: true,
    ...titleBarOptions(),
    webPreferences: secure,
  });
  attachTitleBar(win);
  const contents = win.webContents;
  guardWebPage(d, contents, origin);
  contents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !isServerUrl(url, origin)) return;
    // The main window shows the outage and tries again; a second copy of that adds nothing.
    win.destroy();
    d.showMain();
  });
  win.once('ready-to-show', () => win.show());
  void win.loadURL(new URL(path, origin).href);
  return win;
}

/** The window that shows the organization's web app. */
export function createMainWindow(d: DesktopApp, origin: string): BrowserWindow {
  const bounds = d.settings.get().bounds;
  const win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 820,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: d.appName,
    icon: d.icon,
    backgroundColor: DEFAULT_THEME.light.bg,
    autoHideMenuBar: true,
    // The web app's top bar is the title bar (main/titlebar).
    ...titleBarOptions(),
    webPreferences: secure,
  });
  attachTitleBar(win);

  // Closing hides to the tray; "Quit" in the tray or Cmd+Q ends the app.
  win.on('close', (e) => {
    d.settings.update({ bounds: win.getNormalBounds() });
    if (!d.quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('focus', () => {
    win.flashFrame(false);
    d.refreshBadgeSoon();
  });

  const contents = win.webContents;
  guardWebPage(d, contents, origin);
  contents.on('did-navigate', () => d.nudgeRealtime());
  contents.on('did-navigate-in-page', () => d.nudgeRealtime());

  contents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    // -3: aborted by a newer navigation, not an outage.
    if (!isMainFrame || code === -3 || !isServerUrl(url, origin)) return;
    showOffline(win, origin);
  });

  configureSession(d, session.defaultSession, origin);
  void win.loadURL(`${origin}/`);
  return win;
}

/**
 * Rules for every window that shows the organization's pages (main and meeting windows):
 * right-click menu, links to other sites in the browser, same-server pop-ups in the app, and
 * remote control ends when the page reloads or crashes.
 */
export function guardWebPage(d: DesktopApp, contents: WebContents, origin: string): void {
  attachContextMenu(d, contents);

  // Ctrl+R / F5 and Ctrl+Shift+R work without a menu (common/shortcuts).
  contents.on('before-input-event', (e, input) => {
    const kind = reloadShortcut(input, process.platform);
    if (!kind) return;
    e.preventDefault();
    // The offline page tries the server again instead of reloading itself.
    if (contents.getURL().startsWith(RENDERER_URL_PREFIX)) return d.retry();
    if (kind === 'hard') contents.reloadIgnoringCache();
    else contents.reload();
  });

  // Only a middle click makes a window; other pop-ups never do (common/window-policy): meetings
  // go to their meeting window,
  // pages of the server to the main window, files download, other sites to the browser.
  contents.setWindowOpenHandler(({ url, frameName, disposition }) => {
    const decision = windowOpenDecision(url, origin);
    console.info(`[window] pop-up ${decision.kind} ${disposition} ${frameName || '-'} ${url}`);
    switch (decision.kind) {
      case 'meeting':
        d.meetings.open(decision.url);
        break;
      case 'navigate':
        // A middle click asks for another window; everything else goes to the main one.
        if (asksForNewWindow(disposition)) {
          d.extras.open(decision.path);
          break;
        }
        d.showMain();
        d.navigate(decision.path);
        break;
      case 'download':
        contents.downloadURL(decision.url);
        break;
      case 'viewer':
        d.viewer.show(contents, decision.url);
        break;
      case 'external':
        void shell.openExternal(decision.url);
        break;
      case 'deny':
        break;
    }
    return { action: 'deny' };
  });

  // Sign-in may pass through the org's identity provider (SSO), so http(s) pages may load here;
  // anything else (mailto:, custom schemes) goes to the OS.
  contents.on('will-navigate', (e, url) => {
    // A plain link to one of our files: the viewer window, the page stays where it is.
    if (windowOpenDecision(url, origin).kind === 'viewer') {
      e.preventDefault();
      d.viewer.show(contents, url);
      return;
    }
    if (/^https?:/i.test(url) || url.startsWith(RENDERER_URL_PREFIX)) return;
    e.preventDefault();
    if (EXTERNAL.test(url)) void shell.openExternal(url);
  });
  // A reload or a page change leaves the meeting: remote control ends with it.
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) d.remote.endFor(contents);
  });
  contents.on('render-process-gone', () => d.remote.endFor(contents));
  contents.on('destroyed', () => d.remote.endFor(contents));

  // A meeting that runs in the main window or a further one keeps full speed while it is
  // minimised, hidden to the tray or covered (common/meeting); meeting windows always do.
  const throttleFor = (url: string) => {
    if (d.meetings.has(contents)) return;
    const allowed = mayThrottle(url, origin);
    if (contents.getBackgroundThrottling() === allowed) return;
    contents.setBackgroundThrottling(allowed);
    log('meeting', `background throttling ${allowed ? 'on' : 'off'} at ${pathOnly(url)}`);
  };
  contents.on('did-navigate', (_e, url) => throttleFor(url));
  contents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) throttleFor(url);
  });
  // The meeting page's audio and network notes (web lib/meet/mediaWatch) go to the log file:
  // a delay that came and went can be read afterwards.
  contents.on('console-message', (e) => {
    const line = mediaLogLine(e.message);
    if (line !== null) log('media', line);
  });
}

/** The app's own pages: setup, settings, screen picker. */
export function openLocalWindow(
  d: DesktopApp,
  view: View,
  params: Record<string, string>,
  options: BrowserWindowConstructorOptions,
  /** Overlays show without taking focus from the app the controller is typing into. */
  { inactive = false }: { inactive?: boolean } = {},
): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    title: d.appName,
    icon: d.icon,
    autoHideMenuBar: true,
    backgroundColor: DEFAULT_THEME.light.bg,
    webPreferences: secure,
    ...options,
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => (inactive ? win.showInactive() : win.show()));
  void win.loadFile(RENDERER_HTML, { query: { view, ...params } });
  return win;
}

/**
 * Fades a window out before closing it (the first-run screen once the app window is there).
 * Instant when the OS asks for reduced motion.
 */
export function fadeOutAndDestroy(win: BrowserWindow | null, ms = 160): void {
  if (!win || win.isDestroyed()) return;
  if (systemPreferences.getAnimationSettings().prefersReducedMotion) {
    win.destroy();
    return;
  }
  const start = Date.now();
  const timer = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(timer);
    const p = Math.min(1, (Date.now() - start) / ms);
    win.setOpacity(1 - p * p);
    if (p >= 1) {
      clearInterval(timer);
      win.destroy();
    }
  }, 16);
}

export function showOffline(win: BrowserWindow, origin: string): void {
  void win.loadFile(RENDERER_HTML, { query: { view: 'offline', server: origin } });
}

export function showOutdated(win: BrowserWindow, origin: string): void {
  void win.loadFile(RENDERER_HTML, { query: { view: 'outdated', server: origin } });
}

let configuredFor: string | null = null;

/**
 * Camera, microphone, screen sharing and clipboard for the server's pages (common/permissions);
 * HTML notifications are refused because the app shows native ones itself (no duplicates).
 * Main and meeting windows share the default session: configured once per server.
 */
export function configureSession(d: DesktopApp, ses: Session, origin: string): void {
  if (configuredFor === origin) return;
  configuredFor = origin;
  // The organization's server learns which app is calling (common/client) and may answer 426.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({
      requestHeaders: withClientHeader(
        details.url,
        d.origin,
        details.requestHeaders,
        __APP_VERSION__,
      ),
    });
  });
  ses.webRequest.onCompleted((details) => {
    if (isOutdatedAnswer(details.url, d.origin, details.statusCode)) d.showOutdated();
  });
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const url = details.requestingUrl || contents?.getURL() || '';
    // A plugin's iframe in the server's page (common/permissions PLUGIN_FRAME) counts too.
    const frame = { topUrl: contents?.getURL(), isMainFrame: details.isMainFrame };
    if (!allowPermissionRequest(permission, url, origin, frame)) return callback(false);
    if (process.platform !== 'darwin' || permission !== 'media') return callback(true);
    // macOS asks the person once per device type (Info.plist NSCamera/NSMicrophoneUsageDescription).
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    void Promise.all(
      macMediaAccess(mediaTypes).map((kind) =>
        systemPreferences.getMediaAccessStatus(kind) === 'granted'
          ? true
          : systemPreferences.askForMediaAccess(kind),
      ),
    ).then(
      (answers) => callback(answers.every(Boolean)),
      () => callback(false),
    );
  });
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    allowPermissionCheck(permission, requestingOrigin, origin, {
      topUrl: details.embeddingOrigin ?? contents?.getURL(),
      isMainFrame: details.isMainFrame,
    }),
  );
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (!isServerUrl(request.securityOrigin ?? request.frame?.url ?? '', origin)) {
        callback(null);
        return;
      }
      // The picker sits over the window that asked (main or a meeting window).
      const asking = request.frame ? webContents.fromFrame(request.frame) : undefined;
      const parent = (asking && BrowserWindow.fromWebContents(asking)) || d.main || undefined;
      void pickScreen(d, parent).then(async (id) => {
        if (!id) return callback(null);
        // No thumbnails here (the picker already showed them): the share starts sooner. The
        // source captures at the display's native size; the page's constraints decide scaling.
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 0, height: 0 },
        });
        const source = sources.find((s) => s.id === id);
        if (!source) return callback(null);
        // Remote control is offered only for a whole screen: remember which display it is.
        const displayId = Number(source.display_id);
        lastShare = id.startsWith('screen:')
          ? { displayId: Number.isFinite(displayId) && displayId !== 0 ? displayId : null }
          : null;
        // System audio of a whole screen can be shared on Windows only, and only when the page
        // asked for sound (the presenter's "Sesi de paylaş" choice).
        callback(
          request.audioRequested && process.platform === 'win32' && id.startsWith('screen:')
            ? { video: source, audio: 'loopback' }
            : { video: source },
        );
      });
    },
    // Our own picker everywhere (not macOS 15's system picker): it tells which display is shared,
    // which remote control needs.
    { useSystemPicker: false },
  );
}

/**
 * The last share picked here: a whole screen (its display id; null when the OS did not say) or
 * null for a window.
 */
let lastShare: { displayId: number | null } | null = null;

export function lastScreenShare(): { displayId: number | null } | null {
  return lastShare;
}

let pending: ((id: string | null) => void) | null = null;
let picker: BrowserWindow | null = null;

/** Opens the screen picker over the main window and waits for a choice. */
function pickScreen(d: DesktopApp, parent?: BrowserWindow): Promise<string | null> {
  pending?.(null);
  return new Promise((resolve) => {
    pending = resolve;
    picker = openLocalWindow(
      d,
      'picker',
      {},
      {
        width: 720,
        height: 560,
        parent,
        modal: !!parent,
        resizable: false,
        minimizable: false,
      },
    );
    picker.on('closed', () => {
      picker = null;
      chooseScreen(null);
    });
  });
}

export function chooseScreen(id: string | null): void {
  const resolve = pending;
  pending = null;
  resolve?.(id);
  if (picker && !picker.isDestroyed()) picker.close();
}

/** Screen recording: macOS keeps it in System Settings; elsewhere the picker is enough. */
export function screenAccess(): ScreenAccess {
  return screenAccessFor(
    process.platform,
    process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : null,
  );
}

export function openScreenSettings(): void {
  if (process.platform !== 'darwin') return;
  void shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  );
}

export async function screenSources(): Promise<ScreenSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: s.thumbnail.toDataURL(),
  }));
}
