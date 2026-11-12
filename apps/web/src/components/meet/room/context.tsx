import {
  MEET_ATTRIBUTES,
  type MEET_REACTIONS,
  MEET_SIGNAL_TOPIC,
  MeetParticipantMeta,
  MeetRoomMeta,
  MeetSignal,
  type Meeting,
  type MeetingConnection,
} from '@crewhall/shared';
import { useDataChannel, useRoomContext, useRoomInfo } from '@livekit/components-react';
import { type Participant } from 'livekit-client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/** What the room screens share: the meeting, the caller's connection and live UI state. */
export interface RoomState {
  meeting: Meeting | null;
  /** Shown for guests (no Meeting object). */
  title: string;
  connection: MeetingConnection;
  guest: boolean;
  moderator: boolean;
  panel: 'chat' | 'people' | null;
  setPanel: (p: RoomState['panel']) => void;
  /** Floating reactions per identity (design 7.6: 3 s). */
  reactions: Record<string, { emoji: string; key: number }[]>;
  react: (emoji: (typeof MEET_REACTIONS)[number]) => void;
  unreadChat: number;
  setUnreadChat: (fn: (n: number) => number) => void;
  lobbyWaiting: number;
  setLobbyWaiting: (n: number) => void;
  onSignal: (fn: (s: MeetSignal, from: Participant | undefined) => void) => () => void;
  /** Mic and camera the person joined with (the media health check expects them). */
  wants: { audio: boolean; video: boolean };
  /** The call this room is for (H7), or null for a meeting. */
  callId: string | null;
  /** A guest's knock: their way into the meeting chat. */
  guestTicket: GuestChatTicket | null;
  /** This device was added beside another one and plays no sound until asked. */
  speakerOff?: boolean;
  onSpeakerOff?: (off: boolean) => void;
  /** Media-path errors seen so far (publish, toggles); the room warns when it grows (H9). */
  mediaReports: number;
  reportMediaIssue: () => void;
}

export interface GuestChatTicket {
  requestId: string;
  secret: string;
}

export const RoomCtx = createContext<RoomState | null>(null);

export function useRoomState(): RoomState {
  const v = useContext(RoomCtx);
  if (!v) throw new Error('useRoomState outside the meeting room');
  return v;
}

export function parseMeta(p: Participant | undefined): MeetParticipantMeta | null {
  if (!p?.metadata) return null;
  try {
    const r = MeetParticipantMeta.safeParse(JSON.parse(p.metadata));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function useRoomMeta(): MeetRoomMeta | null {
  const { metadata } = useRoomInfo();
  return useMemo(() => {
    if (!metadata) return null;
    try {
      const r = MeetRoomMeta.safeParse(JSON.parse(metadata));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  }, [metadata]);
}

function decodeSignal(payload: Uint8Array): MeetSignal | null {
  try {
    const parsed = MeetSignal.safeParse(JSON.parse(new TextDecoder().decode(payload)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const handOf = (p: Participant) => p.attributes[MEET_ATTRIBUTES.hand] || '';

/** What this person may send (a moderator can change it during the meeting). */
export function publishRights(p: Pick<Participant, 'permissions'>) {
  const canPublish = p.permissions?.canPublish ?? true;
  const sources = p.permissions?.canPublishSources;
  return {
    canPublish,
    // TrackSource.SCREEN_SHARE
    canShare: canPublish && (sources?.length ? sources.includes(3) : true),
  };
}

/** Builds the shared room state; mounted inside <LiveKitRoom>. */
export function useRoomStateValue(input: {
  meeting: Meeting | null;
  title: string;
  connection: MeetingConnection;
  guest: boolean;
  wants: { audio: boolean; video: boolean };
  mediaReports: number;
  callId: string | null;
  guestTicket: GuestChatTicket | null;
}): RoomState {
  const [ownReports, setOwnReports] = useState(0);
  const reportMediaIssue = useCallback(() => setOwnReports((n) => n + 1), []);
  const room = useRoomContext();
  // Dev only: the e2e suite reads track state from the live room (e2e/smoke/meet.spec.ts).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as { __crewhallRoom?: unknown };
    w.__crewhallRoom = room;
    return () => {
      if (w.__crewhallRoom === room) delete w.__crewhallRoom;
    };
  }, [room]);
  const [panel, setPanel] = useState<RoomState['panel']>(null);
  const [reactions, setReactions] = useState<RoomState['reactions']>({});
  const [unreadChat, setUnread] = useState(0);
  const [lobbyWaiting, setLobbyWaiting] = useState(0);
  const listeners = useRef(new Set<(s: MeetSignal, from: Participant | undefined) => void>());
  const counter = useRef(0);

  const showReaction = useCallback((identity: string, emoji: string) => {
    const key = ++counter.current;
    setReactions((r) => ({ ...r, [identity]: [...(r[identity] ?? []), { emoji, key }] }));
    window.setTimeout(() => {
      setReactions((r) => ({ ...r, [identity]: (r[identity] ?? []).filter((x) => x.key !== key) }));
    }, 3000);
  }, []);

  const { send } = useDataChannel(MEET_SIGNAL_TOPIC, (msg) => {
    const signal = decodeSignal(msg.payload);
    if (!signal) return;
    // Lobby news only comes from the api (no sender); a participant cannot fake or flood it.
    if (signal.type === 'lobby' && msg.from) return;
    if (signal.type === 'reaction' && msg.from) showReaction(msg.from.identity, signal.emoji);
    if (signal.type === 'lobby') setLobbyWaiting(signal.waiting);
    for (const l of listeners.current) l(signal, msg.from);
  });

  const react = useCallback<RoomState['react']>(
    (emoji) => {
      const signal: MeetSignal = { type: 'reaction', emoji };
      void send(new TextEncoder().encode(JSON.stringify(signal)), { reliable: false });
      showReaction(room.localParticipant.identity, emoji);
    },
    [send, showReaction, room],
  );

  const onSignal = useCallback<RoomState['onSignal']>((fn) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  const setPanelAndRead = useCallback<RoomState['setPanel']>((p) => {
    if (p === 'chat') setUnread(() => 0);
    setPanel(p);
  }, []);

  // One stable object per change: every consumer re-renders when it changes.
  const { meeting, title, connection, guest, wants, callId, guestTicket } = input;
  const mediaReports = input.mediaReports + ownReports;
  return useMemo(
    () => ({
      meeting,
      title,
      connection,
      guest,
      wants,
      callId,
      guestTicket,
      moderator: connection.role === 'moderator',
      panel,
      setPanel: setPanelAndRead,
      reactions,
      react,
      unreadChat,
      setUnreadChat: setUnread,
      lobbyWaiting,
      setLobbyWaiting,
      onSignal,
      mediaReports,
      reportMediaIssue,
    }),
    [
      meeting,
      title,
      connection,
      guest,
      wants,
      callId,
      guestTicket,
      panel,
      setPanelAndRead,
      reactions,
      react,
      unreadChat,
      lobbyWaiting,
      onSignal,
      mediaReports,
      reportMediaIssue,
    ],
  );
}
