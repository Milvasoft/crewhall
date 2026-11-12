import { type Meeting, type MeetingConnection } from '@crewhall/shared';
import { Button, Icon, IconButton, Segmented, Tag, toast, Tooltip } from '@crewhall/ui';
import {
  LiveKitRoom,
  RoomAudioRenderer,
  useAudioPlayback,
  useConnectionQualityIndicator,
  useConnectionState,
  useLocalParticipant,
  useParticipantInfo,
  useRoomContext,
} from '@livekit/components-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ConnectionQuality,
  ConnectionState,
  Room,
  type DisconnectReason,
  type RoomConnectOptions,
  type RoomOptions,
} from 'livekit-client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { softenConnectionDropLogs } from '@/lib/meet/livekitLog';
import { startMediaWatch } from '@/lib/meet/mediaWatch';
import { callQuery } from '@/lib/meet/calls';
import { playTone } from '@/lib/meet/ring';
import { useMe } from '@/lib/session';
import { liveKitUrl } from '@/lib/meet/media';
import { useI18n } from '@/lib/i18n/I18nContext';
import { formatTime } from '@/lib/i18n/format';
import { readPrefs } from '@/lib/meet/prefs';
import { deviceClass, roomOptionsFor } from '@/lib/meet/publish';
import { meetKeys } from '@/lib/meet/queries';
import { useNow } from '@/lib/useNow';
import { clock, EndCallIcon, RecDot, useFail } from '@/components/meet/bits';
import { ChatPanel } from './ChatPanel';
import { ConnectionDetails } from './ConnectionDetails';
import {
  parseMeta,
  RoomCtx,
  useRoomMeta,
  useRoomState,
  useRoomStateValue,
  type GuestChatTicket,
} from './context';
import { ControlBar, SideButtons } from './ControlBar';
import { InviteDialog, RecordDialog, SettingsDialog } from './dialogs';
import { isMediaPathError, mediaNeeds, useMediaHealth } from './mediaHealth';
import { ControlPrompts, RemoteControlProvider } from './RemoteControl';
import { LobbyCard, ParticipantsPanel } from './ParticipantsPanel';
import { PinProvider } from './pin';
import { ChatWatch, useHandCues, usePresenceCues } from './roomCues';
import { Stage, type Layout } from './Stage';
import { DesktopRemoteControl } from './DesktopRemoteControl';
import { VolumeProvider } from './Volume';

softenConnectionDropLogs();

/** Why the room closed. `dropped`: the connection broke and LiveKit could not get it back. */
export type LeftReason = 'left' | 'ended' | 'removed' | 'error' | 'dropped' | 'transferred';

/**
 * LiveKit's DisconnectReason (livekit protocol) → why we left. 1 CLIENT_INITIATED: we left on
 * purpose (hung up, the call ended); 2 DUPLICATE_IDENTITY: moved to another device; 4
 * PARTICIPANT_REMOVED; 5 ROOM_DELETED, 10 ROOM_CLOSED. Anything else after being in the room is
 * a broken connection (reconnecting gave up, the server restarted).
 */
export function leftReason(
  reason: number | undefined,
  {
    connected,
    ended,
    transferred = false,
  }: { connected: boolean; ended: boolean; transferred?: boolean },
): LeftReason {
  if (transferred || reason === 2) return 'transferred';
  const done = ended || reason === 5 || reason === 10;
  if (reason === 4) return 'removed';
  if (done) return 'ended';
  if (reason === 1) return 'left';
  // H9: never got in (the media path could not open): say so instead of just leaving.
  return connected ? 'dropped' : 'error';
}

export interface JoinChoices {
  audio: boolean;
  video: boolean;
  /** A device added beside another one starts without sound, or the two would echo. */
  speakerOff?: boolean;
}

/** Design 07 rules: simulcast 3 layers, adaptive stream, dynacast; audio always first. */
/**
 * Rooms the meeting was ended for: the client disconnects itself on the server's "ended" signal
 * (and after "Herkes için bitir"), so LiveKit reports CLIENT_INITIATED, not ROOM_DELETED.
 */
const endedRooms = new WeakSet<Room>();
/** Rooms left because the meeting moved to another device of this person. */
const transferredRooms = new WeakSet<Room>();

/**
 * Dev only: localStorage "crewhall.dev.iceRelayOnly" = "1" forces TURN-only ICE. On a LiveKit
 * without TURN that reproduces a blocked media path (H9) for the e2e suite and manual checks.
 */
