import { type MailWsEvent } from '@crewhall/shared';
import { type QueryClient } from '@tanstack/react-query';
import { mailKeys, type MailListFilter } from './queries';

/**
 * `mail.changed` from the WebSocket (IMAP IDLE or a background sync saw the folder change):
 * the folder's lists and the counters refetch. Replaces polling while the socket is up.
 */
export function handleMailEvent(client: QueryClient, e: MailWsEvent): void {
  void client.invalidateQueries({ queryKey: mailKeys.folders });
  void client.invalidateQueries({
    queryKey: mailKeys.lists,
    predicate: (q) => (q.queryKey[2] as MailListFilter | undefined)?.folder === e.folder,
  });
}
