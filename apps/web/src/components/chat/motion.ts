import { useCallback, useMemo, useState } from 'react';
import { type PendingMessage } from '@/lib/chat/outbox';
import { type Message } from '@/lib/chat/types';
import { useArrivals, useReducedMotion } from '@/lib/motion';

/**
 * How a message enters the flow: someone else's slides in from the left, mine rises from
 * the composer, and mine that was on screen as a pending bubble only settles to full
 * opacity (sending → sent), so it does not jump twice.
 */
export type MessageEnter = 'mine' | 'other' | 'settle';

export const ENTER_CLASS: Record<MessageEnter, string> = {
  mine: 'msg-in-mine',
  other: 'msg-in-other',
  settle: 'msg-settle',
};

/** A pending bubble shorter than this on screen was still rising in: keep rising. */
const SETTLE_AFTER_MS = 240;

/** Client ids that were pending in this pane at some point, with when they were queued. */
function useSeenPending(pending: readonly PendingMessage[]): ReadonlyMap<string, number> {
  const [s, setS] = useState<{ src: readonly PendingMessage[]; ids: ReadonlyMap<string, number> }>(
    () => ({
      src: pending,
      ids: new Map(pending.map((p) => [p.clientMsgId, Date.parse(p.createdAt)])),
    }),
  );
  if (s.src !== pending) {
    const ids = new Map(s.ids);
    pending.forEach((p) => ids.set(p.clientMsgId, Date.parse(p.createdAt)));
    setS({ src: pending, ids });
  }
  return s.ids;
}

/**
 * Only messages that arrive while the chat is open animate: never the history on first
 * paint, an older page loaded above, or a jump to another window of the conversation.
 */
export function useMessageEnter(
  items: readonly Message[],
  pending: readonly PendingMessage[],
  me: string,
  ready: boolean,
): (m: Message) => MessageEnter | undefined {
  const reduced = useReducedMotion();
  const keys = useMemo(() => items.map((m) => m.id), [items]);
  const arrived = useArrivals(keys, { ready, tail: true, max: 3 });
  const sentHere = useSeenPending(pending);
  return useCallback(
    (m: Message) => {
      if (reduced || !arrived.has(m.id)) return undefined;
      if (m.author?.id !== me) return 'other';
      const queued = m.clientMsgId ? sentHere.get(m.clientMsgId) : undefined;
      if (queued === undefined) return 'mine';
      // A quick send replaces the bubble mid-rise: rise again rather than snap to 60 %.
      return Date.parse(m.createdAt) - queued < SETTLE_AFTER_MS ? 'mine' : 'settle';
    },
    [reduced, arrived, sentHere, me],
  );
}
