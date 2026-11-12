import { CALENDAR_RAW_PATHS, type CalendarProvider } from '@crewhall/shared';
import { queryOptions } from '@tanstack/react-query';
import { config } from '@/config';
import { api } from '@/lib/api';

/** Query keys and fetchers of the calendar module (roadmap 14). */
export const calendarKeys = {
  all: ['calendar'] as const,
  calendars: () => ['calendar', 'calendars'] as const,
  settings: () => ['calendar', 'settings'] as const,
  occurrences: (from: string, to: string, spaceId?: string) =>
    ['calendar', 'occurrences', from, to, spaceId ?? ''] as const,
  event: (id: string, recurrenceId?: string | null) =>
    ['calendar', 'event', id, recurrenceId ?? ''] as const,
  versions: (id: string) => ['calendar', 'event-versions', id] as const,
  members: (id: string) => ['calendar', 'members', id] as const,
  freeBusy: (userIds: string, from: string, to: string) =>
    ['calendar', 'free-busy', userIds, from, to] as const,
  caldav: () => ['calendar', 'caldav'] as const,
};

export const eventVersionsQuery = (eventId: string) =>
  queryOptions({
    queryKey: calendarKeys.versions(eventId),
    queryFn: ({ signal }) => api.call('listCalendarEventVersions', { params: { eventId }, signal }),
  });

export const calendarsQuery = () =>
  queryOptions({
    queryKey: calendarKeys.calendars(),
    queryFn: ({ signal }) => api.call('listCalendars', { signal }),
    staleTime: 30_000,
  });

export const calendarSettingsQuery = () =>
  queryOptions({
    queryKey: calendarKeys.settings(),
    queryFn: ({ signal }) => api.call('getCalendarSettings', { signal }),
    staleTime: 60_000,
  });

export const occurrencesQuery = (from: string, to: string, spaceId?: string) =>
  queryOptions({
    queryKey: calendarKeys.occurrences(from, to, spaceId),
    queryFn: ({ signal }) =>
      api.call('listCalendarOccurrences', { query: { from, to, spaceId }, signal }),
    // Meetings go live and cards move elsewhere; a calm refresh keeps the view honest.
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });

export const eventQuery = (eventId: string, recurrenceId?: string | null) =>
  queryOptions({
    queryKey: calendarKeys.event(eventId, recurrenceId),
    queryFn: ({ signal }) =>
      api.call('getCalendarEvent', {
        params: { eventId },
        query: { recurrenceId: recurrenceId ?? undefined },
        signal,
      }),
  });

export const calendarMembersQuery = (calendarId: string) =>
  queryOptions({
    queryKey: calendarKeys.members(calendarId),
    queryFn: ({ signal }) => api.call('listCalendarMembers', { params: { calendarId }, signal }),
  });

export const freeBusyQuery = (userIds: string[], from: string, to: string) =>
  queryOptions({
    queryKey: calendarKeys.freeBusy(userIds.join(','), from, to),
    queryFn: ({ signal }) =>
      api.call('getCalendarFreeBusy', { query: { userIds: userIds.join(','), from, to }, signal }),
    staleTime: 30_000,
  });

export const calDavInfoQuery = () =>
  queryOptions({
    queryKey: calendarKeys.caldav(),
    queryFn: ({ signal }) => api.call('getCalDavInfo', { signal }),
    staleTime: 5 * 60_000,
  });

export const calendarAccountsKey = ['calendar', 'accounts'] as const;
export const calendarIntegrationsKey = ['calendar', 'admin', 'integrations'] as const;

/** The person's connected Google / Microsoft accounts and the providers the org offers. */
export const calendarAccountsQuery = () =>
  queryOptions({
    queryKey: calendarAccountsKey,
    queryFn: ({ signal }) => api.call('listCalendarAccounts', { signal }),
    staleTime: 30_000,
  });

export const calendarIntegrationsQuery = () =>
  queryOptions({
    queryKey: calendarIntegrationsKey,
    queryFn: ({ signal }) => api.call('getCalendarIntegrations', { signal }),
  });

/** Browser navigation that starts connecting an account (it returns to /calendar). */
export const connectAccountUrl = (provider: CalendarProvider) =>
  `${config.apiUrl.replace(/\/$/, '')}${CALENDAR_RAW_PATHS.oauthStart.replace(':provider', provider)}`;
