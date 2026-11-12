import { type MouseEvent } from 'react';
import { desktopBridge, desktopHas } from '@/lib/desktop';
import { type WebKey } from '@/lib/i18n/I18nContext';

/**
 * A new tab of the browser. The desktop app has no tabs: the page opens in a further window, and
 * only through its bridge, since it sends a plain `window.open` back to the main window. A desktop
 * app from before the bridge falls through to `window.open`.
 */
export function openInNewTab(href: string): void {
  if (desktopHas('openWindow')) {
    void desktopBridge()?.openWindow?.(href);
    return;
  }
  window.open(href, '_blank', 'noopener');
}

/** The menu entry for openInNewTab: "Yeni sekmede aç", or "Yeni pencerede aç" in the desktop app. */
export function newTabLabel(): WebKey {
  return desktopHas('openWindow') ? 'desktop.menu.openInNewWindow' : 'quick.menu.newTab';
}

/**
 * For a row that cannot be a link (a table row, a draggable tile, a row whose click selects): the
 * middle button opens `href` in a new tab, as it does on a real link. A real link inside it does
 * not open a second tab, since the row handles the click first and cancels the default.
 */
export function middleClickOpens(href: string | (() => string)) {
  return {
    // Otherwise Windows starts its scroll mode on the middle button. Capture, so that spreading
    // this over a drag library's own onMouseDown cannot replace it and kill the drag.
    onMouseDownCapture: (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    },
    onAuxClick: (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      openInNewTab(typeof href === 'string' ? href : href());
    },
  };
}

/** A click with Ctrl, Cmd, Shift or the middle button is the browser's: it opens a tab or window. */
export function isPlainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}
