import { useSyncExternalStore } from 'react';

/**
 * Tiny store for "the session ended while the app was open" (doc 01 · 1.17).
 * Set by the query client on 401, read by the shell to open the re-auth dialog.
 */
let expired = false;
const listeners = new Set<() => void>();

export function markSessionExpired(): void {
  if (expired) return;
  expired = true;
  listeners.forEach((l) => l());
}

export function clearSessionExpired(): void {
  expired = false;
  listeners.forEach((l) => l());
}

export function useSessionExpired(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => expired,
    () => false,
  );
}
