import { DEFAULT_THEME } from '@crewhall/shared';
import { nativeTheme, type BrowserWindow } from 'electron';
import { LOADER_MAX_MS, loaderHold } from '../common/loading';
import type { DesktopApp } from './app';
import { fadeOutAndDestroy, openLocalWindow } from './windows';

/**
 * The loading screen between app start (or the first-run screen) and the organization's page.
 * The app window loads hidden behind it and shows once its page has loaded, at least
 * LOADER_MIN_MS after the loader appeared; a page that takes longer closes it at once.
 * `screen` is the first-run window, which already shows the loader; else a small one opens.
 */
export function coverWhileLoading(
  d: DesktopApp,
  main: BrowserWindow,
  screen: BrowserWindow | null,
  shownAt = Date.now(),
): void {
  const dark = nativeTheme.shouldUseDarkColors;
  const win =
    screen && !screen.isDestroyed()
      ? screen
      : openLocalWindow(
          d,
          'loading',
          { name: d.brand?.orgName ?? '' },
          {
            width: 360,
            height: 300,
            frame: false,
            resizable: false,
            maximizable: false,
            fullscreenable: false,
            center: true,
            backgroundColor: (dark ? DEFAULT_THEME.dark : DEFAULT_THEME.light).bg,
          },
        );

  const contents = main.webContents;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(hold);
    clearTimeout(cap);
    if (!contents.isDestroyed()) contents.off('did-finish-load', loaded);
    if (!main.isDestroyed()) {
      main.off('show', finish);
      if (!main.isVisible() && !d.quitting) d.showMain();
    }
    fadeOutAndDestroy(win);
  };
  // The organization's page or, when the server is down, the offline page.
  const loaded = () => {
    clearTimeout(hold);
    hold = setTimeout(finish, loaderHold(shownAt, Date.now()));
  };
  const cap = setTimeout(finish, LOADER_MAX_MS);
  contents.on('did-finish-load', loaded);
  // Something else brought the app window up first (tray, a link, a call).
  main.once('show', finish);
  win.once('closed', finish);
}
