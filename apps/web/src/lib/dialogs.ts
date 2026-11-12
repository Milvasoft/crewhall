import { useSyncExternalStore } from 'react';

/** App-level dialogs that several places open (palette, space selector, admin). */
export type AppDialog = 'newSpace' | 'invite' | 'addLink' | null;

let current: AppDialog = null;
const listeners = new Set<() => void>();

export function openDialog(d: AppDialog): void {
  current = d;
  listeners.forEach((l) => l());
}

export function useDialog(): AppDialog {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}
