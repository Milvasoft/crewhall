import { useSyncExternalStore } from 'react';

/**
 * Decisions on the "Yap" cards asked for from outside them: a reply such as "evet" or the "Hepsini
 * onayla" button. Each card presses its own button, one card at a time, so the approval endpoint
 * and its passkey or password check stay the only way in and at most one check is ever on screen.
 */

export type Decision = 'approve' | 'reject';

let queue: { id: string; decision: Decision }[] = [];
const listeners = new Set<() => void>();

function publish(next: typeof queue) {
  queue = next;
  listeners.forEach((l) => l());
}

export function requestDecisions(ids: string[], decision: Decision): void {
  const waiting = new Set(queue.map((x) => x.id));
  publish([...queue, ...ids.filter((id) => !waiting.has(id)).map((id) => ({ id, decision }))]);
}

export function finishDecision(id: string): void {
  publish(queue.filter((x) => x.id !== id));
}

/** The person walked away from the check: nothing else is approved behind their back. */
export function clearDecisions(): void {
  publish([]);
}

/** The decision this card should take now: only the first in the queue acts. */
export function useQueuedDecision(id: string): Decision | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (queue[0]?.id === id ? queue[0].decision : null),
    () => null,
  );
}
