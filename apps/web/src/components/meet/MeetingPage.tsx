import { readPrefs } from '@/lib/meet/prefs';
import { markInRoomHere, useMeetingsOnOtherDevices } from '@/lib/meet/active';
import { type LobbyRequest, type Meeting, type MeetingConnection } from '@crewhall/shared';
import { Button, EmptyState, Icon, Spinner } from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { callQuery } from '@/lib/meet/calls';
import { mediaAvailable } from '@/lib/meet/media';
import { announceMeeting, closeMeetingWindow, isMeetingWindow } from '@/lib/meet/window';
import { linkMeetingQuery, meetKeys } from '@/lib/meet/queries';
import { useMe } from '@/lib/session';
import { useNow } from '@/lib/useNow';
import { meetingWhere, useDuration, useFail } from './bits';
import { MeetingMenuButton } from './MeetingActions';
import { PreJoin } from './PreJoin';
import { RoomView, type JoinChoices } from './room/RoomView';

/**
 * Joining from another device's meeting. A device added beside the first starts silent, or the two
 * would hear each other; moving brings the usual choices along.
 */
function deviceJoin(meetingId: string, device: 'transfer' | 'add') {
  const media = mediaAvailable();
  const prefs = readPrefs();
  const choices: JoinChoices =
    device === 'add'
      ? { audio: false, video: false, speakerOff: true }
      : { audio: media && !prefs.joinMuted, video: media && !prefs.joinCameraOff };
  return { meetingId, choices, device };
}

type Stage =
  | { kind: 'prejoin' }
  | { kind: 'lobby'; request: LobbyRequest; choices: JoinChoices }
  | { kind: 'room'; connection: MeetingConnection; meeting: Meeting; choices: JoinChoices }
  | { kind: 'removed' }
  /** H9: the room could not be reached (media path blocked). */
  | { kind: 'failed' }
  /** Moved to another device of mine. */
  | { kind: 'transferred'; meeting: Meeting }
  /** In the room, the connection broke and did not come back. */
  | { kind: 'dropped'; meeting: Meeting; choices: JoinChoices };

