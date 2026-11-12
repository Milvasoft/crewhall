import { queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Query keys and fetchers of the meet module (design 07). */
export const meetKeys = {
  all: ['meet'] as const,
  home: () => ['meet', 'home'] as const,
  list: (view: string) => ['meet', 'list', view] as const,
  history: (filter: Record<string, string | boolean | undefined>) =>
    ['meet', 'history', filter] as const,
  meeting: (id: string) => ['meet', 'meeting', id] as const,
  link: (slug: string) => ['meet', 'link', slug] as const,
  linkMeeting: (slug: string) => ['meet', 'link-meeting', slug] as const,
  participants: (id: string) => ['meet', 'participants', id] as const,
  recordings: (id: string) => ['meet', 'recordings', id] as const,
  recordingTarget: (id: string) => ['meet', 'recording-target', id] as const,
  session: (id: string) => ['meet', 'session', id] as const,
  spaceSettings: (id: string) => ['meet', 'space-settings', id] as const,
};

const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

export const meetHomeQuery = () =>
  queryOptions({
    queryKey: meetKeys.home(),
    queryFn: ({ signal }) => api.call('getMeetHome', { query: { tz: timeZone() }, signal }),
    // Open rooms change as people come and go (webhooks); no WS for meet yet.
    refetchInterval: 15_000,
    staleTime: 5_000,
  });

export const meetingsQuery = (view: 'upcoming' | 'rooms' | 'all') =>
  queryOptions({
    queryKey: meetKeys.list(view),
    queryFn: ({ signal }) => api.call('listMeetings', { query: { view, limit: 100 }, signal }),
  });

export const meetHistoryQuery = (filter: { recorded?: boolean; meetingId?: string } = {}) =>
  queryOptions({
    queryKey: meetKeys.history(filter),
    queryFn: ({ signal }) =>
      api.call('listMeetingHistory', {
        query: {
          limit: 50,
          meetingId: filter.meetingId,
          recorded: filter.recorded === undefined ? undefined : filter.recorded ? 'true' : 'false',
        },
        signal,
      }),
  });

export const meetingQuery = (meetingId: string) =>
  queryOptions({
    queryKey: meetKeys.meeting(meetingId),
    queryFn: ({ signal }) => api.call('getMeeting', { params: { meetingId }, signal }),
  });

export const meetingLinkQuery = (slug: string) =>
  queryOptions({
    queryKey: meetKeys.link(slug),
    queryFn: ({ signal }) => api.call('getMeetingLink', { params: { slug }, signal }),
    retry: false,
    refetchInterval: 10_000,
  });

export const linkMeetingQuery = (slug: string) =>
  queryOptions({
    queryKey: meetKeys.linkMeeting(slug),
    queryFn: ({ signal }) => api.call('resolveMeetingLink', { params: { slug }, signal }),
    retry: false,
  });

export const participantsQuery = (meetingId: string, moderator: boolean) =>
  queryOptions({
    queryKey: meetKeys.participants(meetingId),
    queryFn: ({ signal }) => api.call('listMeetingParticipants', { params: { meetingId }, signal }),
    // Moderators watch the lobby (a LiveKit signal also triggers a refetch). Fresh for a moment:
    // the lobby card and the people panel share it, and remounts must not refetch each time.
    refetchInterval: moderator ? 5_000 : 30_000,
    staleTime: 4_000,
  });

export const recordingTargetQuery = (meetingId: string) =>
  queryOptions({
    queryKey: meetKeys.recordingTarget(meetingId),
    queryFn: ({ signal }) => api.call('getRecordingTarget', { params: { meetingId }, signal }),
  });

export const sessionQuery = (sessionId: string) =>
  queryOptions({
    queryKey: meetKeys.session(sessionId),
    queryFn: ({ signal }) => api.call('getMeetingSession', { params: { sessionId }, signal }),
    // The recording card shows progress until the Drive file exists (design 7.17).
    refetchInterval: (q) =>
      q.state.data?.recordings.some((r) => r.status === 'processing' || r.status === 'recording')
        ? 5_000
        : false,
  });

export const meetSpaceSettingsQuery = (spaceId: string) =>
  queryOptions({
    queryKey: meetKeys.spaceSettings(spaceId),
    queryFn: ({ signal }) => api.call('getMeetSpaceSettings', { params: { spaceId }, signal }),
  });
