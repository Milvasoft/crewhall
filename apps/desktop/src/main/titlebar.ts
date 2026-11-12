import { DEFAULT_THEME } from '@crewhall/shared';
import { BrowserWindow, ipcMain, nativeTheme } from 'electron';
import {
  STRIP_HEIGHT,
  STRIP_SCRIPT,
  TITLEBAR_CHANNEL,
  overlayHeight,
  parseTitleBarState,
  titleBarCss,
  titleBarWindowOptions,
  type TitleBarColors,
  type TitleBarState,
} from '../common/titlebar';

/** What each window's page last reported; null: no page owns the bar (strip, theme colours). */
const states = new Map<BrowserWindow, TitleBarState | null>();

function themeColors(): TitleBarColors {
  return nativeTheme.shouldUseDarkColors
    ? { bg: DEFAULT_THEME.dark.bg, fg: '#F2F2F1' }
    : { bg: DEFAULT_THEME.light.bg, fg: '#141516' };
}

/** BrowserWindow options: no system title bar, window buttons over the page (common/titlebar). */
export function titleBarOptions(colors: TitleBarColors = themeColors()) {
  return titleBarWindowOptions(process.platform, colors);
}

function apply(win: BrowserWindow): void {
  if (win.isDestroyed() || process.platform === 'darwin') return;
  const state = states.get(win) ?? null;
  const colors = state ?? themeColors();
  try {
    win.setTitleBarOverlay({
      color: colors.bg,
      symbolColor: colors.fg,
      height: overlayHeight(state),
    });
  } catch {
    // A window made without an overlay.
  }
}

const PAGE_COLORS = `(() => {
  const s = getComputedStyle(document.body);
  return { bg: s.backgroundColor, fg: s.color };
})()`;

/**
 * Pages without a bar of their own that report nothing (sign-in on an older web app, the
 * identity provider's site): the window buttons take the page's own colours.
 */
function followPage(win: BrowserWindow): void {
  if (win.isDestroyed() || process.platform === 'darwin' || states.get(win)?.owned) return;
  win.webContents
    .executeJavaScript(PAGE_COLORS)
    .then((colors: unknown) => {
      const state = parseTitleBarState({
        owned: false,
        height: STRIP_HEIGHT,
        ...(colors as object),
      });
      // A see-through body says nothing about the colour on screen.
      if (!state || /,\s*0\)$/.test(state.bg) || win.isDestroyed() || states.get(win)?.owned)
        return;
      states.set(win, state);
      apply(win);
    })
    .catch(() => undefined);
}

/**
 * Wires a window made with titleBarOptions(): the strip and the drag rules go into every page
 * it loads, and the window buttons follow what the page reports.
 */
export function attachTitleBar(win: BrowserWindow): void {
  states.set(win, null);
  const contents = win.webContents;
  contents.on('dom-ready', () => {
    void contents.insertCSS(titleBarCss(process.platform)).catch(() => undefined);
    void contents.executeJavaScript(STRIP_SCRIPT).catch(() => undefined);
  });
  contents.on('did-finish-load', () => followPage(win));
  // A new document starts without a bar of its own until it says otherwise.
  contents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    states.set(win, null);
    apply(win);
  });
  win.on('closed', () => states.delete(win));
}

export function registerTitleBar(): void {
  ipcMain.on(TITLEBAR_CHANNEL, (event, raw: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    // Only windows set up for it, and only their own page (not a frame inside it).
    if (!win || !states.has(win) || event.senderFrame !== event.sender.mainFrame) return;
    const state = parseTitleBarState(raw);
    if (!state) return;
    states.set(win, state);
    apply(win);
  });
  // Pages without a bar follow the theme: the system's, then the page's own colours.
  nativeTheme.on('updated', () => {
    for (const [win, state] of states) {
      if (state?.owned) continue;
      if (!state) apply(win);
      setTimeout(() => followPage(win), 300);
    }
  });
}
