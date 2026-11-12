import { MEET_ATTRIBUTES, type Message } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useChat, useRoomContext } from '@livekit/components-react';
import { useQuery } from '@tanstack/react-query';
import {
  ConnectionState,
  ParticipantEvent,
  RoomEvent,
  type Participant,
  type RemoteParticipant,
} from 'livekit-client';
import { useCallback, useEffect, useRef } from 'react';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { callQuery } from '@/lib/meet/calls';
import { readPrefs } from '@/lib/meet/prefs';
import { playCue } from '@/lib/meet/ring';
import { useMe } from '@/lib/session';
import { handOf, useRoomState, type GuestChatTicket } from './context';

/** Above this many people in the room, joins and leaves make no sound and no toast. */
export const CUE_CROWD = 8;
/** At most this many cues in `CUE_BURST_MS`: a crowd arriving at the start plays the first few. */
export const CUE_BURST = 3;
export const CUE_BURST_MS = 5000;
/** Room cues show in a corner: the control bar (where other toasts sit) stays clickable. */
const CORNER = 'top-right' as const;
/** Joins right after connecting (or reconnecting) are the people already inside. */
const SETTLE_MS = 2000;

/**
 * Whether a join or leave cue may play now. `recent` holds the times of the cues played
 * lately (pruned here); a cue that plays is added.
 */
export function cueAllowed(recent: number[], now: number, people: number): boolean {
  while (recent.length && now - recent[0]! > CUE_BURST_MS) recent.shift();
  if (people > CUE_CROWD || recent.length >= CUE_BURST) return false;
  recent.push(now);
  return true;
}

const nameOf = (p: Participant) => p.name || p.identity;

/**
 * Someone joins or leaves: a short soft sound (the personal setting can turn it off) and
 * "X katıldı" in the corner. Quiet in a crowded meeting and for a burst of joins.
 */
export function usePresenceCues() {
  const { t } = useI18n();
  const room = useRoomContext();
  const recent = useRef<number[]>([]);
  const settledAt = useRef(Number.POSITIVE_INFINITY);

  useEffect(() => {
    const settle = () => {
      settledAt.current = Date.now() + SETTLE_MS;
    };
    if (room.state === ConnectionState.Connected) settle();
    const people = () => room.remoteParticipants.size + 1;
    const ready = () => room.state === ConnectionState.Connected && Date.now() >= settledAt.current;
    const joined = (p: RemoteParticipant) => {
      if (!ready() || !cueAllowed(recent.current, Date.now(), people())) return;
      if (readPrefs().joinLeaveSound) playCue('joined');
      toast(t('meet.room.joinedToast', { name: nameOf(p) }), { duration: 2500, position: CORNER });
    };
    const left = () => {
      // Our own disconnect reports everybody as gone: not a leave.
      if (!ready() || !cueAllowed(recent.current, Date.now(), people() + 1)) return;
      if (readPrefs().joinLeaveSound) playCue('left');
    };
    room.on(RoomEvent.Connected, settle);
    room.on(RoomEvent.Reconnected, settle);
    room.on(RoomEvent.ParticipantConnected, joined);
    room.on(RoomEvent.ParticipantDisconnected, left);
    return () => {
      room.off(RoomEvent.Connected, settle);
      room.off(RoomEvent.Reconnected, settle);
      room.off(RoomEvent.ParticipantConnected, joined);
      room.off(RoomEvent.ParticipantDisconnected, left);
    };
  }, [room, t]);
}

/** How long one has to keep talking for the raised hand to go down by itself. */
export const SPEAK_LOWERS_MS = 1500;
/** A hand just raised does not go down at once (people raise it and start a sentence). */
const HAND_GRACE_MS = 3000;

/**
 * Raised hands are noticed: "X elini kaldırdı" (longer for moderators, who give the floor), and
 * the person's own hand goes down when they get the floor and talk for a moment.
 */
export function useHandCues() {
  const { t } = useI18n();
  const room = useRoomContext();
  const { moderator } = useRoomState();

  useEffect(() => {
    const changed = (attrs: Record<string, string>, p: Participant) => {
      if (p.isLocal || !(MEET_ATTRIBUTES.hand in attrs) || !attrs[MEET_ATTRIBUTES.hand]) return;
      toast(t('meet.room.handToast', { name: nameOf(p) }), {
        duration: moderator ? 6000 : 2500,
        position: CORNER,
      });
    };
    room.on(RoomEvent.ParticipantAttributesChanged, changed);
    return () => {
      room.off(RoomEvent.ParticipantAttributesChanged, changed);
    };
  }, [room, t, moderator]);

  useEffect(() => {
    const me = room.localParticipant;
    let timer: number | undefined;
    const speaking = (on: boolean) => {
      window.clearTimeout(timer);
      const hand = handOf(me);
      if (!on || !hand || Date.now() - new Date(hand).getTime() < HAND_GRACE_MS) return;
      timer = window.setTimeout(() => {
        if (me.isSpeaking && handOf(me)) {
          void me.setAttributes({ [MEET_ATTRIBUTES.hand]: '' });
        }
      }, SPEAK_LOWERS_MS);
    };
    me.on(ParticipantEvent.IsSpeakingChanged, speaking);
    return () => {
      window.clearTimeout(timer);
      me.off(ParticipantEvent.IsSpeakingChanged, speaking);
    };
  }, [room]);
}

