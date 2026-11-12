import { useQuery } from '@tanstack/react-query';
import { useModuleEnabled } from '@/lib/identity/modules';
import { usePermissions } from '@/lib/session';
import { meetHomeQuery } from './queries';

/**
 * Whether people are in this meeting right now, for a meeting chat's icon in the chat list
 * (green while live). One shared request (Meet home), slower than the Meet page itself.
 */
export function useMeetingLive(meetingId: string | null | undefined): boolean {
  const meetOn = useModuleEnabled('meet');
  const { role } = usePermissions();
  const { data } = useQuery({
    ...meetHomeQuery(),
    enabled: meetOn && role !== 'guest' && Boolean(meetingId),
    refetchInterval: 30_000,
  });
  if (!meetingId || !data) return false;
  return [...data.live, ...data.rooms].some((m) => m.id === meetingId && Boolean(m.live));
}