/** A member opening a room (design 7.3 → 7.4): waiting room, maybe the lobby, the room. */
export function MeetingPage({
  slug,
  callId,
  device,
}: {
  slug: string;
  callId?: string;
  /** Chosen on the "Şu an bu toplantıdasın" strip: joins at once. */
  device?: 'transfer' | 'add';
}) {
  const { t } = useI18n();
  const q = useQuery(linkMeetingQuery(slug));
  const call = useQuery({ ...callQuery(callId ?? ''), enabled: Boolean(callId) });
  const [stage, setStage] = useState<Stage>({ kind: 'prejoin' });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fail = useFail();
  const me = useMe();

  const join = useMutation({
    mutationFn: (v: { meetingId: string; choices: JoinChoices; device?: 'transfer' | 'add' }) =>
      api.call('joinMeeting', {
        params: { meetingId: v.meetingId },
        body: { muted: !v.choices.audio, ...(v.device ? { device: v.device } : {}) },
      }),
    onSuccess: (r, v) => {
      if (r.status === 'joined') {
        setStage({
          kind: 'room',
          connection: r.connection,
          meeting: r.meeting,
          choices: v.choices,
        });
      } else setStage({ kind: 'lobby', request: r.request, choices: v.choices });
    },
    onError: (e) => {
      fail(e);
      // Closed since this page (or the history row that led here) was loaded.
      if (isApiError(e, 'meet_ended')) void qc.invalidateQueries({ queryKey: meetKeys.all });
    },
  });

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A call (H7) skips the waiting room: in with the microphone, and the camera for video calls.
  const autoJoined = useRef(false);
  useEffect(() => {
    if (!callId || autoJoined.current || !q.data || !call.data) return;
    autoJoined.current = true;
    const media = mediaAvailable();
    join.mutate({
      meetingId: q.data.id,
      choices: { audio: media, video: media && call.data.video },
    });
  }, [callId, q.data, call.data, join]);

  // From the strip on another device's meeting: no waiting room.
  useEffect(() => {
    if (!device || autoJoined.current || !q.data) return;
    autoJoined.current = true;
    join.mutate(deviceJoin(q.data.id, device));
  }, [device, q.data, join]);

  // The meeting's own tab tells the main tab it is open ("Toplantıdasın · Sekmeye geç").
  const inRoom = stage.kind === 'room';
  const title = q.data?.title ?? '';
  useEffect(() => (inRoom ? markInRoomHere(slug) : undefined), [inRoom, slug]);
  // Opened by hand while I am in it on another device: the same two choices as the strip.
  const elsewhere = useMeetingsOnOtherDevices().some((m) => m.slug === slug);
  useEffect(() => {
    if (!inRoom || !isMeetingWindow()) return;
    return announceMeeting({ slug, title });
  }, [inRoom, slug, title]);

  if (q.isLoading || (callId && call.isLoading)) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (q.error || !q.data) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon="video"
          title={t('meet.notFound.title')}
          description={t('meet.notFound.body')}
        >
          <Button asChild variant="out">
            <Link to="/meetings">{t('meet.actions.backToMeetings')}</Link>
          </Button>
        </EmptyState>
      </div>
    );
  }
  const meeting = q.data;

  if (stage.kind === 'room') {
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <RoomView
          meeting={stage.meeting}
          title={stage.meeting.title}
          connection={stage.connection}
          guest={false}
          choices={stage.choices}
          callId={callId ?? null}
          onLeft={(reason) => {
            void qc.invalidateQueries({ queryKey: meetKeys.all });
            // Left by navigating away (home, back): the room's late disconnect must not navigate.
            if (!alive.current) return;
            if (reason === 'removed') return setStage({ kind: 'removed' });
            if (reason === 'transferred') {
              return setStage({ kind: 'transferred', meeting: stage.meeting });
            }
            if (reason === 'dropped') {
              return setStage({ kind: 'dropped', meeting: stage.meeting, choices: stage.choices });
            }
            if (reason === 'error') {
              // A call nobody could join yet stops ringing for the others.
              if (callId && call.data?.status === 'ringing') {
                void api.call('cancelCall', { params: { callId } }).catch(() => undefined);
              }
              return setStage({ kind: 'failed' });
            }
            // The meeting's own tab closes itself; the main tab kept chat and the rest running.
            closeMeetingWindow();
            // A call goes back to its chat, like hanging up.
            const conversationId = call.data?.conversationId;
            if (callId && conversationId) {
              return void navigate({
                to: '/chat/c/$conversationId',
                params: { conversationId },
              });
            }
            const sessionId = stage.connection.sessionId ?? stage.meeting.live?.sessionId;
            if (sessionId) {
              void navigate({ to: '/meetings/summary/$sessionId', params: { sessionId } });
            } else void navigate({ to: '/meetings' });
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-6 text-sm">
        <Link to="/meetings" className="text-fg2 hover:text-fg">
          {t('shell.modules.meet')}
        </Link>
        <Icon name="arrow" size={12} className="text-fg3" />
        <span className="min-w-0 truncate font-semibold">{meeting.title}</span>
        <span className="ml-auto" />
        {meeting.kind === 'scheduled' && meeting.permissions.moderate && !meeting.cancelledAt ? (
          <MeetingMenuButton m={meeting} />
        ) : null}
        <Button asChild size="sm" variant="gh">
          <Link
            to="/meetings"
            onClick={(e) => {
              // In its own tab, "Vazgeç" closes the tab.
              if (isMeetingWindow()) {
                e.preventDefault();
                window.close();
              }
            }}
          >
            {t('meet.actions.cancel')}
          </Link>
        </Button>
      </header>
      {stage.kind === 'failed' ? (
        <div className="m-auto max-w-[520px]">
          <EmptyState
            icon="alert"
            title={t('meet.room.mediaBlockedTitle')}
            description={t('meet.room.mediaBlockedBody')}
          >
            <Button
              variant="pri"
              onClick={() => {
                autoJoined.current = false;
                setStage({ kind: 'prejoin' });
              }}
            >
              {t('meet.room.mediaRetry')}
            </Button>
          </EmptyState>
        </div>
      ) : stage.kind === 'transferred' ? (
        <div className="m-auto max-w-[520px]">
          <EmptyState
            icon="ext"
            title={t('meet.otherDevices.movedTitle')}
            description={t('meet.otherDevices.movedBody')}
          >
            <Button
              variant="pri"
              disabled={join.isPending}
              onClick={() => join.mutate(deviceJoin(stage.meeting.id, 'transfer'))}
            >
              {t('meet.otherDevices.takeBack')}
            </Button>
          </EmptyState>
        </div>
      ) : stage.kind === 'dropped' ? (
        <div className="m-auto max-w-[520px]">
          <EmptyState
            icon="wifi"
            title={t('meet.room.droppedTitle')}
            description={t('meet.room.droppedBody')}
          >
            <Button
              variant="pri"
              disabled={join.isPending}
              onClick={() => join.mutate({ meetingId: stage.meeting.id, choices: stage.choices })}
            >
              {t('meet.room.rejoin')}
            </Button>
          </EmptyState>
        </div>
      ) : stage.kind === 'removed' ? (
        <div className="m-auto">
          <EmptyState
            icon="users"
            title={t('meet.removed.title')}
            description={t('meet.removed.body')}
          >
            <Button variant="pri" onClick={() => setStage({ kind: 'prejoin' })}>
              {t('meet.removed.again')}
            </Button>
          </EmptyState>
        </div>
      ) : stage.kind === 'lobby' ? (
        <MemberLobby
          meeting={meeting}
          request={stage.request}
          onJoined={(connection, m) =>
            setStage({ kind: 'room', connection, meeting: m, choices: stage.choices })
          }
          onCancel={() => setStage({ kind: 'prejoin' })}
        />
      ) : meeting.cancelledAt ? (
        <div className="m-auto max-w-[520px]">
          <EmptyState
            icon="video"
            title={t('meet.prejoin.endedTitle')}
            description={t('meet.prejoin.endedBody')}
          >
            <Button asChild variant="out">
              <Link to="/meetings">{t('meet.actions.backToMeetings')}</Link>
            </Button>
          </EmptyState>
        </div>
      ) : (
        <PreJoin
          heading={t('meet.prejoin.heading')}
          title={meeting.title}
          subtitle={<MeetingSubtitle m={meeting} />}
          inside={(meeting.live?.participants ?? []).map((p) => ({
            name: p.name,
            imageUrl: p.user?.imageUrl,
          }))}
          insideCount={meeting.live?.participantCount ?? 0}
          recording={Boolean(meeting.live?.recording)}
          name={me?.user.name ?? ''}
          joinLabel={meeting.myRole ? t('meet.actions.join') : t('meet.prejoin.askToJoin')}
          joining={join.isPending}
          onJoin={(choices) => join.mutate({ meetingId: meeting.id, choices })}
          footnote={meeting.conversationId ? t('meet.prejoin.chatMembersSee') : undefined}
          elsewhere={
            elsewhere
              ? {
                  transferLabel: t('meet.otherDevices.transfer'),
                  addLabel: t('meet.otherDevices.add'),
                  note: t('meet.otherDevices.here', { title: meeting.title }),
                  onTransfer: (choices) =>
                    join.mutate({ meetingId: meeting.id, choices, device: 'transfer' }),
                  onAdd: () => join.mutate(deviceJoin(meeting.id, 'add')),
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function MeetingSubtitle({ m }: { m: Meeting }) {
  const { t } = useI18n();
  const duration = useDuration();
  const now = useNow(30_000);
  const where = meetingWhere(m, t);
  const live = m.live
    ? t('meet.prejoin.runningFor', {
        time: duration((now - new Date(m.live.startedAt).getTime()) / 1000),
      })
    : null;
  return <>{[where, live].filter(Boolean).join(' · ')}</>;
}

/** A member without direct access waits for a moderator (design 13: "bekleme odasına düşer"). */
function MemberLobby({
  meeting,
  request,
  onJoined,
  onCancel,
}: {
  meeting: Meeting;
  request: LobbyRequest;
  onJoined: (c: MeetingConnection, m: Meeting) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const poll = useQuery({
    queryKey: ['meet', 'lobby-request', request.id],
    queryFn: ({ signal }) =>
      api.call('getLobbyRequest', { params: { requestId: request.id }, signal }),
    refetchInterval: 2000,
  });
  const result = poll.data;
  useEffect(() => {
    if (result?.status === 'joined') onJoined(result.connection, result.meeting);
  }, [result, onJoined]);
  const status = result?.status === 'lobby' ? result.request.status : request.status;
  const denied = status === 'denied' || status === 'expired';
  return (
    <div className="m-auto flex max-w-[440px] flex-col items-center gap-4 p-6 text-center">
      {denied ? <Icon name="alert" size={28} /> : <Spinner />}
      <h1 className="text-h font-bold">
        {denied ? t(`meet.lobby.${status}Title`) : t('meet.lobby.waitingTitle')}
      </h1>
      <p className="text-sm text-fg2">
        {denied ? t('meet.lobby.retryHint') : t('meet.lobby.waitingBody', { title: meeting.title })}
      </p>
      <Button variant="out" onClick={onCancel}>
        {denied ? t('meet.lobby.back') : t('meet.actions.cancel')}
      </Button>
      {poll.error && isApiError(poll.error) ? (
        <p className="text-xs text-danger">{t(`errors.${poll.error.code}`)}</p>
      ) : null}
    </div>
  );
}