function devConnectOptions(): RoomConnectOptions | undefined {
  if (!import.meta.env.DEV) return undefined;
  try {
    if (localStorage.getItem('crewhall.dev.iceRelayOnly') !== '1') return undefined;
  } catch {
    return undefined;
  }
  return { rtcConfig: { iceTransportPolicy: 'relay' } };
}

function roomOptions(): RoomOptions {
  return roomOptionsFor(readPrefs(), deviceClass());
}

/** The connected room (design 7.4-7.16): always dark, whatever the app theme. */
export function RoomView({
  meeting,
  title,
  connection,
  guest,
  choices,
  callId = null,
  guestTicket = null,
  onLeft,
}: {
  meeting: Meeting | null;
  title: string;
  connection: MeetingConnection;
  guest: boolean;
  choices: JoinChoices;
  /** The call this room is for (H7). */
  callId?: string | null;
  /** A guest's knock: their way into the meeting chat. */
  guestTicket?: GuestChatTicket | null;
  onLeft: (reason: LeftReason) => void;
}) {
  const [room] = useState(() => new Room(roomOptions()));
  const [connectOptions] = useState(devConnectOptions);
  const everConnected = useRef(false);
  const [left, setLeft] = useState(false);
  // Publishing mic/camera at join can fail on the media path (H9): counted, not swallowed.
  const [mediaReports, setMediaReports] = useState(0);
  const [speakerOff, setSpeakerOff] = useState(Boolean(choices.speakerOff));
  const publish = connection.grants.publish;
  const wants = useMemo(
    () => ({ audio: choices.audio && publish, video: choices.video && publish }),
    [choices.audio, choices.video, publish],
  );
  return (
    <div
      data-theme="dark"
      className="flex size-full min-h-0 flex-1 flex-col bg-[#0d0e0f] text-white"
    >
      <style>{`@keyframes meet-float{0%{transform:translateY(0);opacity:0}10%{opacity:1}100%{transform:translateY(-120px);opacity:0}}`}</style>
      <LiveKitRoom
        serverUrl={liveKitUrl(connection.url)}
        token={connection.token}
        connect={!left}
        audio={wants.audio}
        video={wants.video}
        room={room}
        connectOptions={connectOptions}
        className="flex min-h-0 flex-1 flex-col"
        onConnected={() => {
          everConnected.current = true;
        }}
        onDisconnected={(reason?: DisconnectReason) => {
          setLeft(true);
          onLeft(
            leftReason(reason, {
              connected: everConnected.current,
              ended: endedRooms.has(room),
              transferred: transferredRooms.has(room),
            }),
          );
        }}
        onError={(e) => {
          if (isMediaPathError(e)) setMediaReports((n) => n + 1);
        }}
      >
        <Inner
          meeting={meeting}
          title={title}
          connection={connection}
          guest={guest}
          wants={wants}
          mediaReports={mediaReports}
          callId={callId}
          guestTicket={guestTicket}
          speakerOff={speakerOff}
          onSpeakerOff={setSpeakerOff}
        />
        <RoomAudioRenderer muted={speakerOff} />
      </LiveKitRoom>
    </div>
  );
}

function Inner(props: {
  meeting: Meeting | null;
  title: string;
  connection: MeetingConnection;
  guest: boolean;
  wants: { audio: boolean; video: boolean };
  mediaReports: number;
  callId: string | null;
  guestTicket: GuestChatTicket | null;
  speakerOff: boolean;
  onSpeakerOff: (off: boolean) => void;
}) {
  const value = useRoomStateValue(props);
  const room = useRoomContext();
  // "Moderatör yap" changes the metadata while connected; only that re-renders here (not every
  // event of the local participant, which would re-render the whole room).
  useParticipantInfo({ participant: room.localParticipant });
  const role = parseMeta(room.localParticipant)?.role ?? props.connection.role;
  const moderator = role === 'moderator';
  const { speakerOff, onSpeakerOff } = props;
  const ctx = useMemo(
    () => ({ ...value, moderator, speakerOff, onSpeakerOff }),
    [value, moderator, speakerOff, onSpeakerOff],
  );
  return (
    <RoomCtx.Provider value={ctx}>
      <VolumeProvider>
        <RemoteControlProvider>
          <PinProvider>
            <RoomLayout />
          </PinProvider>
          <DesktopRemoteControl />
        </RemoteControlProvider>
      </VolumeProvider>
    </RoomCtx.Provider>
  );
}

