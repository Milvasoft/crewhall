import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '@/lib/api';

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

export interface Autosave<P> {
  state: SaveState;
  savedAt: Date | null;
  error: unknown;
  /** Merge a change into the pending patch and (re)start the debounce. */
  queue: (patch: P) => void;
  /** Save now (before publish, "next'e de uygula", leaving the page). */
  flush: () => Promise<void>;
}

/**
 * Debounced draft saving with optimistic concurrency (design 10.2: "kaydetme otomatik").
 * Each save sends the revision it is based on; a 409 `portal_doc_conflict` stops saving until
 * the caller reloads. `save` returns the new revision.
 */
export function useAutosave<P extends object>({
  rev,
  save,
  delay = 1000,
}: {
  rev: number;
  save: (patch: P, baseRev: number) => Promise<number>;
  delay?: number;
}): Autosave<P> {
  const [state, setState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<unknown>(null);
  const pending = useRef<P | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revRef = useRef(rev);
  const running = useRef<Promise<void> | null>(null);
  const blocked = useRef(false);
  const saveRef = useRef(save);
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (running.current) await running.current;
    const patch = pending.current;
    if (!patch || blocked.current) return;
    pending.current = null;
    setState('saving');
    const run = (async () => {
      try {
        revRef.current = await saveRef.current(patch, revRef.current);
        setSavedAt(new Date());
        setError(null);
        setState(pending.current ? 'pending' : 'saved');
      } catch (e) {
        if (isApiError(e, 'portal_doc_conflict')) {
          blocked.current = true;
          setState('conflict');
        } else {
          // Keep the change so the next edit retries it.
          pending.current = { ...patch, ...(pending.current ?? {}) };
          setState('error');
        }
        setError(e);
      }
    })();
    running.current = run;
    await run;
    running.current = null;
    if (pending.current && !blocked.current) {
      timer.current = setTimeout(() => void flushRef.current(), delay);
    }
  }, [delay]);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const queue = useCallback(
    (patch: P) => {
      if (blocked.current) return;
      pending.current = { ...(pending.current ?? ({} as P)), ...patch };
      setState((s) => (s === 'saving' ? s : 'pending'));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delay);
    },
    [delay, flush],
  );

  // Leaving the editor saves what is left.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      void flush();
    },
    [flush],
  );

  return { state, savedAt, error, queue, flush };
}