/**
 * Which chat the meeting talks in: a one-to-one call uses the two people's direct chat, other
 * meetings their own conversation; null for the live (data channel) chat. `pending` while the
 * call is still loading (the answer depends on it).
 */
export function useMeetChatTarget(): { conversationId: string | null; pending: boolean } {
  const state = useRoomState();
  const call = useQuery({ ...callQuery(state.callId ?? ''), enabled: Boolean(state.callId) }).data;
  const direct = call && call.conversationTitle === null ? call.conversationId : null;
  const conversationId = state.guest ? null : (direct ?? state.meeting?.chatConversationId ?? null);
  return { conversationId, pending: Boolean(state.callId) && !call };
}

/** A guest's view of the meeting chat (their ticket, that meeting only). */
export function guestChatQuery(ticket: GuestChatTicket) {
  return {
    queryKey: ['meet', 'guest-chat', ticket.requestId] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api.call('listGuestChat', {
        params: { requestId: ticket.requestId },
        body: { secret: ticket.secret },
        signal,
      }),
    retry: false,
  };
}

/** The meeting has no chat conversation: the room uses its live channel, for guests too. */
export const noMeetingChat = (error: unknown) =>
  isApiError(error, 'not_found') || isApiError(error, 'not_implemented');

export const meetChatKey = (conversationId: string) => ['meet', 'chat', conversationId] as const;

export function meetChatQuery(conversationId: string) {
  return {
    queryKey: meetChatKey(conversationId),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api.call('listMessages', { params: { conversationId }, query: { limit: 50 }, signal }),
    retry: false,
  };
}

/** The first line of a message, short enough for a toast. */
export function previewLine(text: string, max = 80): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const PREVIEW_ID = 'meet-chat-preview';

/**
 * New messages while the chat panel is closed: the count on the chat button (reset when the
 * panel opens; one's own messages do not count) and a short preview that opens the chat.
 */
function useArrived(): (from: string, text: string) => void {
  const state = useRoomState();
  const { t } = useI18n();
  const { panel, setPanel, setUnreadChat } = state;
  const open = panel === 'chat';
  return useCallback(
    (from: string, text: string) => {
      if (open) return;
      setUnreadChat((n) => n + 1);
      toast(
        <button
          type="button"
          className="flex min-w-0 flex-col text-left"
          onClick={() => {
            setPanel('chat');
            toast.dismiss(PREVIEW_ID);
          }}
        >
          <span className="text-xs font-bold">{from}</span>
          <span className="truncate text-sm">{previewLine(text) || t('meet.chat.attachment')}</span>
        </button>,
        { id: PREVIEW_ID, duration: 4000, position: CORNER },
      );
    },
    [open, setPanel, setUnreadChat, t],
  );
}

/** Watches the meeting's chat in the module (or the direct chat of a one-to-one call). */
export function ModuleChatWatch({ conversationId }: { conversationId: string }) {
  const meId = useMe()?.user.id;
  const arrived = useArrived();
  const q = useQuery({ ...meetChatQuery(conversationId), refetchInterval: 4000 });
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const items: Message[] | undefined = q.data?.items;
    if (!items) return;
    if (!seen.current) {
      // What was there when the room opened is not news.
      seen.current = new Set(items.map((m) => m.id));
      return;
    }
    const fresh = items
      .filter((m) => !seen.current!.has(m.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const m of fresh) {
      seen.current.add(m.id);
      const from = m.author?.name ?? m.guestAuthor?.name;
      if (m.deletedAt || !from || m.author?.id === meId || m.kind === 'system') continue;
      arrived(from, m.text);
    }
  }, [q.data, meId, arrived]);
  return null;
}

/** Watches the meeting chat for a guest, or the live chat when the meeting has none. */
function GuestChatWatch({ ticket }: { ticket: GuestChatTicket }) {
  const arrived = useArrived();
  const q = useQuery({ ...guestChatQuery(ticket), refetchInterval: 4000 });
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const items = q.data?.items;
    if (!items) return;
    if (!seen.current) {
      seen.current = new Set(items.map((m) => m.id));
      return;
    }
    for (const m of items) {
      if (seen.current.has(m.id)) continue;
      seen.current.add(m.id);
      if (!m.mine) arrived(m.name, m.text);
    }
  }, [q.data, arrived]);
  return noMeetingChat(q.error) ? <LiveChatWatch /> : null;
}

/** Watches the live chat (no chat module, or a meeting without its conversation). */
export function LiveChatWatch() {
  const { chatMessages } = useChat();
  const arrived = useArrived();
  const seen = useRef(chatMessages.length);
  useEffect(() => {
    const fresh = chatMessages.slice(seen.current);
    seen.current = chatMessages.length;
    for (const m of fresh) {
      if (m.from?.isLocal) continue;
      arrived(m.from ? nameOf(m.from) : '', m.message);
    }
  }, [chatMessages, arrived]);
  return null;
}

/** The chat watcher for this room. */
export function ChatWatch() {
  const { guestTicket } = useRoomState();
  const { conversationId, pending } = useMeetChatTarget();
  if (pending) return null;
  if (guestTicket) return <GuestChatWatch ticket={guestTicket} />;
  return conversationId ? <ModuleChatWatch conversationId={conversationId} /> : <LiveChatWatch />;
}