function RoomLayout() {
  const { t } = useI18n();
  const state = useRoomState();
  const room = useRoomContext();
  const qc = useQueryClient();
  const fail = useFail();
  const meta = useRoomMeta();
  const connState = useConnectionState();
  const { quality } = useConnectionQualityIndicator({ participant: room.localParticipant });
  const { canPlayAudio, startAudio } = useAudioPlayback();
  const [layout, setLayout] = useState<Layout>('grid');
  const [dialog, setDialog] = useState<'record' | 'settings' | 'invite' | 'stats' | null>(null);
  const [joinedAt] = useState(() => Date.now());
  const [weakDismissed, setWeakDismissed] = useState(false);
  usePresenceCues();
  useHandCues();
  // Audio delay and the network path, sampled through the meeting (lib/meet/mediaWatch).
  useEffect(() => startMediaWatch(room), [room]);

  const startedAt = state.meeting?.live?.startedAt
    ? new Date(state.meeting.live.startedAt).getTime()
    : joinedAt;
  const recording = meta?.recording ?? null;
  const canRecord = Boolean(state.meeting?.permissions.record) && state.moderator && !state.guest;

  const { onSignal, meeting } = state;
  useEffect(
    () =>
      onSignal((s) => {
        if (s.type === 'recording') {
          toast(s.active ? t('meet.room.recordingStarted') : t('meet.room.recordingStopped'));
          if (meeting) void qc.invalidateQueries({ queryKey: meetKeys.meeting(meeting.id) });
        } else if (s.type === 'moderated') {
          toast(t(`meet.moderate.you.${s.action}`));
        } else if (s.type === 'ended') {
          endedRooms.add(room);
          void room.disconnect();
        } else if (s.type === 'transferred') {
          transferredRooms.add(room);
          void room.disconnect();
        }
      }),
    [onSignal, meeting, qc, room, t],
  );

  const stop = useMutation({
    mutationFn: (recordingId: string) =>
      api.call('stopMeetingRecording', { params: { recordingId } }),
    onError: fail,
  });
  const callData = useQuery({
    ...callQuery(state.callId ?? ''),
    enabled: Boolean(state.callId),
  }).data;
  // A call's "Ayrıl" goes through the api: it cancels a ringing call, and ends a one-to-one call
  // for both at once (not only when LiveKit's webhooks arrive).
  const hangUp = async () => {
    if (callData && (callData.status === 'ringing' || callData.status === 'active')) {
      await api.call('hangUpCall', { params: { callId: callData.id } }).catch(() => undefined);
    }
    await room.disconnect();
  };
  const endAll = useMutation({
    mutationFn: () => api.call('endMeetingForAll', { params: { meetingId: state.meeting!.id } }),
    onSuccess: () => {
      endedRooms.add(room);
      void room.disconnect();
    },
    onError: fail,
  });

  // With nothing sent or received (alone, camera and mic off) LiveKit's quality says nothing.
  const { needPublisher, needSubscriber } = mediaNeeds(room);
  const rated = needPublisher || needSubscriber;
  const qualityLabel =
    !rated || quality === ConnectionQuality.Excellent || quality === ConnectionQuality.Good
      ? t('meet.room.qualityGood')
      : quality === ConnectionQuality.Poor
        ? t('meet.room.qualityPoor')
        : quality === ConnectionQuality.Lost
          ? t('meet.room.qualityLost')
          : t('meet.room.qualityGood');
  const weak = rated && (quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost);
  // "Gönderdiğin video düşük kaliteye indirildi · Kameramı kapat" is about a camera that is on.
  const { isCameraEnabled } = useLocalParticipant();

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-2 p-2 sm:gap-3 sm:p-3">
      <header className="flex h-10 shrink-0 items-center gap-2 px-1 sm:gap-3">
        <h1 className="min-w-0 truncate text-[15px] font-bold">{state.title}</h1>
        {state.meeting?.spaceName ? (
          <span className="hidden truncate text-xs text-white/60 sm:inline">
            {state.meeting.spaceName}
          </span>
        ) : null}
        <span className="shrink-0 rounded-md bg-white/10 px-2 py-0.5 font-mono text-xs">
          <Elapsed since={startedAt} />
        </span>
        {recording ? (
          <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-[color-mix(in_srgb,var(--danger)_25%,transparent)] px-2 py-0.5 text-xs font-bold text-[#ffb4ae]">
            <RecDot />
            <span className="hidden sm:inline">
              <RecordingFor since={new Date(recording.startedAt).getTime()} />
            </span>
          </span>
        ) : null}
        <button
          type="button"
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-white/70 hover:bg-white/10 hover:text-white"
          title={t('meet.stats.open', { level: qualityLabel })}
          aria-label={t('meet.stats.open', { level: qualityLabel })}
          onClick={() => setDialog('stats')}
        >
          <Icon name="wifi" size={14} className={weak ? 'text-warning' : 'text-success'} />
          <span className="hidden sm:inline">{qualityLabel}</span>
        </button>
        <Segmented
          className="hidden md:flex"
          size="sm"
          value={layout}
          onValueChange={setLayout}
          aria-label={t('meet.room.layout')}
          options={[
            { value: 'grid', label: t('meet.room.grid') },
            { value: 'speaker', label: t('meet.room.speaker') },
          ]}
        />
        {state.speakerOff ? (
          <Button size="xs" variant="out" onClick={() => state.onSpeakerOff?.(false)}>
            <Icon name="speaker" size={14} />
            {t('meet.otherDevices.speakerOn')}
          </Button>
        ) : null}
        <IconButton
          size="sm"
          tone="plain"
          aria-label={t('meet.room.fullscreen')}
          className="hidden text-white/80 md:inline-flex"
          onClick={() =>
            document.fullscreenElement
              ? void document.exitFullscreen()
              : void document.documentElement.requestFullscreen()
          }
        >
          <Icon name="frame" size={16} />
        </IconButton>
      </header>

      <div className="relative flex min-h-0 flex-1 gap-3">
        <Stage layout={layout} />
        {state.panel === 'chat' ? <ChatPanel /> : null}
        {state.panel === 'people' ? (
          <ParticipantsPanel onInvite={() => setDialog('invite')} />
        ) : null}
        {!state.guest ? <LobbyCard /> : null}
        <ControlPrompts />
        {weak && isCameraEnabled && !weakDismissed ? (
          <div className="absolute top-3 left-1/2 z-10 flex w-max max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center gap-3 rounded-xl bg-[#3a2f12] px-4 py-2 text-sm text-[#ffd98a]">
            {t('meet.room.weakBanner')}
            <Button
              size="xs"
              variant="out"
              onClick={() => void room.localParticipant.setCameraEnabled(false)}
            >
              {t('meet.room.cameraOff')}
            </Button>
            <IconButton
              size="xs"
              tone="plain"
              aria-label={t('common.actions.close')}
              onClick={() => setWeakDismissed(true)}
            >
              <Icon name="x" size={14} />
            </IconButton>
          </div>
        ) : null}
        {!canPlayAudio ? (
          <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
            <Button variant="pri" onClick={() => void startAudio()}>
              <Icon name="speaker" size={16} />
              {t('meet.room.enableAudio')}
            </Button>
          </div>
        ) : null}
      </div>

      <footer className="flex shrink-0 items-center gap-2 sm:gap-3">
        <span className="hidden w-[260px] min-w-0 items-center gap-2 text-xs text-white/60 lg:flex">
          <span className="font-semibold text-white">
            <WallClock />
          </span>
          {state.meeting ? (
            <Tooltip content={t('meet.actions.copyLink')}>
              <button
                type="button"
                className="truncate hover:text-white"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(state.meeting!.url)
                    .then(() => toast(t('meet.linkCopied')))
                }
              >
                {state.meeting.url.replace(/^https?:\/\//, '')}
              </button>
            </Tooltip>
          ) : null}
          {state.guest ? <Tag className="bg-white/10 text-white">{t('meet.guest')}</Tag> : null}
        </span>
        <div className="flex min-w-0 flex-1 justify-start lg:justify-center">
          <ControlBar
            canRecord={canRecord}
            onRecord={() => (recording ? stop.mutate(recording.id) : setDialog('record'))}
            onSettings={() => setDialog('settings')}
            onLeave={() => void hangUp()}
            onEndForAll={() => endAll.mutate()}
          />
        </div>
        <div className="flex shrink-0 justify-end lg:w-[260px]">
          <SideButtons />
        </div>
      </footer>

      <ChatWatch />
      <MediaBanner />
      {state.callId ? <CallBanner callId={state.callId} /> : null}

      {connState === ConnectionState.Reconnecting ||
      connState === ConnectionState.SignalReconnecting ? (
        // The room stays as it is (video keeps playing on a signal-only drop): a strip, not a wall.
        <div
          role="status"
          className="absolute top-14 left-1/2 z-30 flex w-max max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2.5 rounded-full bg-[#3a2f12] px-4 py-2 text-sm font-semibold text-[#ffd98a] shadow-lg"
        >
          <span className="size-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current" />
          {t('meet.room.reconnecting')}
        </div>
      ) : null}

      {dialog === 'record' && state.meeting ? (
        <RecordDialog onOpenChange={(o) => !o && setDialog(null)} />
      ) : null}
      {dialog === 'settings' ? (
        <SettingsDialog onOpenChange={(o) => !o && setDialog(null)} />
      ) : null}
      {dialog === 'invite' && state.meeting ? (
        <InviteDialog onOpenChange={(o) => !o && setDialog(null)} />
      ) : null}
      {dialog === 'stats' ? (
        <ConnectionDetails onOpenChange={(o) => !o && setDialog(null)} />
      ) : null}
    </div>
  );
}

/** Time since the meeting started; ticks on its own so the room does not re-render each second. */
function Elapsed({ since }: { since: number }) {
  const now = useNow(1000);
  return <>{clock((now - since) / 1000)}</>;
}

function RecordingFor({ since }: { since: number }) {
  const { t } = useI18n();
  const now = useNow(1000);
  return <>{t('meet.room.recordingFor', { time: clock((now - since) / 1000) })}</>;
}

function WallClock() {
  const { locale } = useI18n();
  const now = useNow(10_000);
  return <>{formatTime(new Date(now), locale)}</>;
}

/**
 * H9: signalling works but the media path does not (firewall, proxy, node_ip). Shown above the
 * reconnect overlay, which otherwise loops with no explanation.
 */
function MediaBanner() {
  const { t } = useI18n();
  const room = useRoomContext();
  const state = useRoomState();
  const health = useMediaHealth(room, state.mediaReports, state.wants);
  if (!health.blocked) return null;
  return (
    <div
      role="alert"
      className="absolute top-16 left-1/2 z-40 flex w-[min(560px,calc(100%-32px))] -translate-x-1/2 flex-col gap-2 rounded-xl bg-[#3a1d1d] px-4 py-3 text-sm text-[#ffb4b4] shadow-lg"
    >
      <span className="flex items-center gap-2 font-bold text-white">
        <Icon name="alert" size={16} />
        {t('meet.room.mediaBlockedTitle')}
      </span>
      <span>{t('meet.room.mediaBlockedBody')}</span>
      <span className="font-mono text-xs text-white/60">
        {t('meet.room.mediaIce', { publisher: health.publisher, subscriber: health.subscriber })}
      </span>
      <span>
        <Button size="sm" variant="out" onClick={health.retry}>
          <Icon name="refresh" size={14} />
          {t('meet.room.mediaRetry')}
        </Button>
      </span>
    </div>
  );
}

/**
 * H7: the caller waits in the room while the call rings (ringback tone, who is being rung).
 * Nobody answering, a decline or busy ends it after a moment and goes back to the chat.
 */
function CallBanner({ callId }: { callId: string }) {
  const { t } = useI18n();
  const room = useRoomContext();
  const call = useQuery(callQuery(callId)).data;
  // The session's user: the LiveKit identity is empty until the room connects.
  const meId = useMe()?.user.id;
  const caller = Boolean(call && meId && call.caller?.id === meId);
  const ringing = caller && call?.status === 'ringing';
  const over =
    caller &&
    (call?.status === 'missed' || call?.status === 'declined' || call?.status === 'cancelled');

  useEffect(() => (ringing ? playTone('ringback') : undefined), [ringing]);
  useEffect(() => {
    if (!over) return;
    const timer = window.setTimeout(() => void room.disconnect(), 2500);
    return () => window.clearTimeout(timer);
  }, [over, room]);

  if (!call || !caller || !(ringing || over)) return null;
  const who = call.conversationTitle ?? call.members.map((m) => m.user.name).join(', ');
  const busy = call.members.length > 0 && call.members.every((m) => m.state === 'busy');
  const text = ringing
    ? t('meet.call.ringingOut', { name: who })
    : call.status === 'cancelled'
      ? t('meet.call.cancelled')
      : busy
        ? t('meet.call.busy', { name: who })
        : call.status === 'declined'
          ? t('meet.call.declined', { name: who })
          : t('meet.call.noAnswer', { name: who });
  return (
    <div
      role="status"
      className="absolute top-16 left-1/2 z-30 flex w-max max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-3 rounded-xl bg-black/70 px-4 py-3 text-sm font-semibold"
    >
      {ringing ? (
        <span className="size-2.5 animate-pulse rounded-full bg-success" />
      ) : (
        <EndCallIcon size={18} className="text-danger" />
      )}
      {text}
    </div>
  );
}
