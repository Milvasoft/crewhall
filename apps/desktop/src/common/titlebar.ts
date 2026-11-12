import { z } from 'zod';

/**
 * Windows that show the organization's pages (main, meeting) have no system title bar: the
 * page's own top bar is the title bar, like Teams. Windows and Linux keep the system's window
 * buttons on the right (title bar overlay), macOS its traffic lights on the left.
 *
 * The contract with the web app (apps/web lib/desktop.ts):
 * - `<html data-titlebar-owned>` while a top bar that acts as the title bar is on screen;
 * - that bar carries `data-titlebar`; buttons, links and fields inside it stay clickable;
 * - the page reports its height and colours with `crewhallDesktop.titleBar.set`.
 * Until a page owns it (sign-in, error pages, the identity provider's site, an older web app),
 * the app keeps a thin draggable strip above the page.
 */

export const TITLEBAR_CHANNEL = 'titlebar:set';
/** The strip above pages that do not own the title bar (and the window buttons' height there). */
export const STRIP_HEIGHT = 32;
const MIN_HEIGHT = 28;
const MAX_HEIGHT = 80;

/** A CSS colour the overlay accepts: hex or rgb()/rgba(). */
const Color = z
  .string()
  .max(64)
  .regex(
    /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\))$/i,
  );

export const TitleBarState = z.object({
  owned: z.boolean(),
  height: z.number().int().min(MIN_HEIGHT).max(MAX_HEIGHT),
  bg: Color,
  fg: Color,
});
export type TitleBarState = z.infer<typeof TitleBarState>;

export interface TitleBarColors {
  bg: string;
  fg: string;
}

/** What the page sent, or null when it is not a valid state. */
export function parseTitleBarState(input: unknown): TitleBarState | null {
  const r = TitleBarState.safeParse(input);
  return r.success ? r.data : null;
}

/** The window buttons follow the bar: its height when the page owns it, else the strip's. */
export function overlayHeight(state: TitleBarState | null): number {
  return state?.owned ? state.height : STRIP_HEIGHT;
}

/** BrowserWindow options for a window that shows the organization's pages. */
export function titleBarWindowOptions(platform: string, colors: TitleBarColors) {
  if (platform === 'darwin') {
    // Traffic lights in the top-left corner, over the rail (the web pads the rail for them).
    return { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 10, y: 12 } };
  }
  return {
    titleBarStyle: 'hidden' as const,
    titleBarOverlay: { color: colors.bg, symbolColor: colors.fg, height: STRIP_HEIGHT },
  };
}

/** Elements inside the title bar that keep their clicks (everything else drags the window). */
export const NO_DRAG = [
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[contenteditable]',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="combobox"]',
  '[role="searchbox"]',
  '[data-no-drag]',
].join(', ');

/**
 * Room for the window buttons on the right: the part of the window right of the title bar area
 * (Window Controls Overlay). 0 where there is no overlay (macOS, a browser).
 */
export const CONTROLS_WIDTH =
  'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))';

/** Injected into every page of those windows (main/windows.ts). */
export function titleBarCss(platform: string): string {
  const strip = `${STRIP_HEIGHT}px`;
  const mac = platform === 'darwin';
  return `
#crewhall-titlebar-strip {
  position: fixed; top: 0; left: 0; right: 0; height: ${strip};
  z-index: 2147483647; -webkit-app-region: drag;
}
html[data-titlebar-owned] #crewhall-titlebar-strip { display: none; }
html:not([data-titlebar-owned]) body { padding-top: ${strip} !important; box-sizing: border-box; }
html:not([data-titlebar-owned]) .min-h-screen { min-height: calc(100vh - ${strip}) !important; }
html:not([data-titlebar-owned]) :is(.h-screen, .h-dvh) { height: calc(100vh - ${strip}) !important; }
html[data-titlebar-owned] [data-titlebar] {
  -webkit-app-region: drag;
  ${mac ? '' : `padding-right: calc(${CONTROLS_WIDTH} + 8px) !important;`}
}
html[data-titlebar-owned] [data-titlebar] :is(${NO_DRAG}) { -webkit-app-region: no-drag; }
${
  mac
    ? `html[data-titlebar-owned] [data-titlebar-rail] { padding-top: 40px !important; -webkit-app-region: drag; }
html[data-titlebar-owned] [data-titlebar-rail] :is(${NO_DRAG}) { -webkit-app-region: no-drag; }`
    : ''
}`;
}

/** Adds the strip element (once per document); run in the page at dom-ready. */
export const STRIP_SCRIPT = `(() => {
  if (document.getElementById('crewhall-titlebar-strip')) return;
  const strip = document.createElement('div');
  strip.id = 'crewhall-titlebar-strip';
  strip.setAttribute('aria-hidden', 'true');
  document.documentElement.append(strip);
})();`;
