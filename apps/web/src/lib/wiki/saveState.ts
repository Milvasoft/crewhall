import { useEffect, useRef, useState } from 'react';

/** A save pending this long is worth mentioning. */
export const SLOW_SAVE_MS = 2500;
/** "Kaydedildi" waits until typing has really stopped. */
export const SAVED_AFTER_MS = 2000;

export type SaveState = 'quiet' | 'slow' | 'saved';

/**
 * What the page says about saving. Every keystroke flips the provider's unsynced count between
 * 0 and 1 within milliseconds, which is not news: nothing shows while typing, "Kaydediliyor"
 * only when one save stays pending, "Kaydedildi" once the page has been still for a moment.
 */
export function useCalmSaveState(unsynced: number): SaveState {
  const [state, setState] = useState<SaveState>('quiet');
  const pending = unsynced > 0;
  const edited = useRef(false);

  // On the change itself: typing hides "saved" at once, a slow save that landed says so at once.
  const [wasPending, setWasPending] = useState(pending);
  if (pending !== wasPending) {
    setWasPending(pending);
    if (pending && state === 'saved') setState('quiet');
    if (!pending && state === 'slow') setState('saved');
  }

  useEffect(() => {
    if (pending) {
      edited.current = true;
      const timer = setTimeout(() => setState('slow'), SLOW_SAVE_MS);
      return () => clearTimeout(timer);
    }
    // Nothing was typed yet: opening a page is not a save.
    if (!edited.current) return undefined;
    const timer = setTimeout(() => setState('saved'), SAVED_AFTER_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  return state;
}
