/** All localStorage keys in one place. Values are per-browser conveniences, never the source of truth. */
export const StorageKey = {
  locale: 'crewhall.locale',
  appearance: 'crewhall.appearance',
  themeCss: 'crewhall.themeCss',
  branding: 'crewhall.branding',
  passkeyUsed: 'crewhall.passkeyUsed',
  reducedMotion: 'crewhall.reducedMotion',
  /** Chat message sound (H6): 'off' when turned off in this browser. */
  messageSound: 'crewhall.messageSound',
  density: 'crewhall.density',
  lastSpace: 'crewhall.lastSpace',
  timeFormat: 'crewhall.timeFormat',
  fontScale: 'crewhall.fontScale',
  /** Drive list or grid per folder (3.5). */
  driveViews: 'crewhall.driveViews',
  /** Public link grants after the password (19.2: remembered 12 hours in this browser). */
  shareGrants: 'crewhall.shareGrants',
  /** Tablet width: the module sidebar stays open (H10); collapsed by default. */
  tabletSidebar: 'crewhall.tabletSidebar',
  /** Module sidebar widths and collapsed modules (dragged edge), until UiPrefs carries them. */
  sidebarSizes: 'crewhall.sidebarSizes',
  /** Widths of resizable side panels and list columns (ResizablePane), per panel; this device. */
  paneWidths: 'crewhall.paneWidths',
  /** Ctrl K "Son gidilenler": catalogue pages this person opened, newest first. */
  recentRoutes: 'crewhall.recentRoutes',
  /** Public forms: this browser's answer token (one-answer limit). */
  formClient: 'crewhall.formClient',
  /** "Uygulamada aç" banner closed in this phone browser: when (ms). */
  openInAppDismissed: 'crewhall.openInAppDismissed',
} as const;

export type StorageKey = (typeof StorageKey)[keyof typeof StorageKey];

export function readStorage(key: StorageKey): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: StorageKey, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* best effort: private mode or blocked storage */
  }
}
