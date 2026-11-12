import { useRouterState } from '@tanstack/react-router';
import { useEffect, useSyncExternalStore } from 'react';
import { readStorage, StorageKey, writeStorage } from '@/lib/storage';
import { ROUTE_BY_ID, routeOfPath, type RouteId } from './catalog';

/** Ctrl K "Son gidilenler": catalogue pages this person went to, newest first, in this browser. */
const LIMIT = 8;

function load(): RouteId[] {
  try {
    const v: unknown = JSON.parse(readStorage(StorageKey.recentRoutes) ?? '[]');
    return Array.isArray(v)
      ? v.filter((x): x is RouteId => typeof x === 'string' && x in ROUTE_BY_ID)
      : [];
  } catch {
    return [];
  }
}

let recent = load();
const listeners = new Set<() => void>();

function set(next: RouteId[]) {
  recent = next;
  writeStorage(StorageKey.recentRoutes, JSON.stringify(next));
  listeners.forEach((l) => l());
}

export function pushRecentRoute(id: RouteId): void {
  if (recent[0] === id) return;
  set([id, ...recent.filter((r) => r !== id)].slice(0, LIMIT));
}

export function useRecentRoutes(): RouteId[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => recent,
    () => recent,
  );
}

/** Notes the catalogue page of every location the app shows. */
export function useTrackRecentRoute(): void {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    const id = routeOfPath(pathname);
    if (id) pushRecentRoute(id);
  }, [pathname]);
}

/** Tests: forget the list. */
export function clearRecentRoutes(): void {
  set([]);
}
