import { useSyncExternalStore } from 'react';

/** Open state of the Ctrl K command palette, shared by the top bar button and the shortcut. */
let open = false;
const listeners = new Set<() => void>();

export function setPaletteOpen(v: boolean): void {
  open = v;
  listeners.forEach((l) => l());
}

export function usePaletteOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
    () => false,
  );
}
