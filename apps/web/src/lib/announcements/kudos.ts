import { type KudosBadge } from '@crewhall/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { useI18n } from '@/lib/i18n/I18nContext';

/** Thank-you wall, birthdays and work anniversaries: query keys and options. */

export const kudosKeys = {
  all: ['kudos'] as const,
  list: (userId: string | null) => ['kudos', 'list', { userId }] as const,
  badges: ['kudos', 'badges'] as const,
  celebrations: ['kudos', 'celebrations'] as const,
  settings: ['kudos', 'settings'] as const,
};

export const kudosListQuery = (userId: string | null = null, limit = 50) =>
  queryOptions({
    queryKey: [...kudosKeys.list(userId), limit] as const,
    queryFn: () => api.call('listKudos', { query: { limit, ...(userId ? { userId } : {}) } }),
  });

export const kudosBadgesQuery = queryOptions({
  queryKey: kudosKeys.badges,
  queryFn: () => api.call('listKudosBadges'),
  staleTime: 5 * 60_000,
});

export const celebrationsQuery = queryOptions({
  queryKey: kudosKeys.celebrations,
  queryFn: () => api.call('getCelebrations', { query: { days: 14 } }),
  staleTime: 10 * 60_000,
});

export const celebrationSettingsQuery = queryOptions({
  queryKey: kudosKeys.settings,
  queryFn: () => api.call('getCelebrationSettings'),
});

/** After sending or taking back a card: every wall and profile list. */
export function refreshKudos(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ['kudos', 'list'] });
}

/** A ready badge keeps its translated name until the org renames it. */
export function badgeName(t: ReturnType<typeof useI18n>['t'], b: KudosBadge): string {
  if (b.name) return b.name;
  return b.key
    ? t(`announcements.kudos.badges.${b.key}` as 'announcements.kudos.badges.teamwork')
    : '';
}
