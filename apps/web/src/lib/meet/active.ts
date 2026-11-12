import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api } from '@/lib/api';
import { useModuleEnabled } from '@/lib/identity/modules';
import { usePermissions } from '@/lib/session';
import { useMeetingElsewhere } from './window';

export const activeMeetingsKey = ['meet', 'active'] as const;

/** The meetings I am in on any device. WS `meet.active` refreshes it; the timer is the fallback. */
export const activeMeetingsQuery = () => ({
  queryKey: activeMeetingsKey,
  queryFn: ({ signal }: { signal: AbortSignal }) => api.call('listActiveMeetings', { signal }),
  refetchInterval: 30_000,
  staleTime: 5_000,
});

// The room open in this very tab: it is not "another device".
let hereSlug: string | null = null;
const listeners = new Set<() => void>();

/** RoomView says which meeting this tab is in until the returned function is called. */
export function markInRoomHere(slug: string): () => void {
  hereSlug = slug;
  listeners.forEach((l) => l());
  return () => {
    if (hereSlug === slug) hereSlug = null;
    listeners.forEach((l) => l());
  };
}

function useInRoomHere() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => hereSlug,
    () => null,
  );
}

/**
 * Meetings I am in on another device: not this tab, and not another tab of this browser (that one
 * has its own strip, "Toplantıdasın · Sekmeye geç").
 */
export function useMeetingsOnOtherDevices() {
  const meetOn = useModuleEnabled('meet');
  const { role } = usePermissions();
  const here = useInRoomHere();
  const otherTab = useMeetingElsewhere();
  const { data } = useQuery({
    ...activeMeetingsQuery(),
    enabled: meetOn && role !== 'guest',
  });
  return (data?.items ?? []).filter((m) => m.slug !== here && m.slug !== otherTab?.slug);
}
