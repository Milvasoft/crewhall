import { MAIL_RAW_PATHS, type MailMessagesQuery } from '@crewhall/shared';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { config } from '@/config';
import { api } from '@/lib/api';

/** Query keys and option factories of the mail module (roadmap 24). */
export const mailKeys = {
  all: ['mail'] as const,
  account: ['mail', 'account'] as const,
  folders: ['mail', 'folders'] as const,
  lists: ['mail', 'messages'] as const,
  messages: (q: MailListFilter) => ['mail', 'messages', q] as const,
  thread: (folder: string, uid: number, remoteImages: boolean) =>
    ['mail', 'thread', folder, uid, remoteImages] as const,
  recipients: (q: string) => ['mail', 'recipients', q] as const,
  settings: ['mail', 'settings'] as const,
};

export type MailListFilter = Pick<MailMessagesQuery, 'folder'> & {
  q?: string;
  filter: 'all' | 'unread' | 'flagged';
  /** Headers-only search (the fast first answer); absent = full text. */
  scope?: 'headers';
};

/**
 * New mail arrives over the WebSocket (`mail.changed`, lib/mail/realtime.ts); this slow poll
 * only covers a socket that is down.
 */
const REFRESH_MS = 5 * 60_000;

export const mailAccountQuery = queryOptions({
  queryKey: mailKeys.account,
  queryFn: ({ signal }) => api.call('mailAccount', { signal }),
  staleTime: 30_000,
});

export const mailFoldersQuery = queryOptions({
  queryKey: mailKeys.folders,
  queryFn: ({ signal }) => api.call('mailFolders', { signal }),
  refetchInterval: REFRESH_MS,
  staleTime: 15_000,
});

export const mailMessagesQuery = (f: MailListFilter) =>
  infiniteQueryOptions({
    queryKey: mailKeys.messages(f),
    queryFn: ({ signal, pageParam }) =>
      api.call('mailMessages', {
        query: {
          folder: f.folder,
          limit: 50,
          ...(f.q ? { q: f.q } : {}),
          ...(f.q && f.scope ? { scope: f.scope } : {}),
          ...(f.filter === 'unread' ? { unread: 'true' } : {}),
          ...(f.filter === 'flagged' ? { flagged: 'true' } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: REFRESH_MS,
    staleTime: 15_000,
  });

export const mailThreadQuery = (folder: string, uid: number, remoteImages: boolean) =>
  queryOptions({
    queryKey: mailKeys.thread(folder, uid, remoteImages),
    queryFn: ({ signal }) =>
      // Never marks read: prefetching on hover must not. ThreadView marks the shown ones.
      api.call('mailThread', {
        query: {
          folder,
          uid,
          markSeen: 'false',
          ...(remoteImages ? { remoteImages: 'true' } : {}),
        },
        signal,
      }),
    staleTime: 60_000,
  });

export const mailRecipientsQuery = (q: string) =>
  queryOptions({
    queryKey: mailKeys.recipients(q),
    queryFn: ({ signal }) => api.call('mailRecipients', { query: { q, limit: 8 }, signal }),
    staleTime: 30_000,
  });

export const mailServerSettingsQuery = queryOptions({
  queryKey: mailKeys.settings,
  queryFn: ({ signal }) => api.call('mailServerSettings', { signal }),
});

const apiBase = () => config.apiUrl.replace(/\/$/, '');

/** Download (or inline image) URL of an attachment; the session cookie authorizes it. */
export function attachmentUrl(
  folder: string,
  uid: number,
  part: string,
  inline = false,
  inboxId?: string,
) {
  const q = new URLSearchParams({ folder, uid: String(uid), part });
  if (inline) q.set('inline', 'true');
  if (inboxId) q.set('inboxId', inboxId);
  return `${apiBase()}${MAIL_RAW_PATHS.attachment}?${q}`;
}

/** Browser navigation that starts OAuth2 with the org's provider. */
export const oauthStartUrl = () => `${apiBase()}${MAIL_RAW_PATHS.oauthStart}`;

/** Browser navigation that signs a shared inbox in with the org's provider (space admins). */
export const inboxOauthStartUrl = (inboxId: string) =>
  `${apiBase()}${MAIL_RAW_PATHS.inboxOauthStart}?${new URLSearchParams({ inboxId })}`;
