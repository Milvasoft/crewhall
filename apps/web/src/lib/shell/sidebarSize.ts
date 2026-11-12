import { type UiPrefs, type UpdateUiPrefs } from '@crewhall/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { MODULE_BY_SEGMENT } from '@/lib/modules';
import { uiPrefsKey, uiPrefsQuery } from '@/lib/shell/navOrder';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';

/**
 * Width of the module sidebar, per module (chat can be wide, Yönetim narrow), dragged on its
 * right edge. Dragging below COLLAPSE_BELOW collapses it (VS Code style); dragging it out again
 * opens it. Follows the person across devices in the server's UiPrefs (`sidebarWidths`,
 * `sidebarCollapsed`); this browser keeps a copy so the first paint has the right width.
 */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const COLLAPSE_BELOW = 140;
export const SIDEBAR_STEP = 16;

/** The widest a sidebar may get: 480 px or 40 % of the window, never under the minimum. */
export function sidebarMax(
  viewport: number = typeof window === 'undefined' ? 1440 : window.innerWidth,
) {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(viewport * 0.4)));
}

export function clampWidth(width: number, max = sidebarMax()): number {
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN, width)));
}

const EXTRA: Record<string, string> = {
  admin: 'admin',
  account: 'account',
  portal: 'portal',
  notifications: 'notifications',
  people: 'contacts',
};

/** Module id of a path: `/chat/c/…` → chat, `/admin/general` → admin. */
export function sidebarModuleOf(pathname: string): string {
  const seg = pathname.split('/')[1] ?? '';
  return MODULE_BY_SEGMENT[seg] ?? EXTRA[seg] ?? (seg || 'home');
}

interface Sizes {
  widths: Record<string, number>;
  collapsed: string[];
}

function load(): Sizes {
  try {
    const raw = readStorage(StorageKey.sidebarSizes);
    const v = raw ? (JSON.parse(raw) as Partial<Sizes>) : {};
    const widths: Record<string, number> = {};
    for (const [k, w] of Object.entries(v.widths ?? {})) {
      if (typeof w === 'number' && Number.isFinite(w)) widths[k] = w;
    }
    const collapsed = Array.isArray(v.collapsed)
      ? v.collapsed.filter((x): x is string => typeof x === 'string')
      : [];
    return { widths, collapsed };
  } catch {
    return { widths: {}, collapsed: [] };
  }
}

let sizes = load();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** Bumped by every local change; the server's copy is not taken while one is unsaved. */
let version = 0;
let savedVersion = 0;
let saver: ((body: UpdateUiPrefs) => Promise<unknown>) | undefined;

function set(next: Sizes) {
  sizes = next;
  listeners.forEach((l) => l());
}

function save() {
  const at = version;
  writeStorage(StorageKey.sidebarSizes, JSON.stringify(sizes));
  if (!saver) {
    savedVersion = at;
    return;
  }
  saver({ sidebarWidths: sizes.widths, sidebarCollapsed: sizes.collapsed })
    .catch(() => undefined)
    .finally(() => {
      savedVersion = Math.max(savedVersion, at);
    });
}

function update(next: Sizes) {
  set(next);
  version += 1;
  // Saved a moment after the last change: a drag or a run of arrow keys writes once.
  clearTimeout(timer);
  timer = setTimeout(save, 300);
}

/** The server's copy wins (another device may have changed it), unless a local change is unsaved. */
export function hydrateSidebarSizes(prefs: Pick<UiPrefs, 'sidebarWidths' | 'sidebarCollapsed'>) {
  if (savedVersion !== version) return;
  if (prefs.sidebarWidths === undefined && prefs.sidebarCollapsed === undefined) {
    // Nothing on the server yet: what this browser had goes up once.
    if (Object.keys(sizes.widths).length || sizes.collapsed.length) update(sizes);
    return;
  }
  set({ widths: { ...prefs.sidebarWidths }, collapsed: [...(prefs.sidebarCollapsed ?? [])] });
  writeStorage(StorageKey.sidebarSizes, JSON.stringify(sizes));
}

/** Mounted once in the signed-in app: reads UiPrefs into the store and saves changes back. */
export function useSidebarSizeSync(): void {
  const qc = useQueryClient();
  const prefs = useQuery(uiPrefsQuery);
  useEffect(() => {
    saver = async (body) => {
      const next = await api.call('updateUiPrefs', { body });
      qc.setQueryData(uiPrefsKey, next);
    };
    return () => {
      saver = undefined;
    };
  }, [qc]);
  useEffect(() => {
    if (prefs.data) hydrateSidebarSizes(prefs.data);
  }, [prefs.data]);
}

export function useSidebarSize(moduleId: string): { width: number | null; collapsed: boolean } {
  const width = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sizes.widths[moduleId] ?? null,
    () => null,
  );
  const collapsed = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sizes.collapsed.includes(moduleId),
    () => false,
  );
  return { width, collapsed };
}

export function setSidebarWidth(moduleId: string, width: number): void {
  update({
    widths: { ...sizes.widths, [moduleId]: clampWidth(width) },
    collapsed: sizes.collapsed.filter((m) => m !== moduleId),
  });
}

export function setSidebarCollapsed(moduleId: string, collapsed: boolean): void {
  const rest = sizes.collapsed.filter((m) => m !== moduleId);
  update({ widths: sizes.widths, collapsed: collapsed ? [...rest, moduleId] : rest });
}

/** Double-click: back to the module's default width, open. */
export function resetSidebar(moduleId: string): void {
  const widths = { ...sizes.widths };
  delete widths[moduleId];
  update({ widths, collapsed: sizes.collapsed.filter((m) => m !== moduleId) });
}

/** Tests: forget everything. */
export function clearSidebarSizes(): void {
  clearTimeout(timer);
  version = savedVersion = 0;
  set({ widths: {}, collapsed: [] });
}
