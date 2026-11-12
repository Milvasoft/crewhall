import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import { resolveCollabUrl } from '@crewhall/shared';
import { useEffect, useState } from 'react';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import { api } from '@/lib/api';

/**
 * One page's Yjs document over the collab server (doc 17 §6): the api signs a short token,
 * the Hocuspocus provider fetches a fresh one on every reconnect. Edits also stay in this
 * browser (IndexedDB) so typing continues offline and merges on reconnect (design 5.17).
 * Without a collab URL (mock mode) the page runs locally.
 */

export type CollabStatus = 'connecting' | 'synced' | 'offline' | 'local' | 'denied';

export interface CollabUser {
  id: string;
  name: string;
  color: string;
}

export type CollabEvent =
  { type: 'meta' } | { type: 'restored'; by?: string } | { type: 'rights'; readOnly: boolean };

export interface PageCollab {
  doc: Y.Doc;
  provider: HocuspocusProvider | null;
  status: CollabStatus;
  /** Local changes the server has not confirmed yet ("Kaydediliyor"). */
  unsynced: number;
  readOnly: boolean;
}

/** Category tones for cursors (design 5.8: the person's colour, never the accent). */
export const CURSOR_COLORS = [
  '#2F80ED',
  '#9B51E0',
  '#27AE60',
  '#EB5757',
  '#F2994A',
  '#00A3A3',
  '#D6457F',
  '#6D7A00',
];

export function colorFor(userId: string): string {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CURSOR_COLORS[h % CURSOR_COLORS.length]!;
}

export function usePageCollab(
  nodeId: string,
  user: CollabUser | null,
  onEvent: (e: CollabEvent) => void,
): PageCollab | null {
  const [state, setState] = useState<PageCollab | null>(null);

  useEffect(() => {
    if (!user) return;
    let disposed = false;
    const doc = new Y.Doc();
    let provider: HocuspocusProvider | null = null;
    let local: IndexeddbPersistence | null = null;
    const patch = (p: Partial<PageCollab>) => {
      if (!disposed) setState((s) => (s ? { ...s, ...p } : s));
    };

    const start = async () => {
      let first;
      try {
        first = await api.call('createCollabToken', {
          params: { nodeId },
          body: { source: 'web' },
        });
      } catch {
        if (!disposed) {
          setState({ doc, provider: null, status: 'denied', unsynced: 0, readOnly: true });
        }
        return;
      }
      if (disposed) return;
      if (!first.url) {
        setState({ doc, provider: null, status: 'local', unsynced: 0, readOnly: first.readOnly });
        return;
      }
      try {
        local = new IndexeddbPersistence(`crewhall:${user.id}:${first.documentName}`, doc);
      } catch {
        local = null;
      }
      let token: string | null = first.token;
      provider = new HocuspocusProvider({
        url: resolveCollabUrl(first.url, window.location.href),
        name: first.documentName,
        document: doc,
        token: async () => {
          if (token) {
            const t = token;
            token = null;
            return t;
          }
          const next = await api.call('createCollabToken', {
            params: { nodeId },
            body: { source: 'web' },
          });
          return next.token;
        },
        onAuthenticated: ({ scope }) => patch({ readOnly: scope === 'readonly' }),
        onAuthenticationFailed: () => patch({ status: 'denied', readOnly: true }),
        onSynced: ({ state: synced }) => patch(synced ? { status: 'synced' } : {}),
        onStatus: ({ status }) =>
          patch(
            status === WebSocketStatus.Connected
              ? {}
              : status === WebSocketStatus.Connecting
                ? { status: 'connecting' }
                : { status: 'offline' },
          ),
        onUnsyncedChanges: ({ number }) => patch({ unsynced: number }),
        onStateless: ({ payload }) => {
          try {
            const event = JSON.parse(payload) as CollabEvent;
            if (event.type === 'rights') patch({ readOnly: event.readOnly });
            onEvent(event);
          } catch {
            // ignore foreign messages
          }
        },
      });
      provider.setAwarenessField('user', { id: user.id, name: user.name, color: user.color });
      setState({ doc, provider, status: 'connecting', unsynced: 0, readOnly: first.readOnly });
    };
    void start();

    return () => {
      disposed = true;
      provider?.destroy();
      void local?.destroy();
      doc.destroy();
      setState(null);
    };
    // onEvent is read through a ref by callers; the doc is per page and person.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, user?.id]);

  return state;
}
