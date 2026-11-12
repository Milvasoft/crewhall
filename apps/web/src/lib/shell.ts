import { useMediaQuery } from '@crewhall/ui';
import { useRouterState } from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';

/**
 * Responsive shell (H10). Phone: bottom tab bar, module sidebar as a drawer from the left.
 * Tablet: rail, sidebar collapsible (collapsed by default). Desktop: rail and pinned sidebar.
 */
export type ShellLayout = 'phone' | 'tablet' | 'desktop';

export const PHONE_QUERY = '(max-width: 767px)';
export const TABLET_QUERY = '(min-width: 768px) and (max-width: 1023px)';

export function useShellLayout(): ShellLayout {
  const phone = useMediaQuery(PHONE_QUERY);
  const tablet = useMediaQuery(TABLET_QUERY);
  return phone ? 'phone' : tablet ? 'tablet' : 'desktop';
}

// ---- tiny shared store: drawer open, tablet sidebar pinned, mounted sidebars ----

interface ShellState {
  drawerOpen: boolean;
  /** Phone "More" sheet (tab bar). */
  moreOpen: boolean;
  /** Tablet only; desktop always shows the sidebar. */
  tabletPinned: boolean;
  sidebars: number;
}

let state: ShellState = {
  drawerOpen: false,
  moreOpen: false,
  tabletPinned: readStorage(StorageKey.tabletSidebar) === 'pinned',
  sidebars: 0,
};
const listeners = new Set<() => void>();

function set(patch: Partial<ShellState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

function useShellState<T>(select: (s: ShellState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => select(state),
    () => select(state),
  );
}

export const useDrawerOpen = () => useShellState((s) => s.drawerOpen);
export const useMoreOpen = () => useShellState((s) => s.moreOpen);

export function setMoreOpen(open: boolean): void {
  if (state.moreOpen !== open) set({ moreOpen: open });
}
export const useTabletPinned = () => useShellState((s) => s.tabletPinned);
/** True while a module sidebar is on screen or in the drawer (shows the menu button). */
export const useHasSidebar = () => useShellState((s) => s.sidebars > 0);

export function setDrawerOpen(open: boolean): void {
  if (state.drawerOpen !== open) set({ drawerOpen: open });
}

export function setTabletPinned(pinned: boolean): void {
  writeStorage(StorageKey.tabletSidebar, pinned ? 'pinned' : null);
  set({ tabletPinned: pinned });
}

/** A module sidebar mounted; returns its cleanup. */
export function registerSidebar(): () => void {
  set({ sidebars: state.sidebars + 1 });
  return () => set({ sidebars: Math.max(0, state.sidebars - 1), drawerOpen: false });
}

/**
 * Path of the screen actually on display. Phone list/detail switches use it instead of
 * `location`, which changes before the next route's code has loaded: switching on `location`
 * briefly showed the old route's empty state ("Bir sohbet seç", W8).
 */
export function useShownPath(): string {
  return useRouterState({
    select: (s) => (s.resolvedLocation ?? s.location).pathname.replace(/\/$/, '') || '/',
  });
}
