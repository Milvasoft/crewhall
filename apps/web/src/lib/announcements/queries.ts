import { type Announcement } from '@crewhall/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Internal announcements (roadmap 19): query keys and options. */

export const announcementKeys = {
  all: ['announcements'] as const,
  list: (unreadOnly: boolean) => ['announcements', 'list', { unreadOnly }] as const,
  counts: ['announcements', 'counts'] as const,
  one: (id: string) => ['announcements', 'one', id] as const,
  readers: (id: string) => ['announcements', 'readers', id] as const,
};

export const announcementListQuery = (unreadOnly = false, limit = 50) =>
  queryOptions({
    queryKey: [...announcementKeys.list(unreadOnly), limit] as const,
    queryFn: () =>
      api.call('listAnnouncements', {
        query: { limit, ...(unreadOnly ? { unreadOnly: 'true' } : {}) },
      }),
  });

export const announcementCountsQuery = queryOptions({
  queryKey: announcementKeys.counts,
  queryFn: () => api.call('getAnnouncementCounts'),
  staleTime: 30_000,
});

export const announcementQuery = (id: string) =>
  queryOptions({
    queryKey: announcementKeys.one(id),
    queryFn: () => api.call('getAnnouncement', { params: { announcementId: id } }),
  });

export const announcementReadersQuery = (id: string) =>
  queryOptions({
    queryKey: announcementKeys.readers(id),
    queryFn: () => api.call('listAnnouncementReaders', { params: { announcementId: id } }),
  });

/** After a write: the one we have, then every list and the counters. */
export function applyAnnouncement(qc: QueryClient, a: Announcement): void {
  qc.setQueryData(announcementKeys.one(a.id), a);
  void qc.invalidateQueries({ queryKey: ['announcements', 'list'] });
  void qc.invalidateQueries({ queryKey: announcementKeys.counts });
  void qc.invalidateQueries({ queryKey: announcementKeys.readers(a.id) });
}

/** Still to do for the caller: not opened, or asked to confirm and not confirmed. */
export const isUnread = (a: Announcement) =>
  a.my.readAt === null || (a.requiresAck && a.my.ackedAt === null);
