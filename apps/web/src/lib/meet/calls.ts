import { type Call, type MeetWsEvent } from '@crewhall/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Calls (H7). `call.ringing` / `call.updated` over the WebSocket keep two caches: the call
 * itself (the caller's "ringing…" banner, the room) and the calls ringing for me (the
 * incoming-call screen). Keys are spelled out like boards' so chat's runtime imports little.
 */
export const callKeys = {
  incoming: ['meet', 'calls', 'incoming'] as const,
  call: (id: string) => ['meet', 'calls', id] as const,
  /** What goes on in a conversation's room (chat header). */
  live: (conversationId: string) => ['meet', 'calls', 'live', conversationId] as const,
};

export const conversationLiveQuery = (conversationId: string) =>
  queryOptions({
    queryKey: callKeys.live(conversationId),
    queryFn: ({ signal }) =>
      api.call('getConversationLive', { params: { conversationId }, signal }),
    // Calls update it over the WebSocket; people coming and going in the room do not.
    refetchInterval: 15_000,
    staleTime: 5_000,
  });

export const incomingCallsQuery = () =>
  queryOptions({
    queryKey: callKeys.incoming,
    queryFn: ({ signal }) => api.call('listIncomingCalls', { signal }),
  });

export const callQuery = (callId: string) =>
  queryOptions({
    queryKey: callKeys.call(callId),
    queryFn: ({ signal }) => api.call('getCall', { params: { callId }, signal }),
  });

/** Ringing for this person. */
export const ringsFor = (call: Call, userId: string) =>
  (call.status === 'ringing' || call.status === 'active') &&
  call.members.some((m) => m.user.id === userId && m.state === 'ringing');

export function handleCallEvent(
  client: QueryClient,
  e: Extract<MeetWsEvent, { call: unknown }>,
  meId: string,
): void {
  const { call } = e;
  client.setQueryData(callKeys.call(call.id), call);
  void client.invalidateQueries({ queryKey: callKeys.live(call.conversationId) });
  client.setQueryData<{ items: Call[] }>(callKeys.incoming, (old) => {
    const rest = (old?.items ?? []).filter((c) => c.id !== call.id);
    return { items: ringsFor(call, meId) ? [...rest, call] : rest };
  });
}
