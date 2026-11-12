// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/preferences/hooks.ts. See THIRD_PARTY.md.
import { useCallback, useSyncExternalStore } from 'react';
import { DEFAULT_PREFERENCES, preferences, type Preferences } from './store';

/**
 * Subscribe a component to a single preference. Uses useSyncExternalStore so
 * every consumer stays consistent and SSR renders the default (avoiding
 * hydration mismatches, the real value is applied after mount).
 */
export function usePreference<K extends keyof Preferences>(
  key: K,
): [Preferences[K], (value: Preferences[K]) => void] {
  const value = useSyncExternalStore(
    preferences.subscribe,
    () => preferences.get(key),
    () => DEFAULT_PREFERENCES[key],
  );
  const set = useCallback((v: Preferences[K]) => preferences.set(key, v), [key]);
  return [value, set];
}

export function useFavorites() {
  const [favorites] = usePreference('favorites');
  const toggle = useCallback((id: string) => preferences.toggleFavorite(id), []);
  const isFavorite = useCallback((id: string) => favorites.includes(id), [favorites]);
  return { favorites, toggle, isFavorite };
}

export function useRecents() {
  const [recents] = usePreference('recents');
  const record = useCallback((id: string) => preferences.recordRecent(id), []);
  return { recents, record };
}
