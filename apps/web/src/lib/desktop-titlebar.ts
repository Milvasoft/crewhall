import {
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { desktopBridge, desktopHas, type DesktopTitleBarBridge } from './desktop';

/**
 * In the desktop app the window has no system title bar (apps/desktop src/common/titlebar.ts):
 * the page's top bar takes its place, like Teams. Its element carries `data-titlebar` (the app
 * makes it drag the window, leaves its buttons and fields clickable and keeps room for the
 * window buttons); while one is on screen `<html data-titlebar-owned>` is set. In a browser
 * nothing changes.
 */
export function titleBarBridge(): DesktopTitleBarBridge | null {
  return desktopHas('titleBar') ? (desktopBridge()?.titleBar ?? null) : null;
}

let owners = 0;
/** Height of the app's strip above pages without a bar of their own. */
const STRIP_HEIGHT = 32;
/** The window buttons' row over a full-window view: its own bar comes right under it. */
export const THIN_TITLE_ROW = STRIP_HEIGHT;

/**
 * A panel over the title bar row (the AI panel) lends the window buttons its colours while it is
 * open; every reporter reads it, and all of them report again when it comes or goes.
 */
let lent: (() => { bg: string; fg: string; height?: number }) | null = null;
const reporters = new Set<() => void>();
const reportAll = () => reporters.forEach((r) => r());

/** Runs `report` now and whenever the theme or the org's colours may have changed. */
function watchTheme(report: () => void): () => void {
  // Theme switches change attributes on <html>; the org's colours may come as a stylesheet.
  const watch = new MutationObserver(report);
  watch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme'],
  });
  watch.observe(document.head, { childList: true, subtree: true, characterData: true });
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  dark.addEventListener('change', report);
  report();
  return () => {
    watch.disconnect();
    dark.removeEventListener('change', report);
  };
}

/** Pages without a bar: the window buttons take the page's colours over the app's strip. */
function reportStrip(bridge: DesktopTitleBarBridge): void {
  if (owners > 0) return;
  bridge.set({
    owned: false,
    height: STRIP_HEIGHT,
    ...(lent?.() ?? titleBarColors(document.body)),
  });
}

/** #rrggbb of any CSS colour (oklch too), drawn on a pixel and read back. */
function toHex(color: string, ctx: CanvasRenderingContext2D): string {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const transparent = (c: string) => !c || c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);
/** A colour with an alpha below 1: rgba(…, 0.15) or color(… / 0.15), oklch(… / 0.15). */
const translucent = (c: string) =>
  /^rgba\(.*,\s*0?\.\d+\)$/.test(c) || /\/\s*0?\.\d+\s*\)$/.test(c);

/**
 * The backgrounds that make up the colour behind an element, top layer first, down to the first
 * opaque one (a tinted strip like the meeting one is its tint over the page).
 */
function backgroundLayers(el: Element): string[] {
  const layers: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (transparent(bg)) continue;
    layers.push(bg);
    if (!translucent(bg)) return layers;
  }
  layers.push(getComputedStyle(document.body).backgroundColor || '#ffffff');
  return layers;
}

/** What the window buttons should look like for this bar. */
export function titleBarColors(el: HTMLElement): { bg: string; fg: string } {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const layers = backgroundLayers(el);
  const fg = getComputedStyle(el).color;
  if (!ctx) return { bg: layers[0]!, fg };
  // Paint the layers bottom up and read the pixel back: the colour as it is seen.
  ctx.clearRect(0, 0, 1, 1);
  for (const layer of [...layers].reverse()) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  const bg = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return { bg, fg: toHex(fg, ctx) };
}

/**
 * Makes `ref` the window's title bar while it is mounted, in the desktop app. Reports its height
 * and colours again when the theme, the org's colours or the bar's size change.
 */
export function useDesktopTitleBar(ref: RefObject<HTMLElement | null>): boolean {
  const [bridge] = useState(titleBarBridge);
  // Only the bar at the very top of the window is the title bar (a meeting strip above the page
  // bar takes it over while it is shown); the others give up data-titlebar.
  const [atTop, setAtTop] = useState(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!bridge || !el) return;
    owners += 1;
    document.documentElement.dataset.titlebarOwned = '';
    // Another bar may no longer be the top one.
    setTimeout(reportAll, 0);
    return () => {
      owners -= 1;
      // Moving to another page swaps one bar for the next in the same commit: no flicker.
      setTimeout(() => {
        if (owners > 0) return reportAll();
        delete document.documentElement.dataset.titlebarOwned;
        reportStrip(bridge);
      }, 0);
    };
  }, [bridge, ref]);

  useEffect(() => {
    const el = ref.current;
    if (!bridge || !el) return;
    let last = '';
    const report = () => {
      const top = el.getBoundingClientRect().top < 1;
      setAtTop(top);
      if (!top) {
        last = '';
        return;
      }
      const state = {
        owned: true,
        // Above the bar's bottom border: the line runs on under the window buttons.
        height:
          Math.round(
            el.getBoundingClientRect().height -
              (parseFloat(getComputedStyle(el).borderBottomWidth) || 0),
          ) || 56,
        ...(lent?.() ?? titleBarColors(el)),
      };
      const key = JSON.stringify(state);
      if (key === last) return;
      last = key;
      bridge.set(state);
    };
    reporters.add(report);
    const stop = watchTheme(report);
    const size = new ResizeObserver(report);
    size.observe(el);
    return () => {
      reporters.delete(report);
      stop();
      size.disconnect();
    };
  }, [bridge, ref]);

  return bridge !== null && atTop;
}

/**
 * While `active`, the window buttons take the colours of `ref` (a view over the title bar row)
 * and, with `height`, that row's height; afterwards the bar's own come back. Desktop app only.
 */
export function useLendTitleBarColors(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  height?: number,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!active || !el || !titleBarBridge()) return;
    const colors = () => ({ ...titleBarColors(el), ...(height ? { height } : {}) });
    lent = colors;
    // Reports now and again on theme changes (the panel's colours follow the theme too).
    const stop = watchTheme(reportAll);
    return () => {
      stop();
      if (lent === colors) lent = null;
      reportAll();
    };
  }, [ref, active, height]);
}

/** Props that make a top bar the window title bar in the desktop app: spread them on it. */
export function useTitleBarProps<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const on = useDesktopTitleBar(ref);
  return { ref, 'data-titlebar': on ? '' : undefined };
}

/**
 * An empty top bar, only in the desktop app, for pages that have none (the chat start page):
 * it carries the window buttons, so the page lines up with the others instead of sitting
 * under the app's strip.
 */
export function DesktopTitleBarRow({ children }: { children?: ReactNode }) {
  const props = useTitleBarProps<HTMLDivElement>();
  const [bridge] = useState(titleBarBridge);
  // Drawn in the desktop app whether or not it is the top bar right now (a meeting strip may
  // sit above it for a while); only `data-titlebar` follows that.
  if (!bridge) return null;
  return createElement(
    'div',
    {
      ...props,
      className:
        'flex h-14 w-full shrink-0 items-center gap-2 border-b border-line px-4 text-sm font-semibold',
    },
    children,
  );
}

/**
 * Mounted once at the root. Marks `<html data-desktop-titlebar>` (the shell then leaves room for
 * the app's strip on pages without a bar, see index.css) and gives the window buttons the page
 * colours there.
 */
export function DesktopTitleBarSync(): null {
  useEffect(() => {
    const bridge = titleBarBridge();
    if (!bridge) return;
    const root = document.documentElement;
    root.dataset.desktopTitlebar = '';
    const report = () => reportStrip(bridge);
    reporters.add(report);
    const stop = watchTheme(report);
    return () => {
      reporters.delete(report);
      stop();
      delete root.dataset.desktopTitlebar;
    };
  }, []);
  return null;
}
