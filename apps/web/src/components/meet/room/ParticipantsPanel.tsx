import { useMe } from '@/lib/session';
import { MEET_ATTRIBUTES, type LobbyRequest, type ModerateAction } from '@crewhall/shared';
import {
  Avatar,
  Button,
  cn,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  toast,
} from '@crewhall/ui';
import { useLocalParticipant, useParticipants } from '@livekit/components-react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Track, type Participant } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { playSound } from '@/lib/chat/sound';
import { useI18n } from '@/lib/i18n/I18nContext';
import { meetKeys, participantsQuery } from '@/lib/meet/queries';
import { useNow } from '@/lib/useNow';
import { clock, MicOff, useFail } from '@/components/meet/bits';
import { PanelShell } from './ChatPanel';
import { handOf, parseMeta, useRoomState } from './context';
import { pinKey, usePin } from './pin';
import { InviteSection } from './InviteSection';
import { VolumeBadge, VolumeButton } from './Volume';
import { useHandQueue } from './Stage';

/** Design 7.8: raised hands first, then everybody; moderators mute, remove, promote. */
export function ParticipantsPanel({ onInvite }: { onInvite: () => void }) {
  const { t } = useI18n();
  const state = useRoomState();
  const participants = useParticipants();
  const hands = useHandQueue(participants);
  const [q, setQ] = useState('');
  const fail = useFail();
  const meetingId = state.meeting?.id;
  const lobby = useLobby();

  const muteAll = useMutation({
    mutationFn: () => api.call('muteAllInMeeting', { params: { meetingId: meetingId! }, body: {} }),
    onSuccess: () => toast(t('meet.people.mutedAll')),
    onError: fail,
  });

  const term = q.trim().toLocaleLowerCase('tr');
  const list = participants.filter(
    (p) => !term || (p.name ?? '').toLocaleLowerCase('tr').includes(term),
  );
  const raised = hands.flatMap((id) => participants.filter((p) => p.identity === id));
  const inMeeting = new Set(
    participants.map((p) => parseMeta(p)?.userId).filter((x): x is string => Boolean(x)),
  );

  return (
    <PanelShell
      title={t('meet.people.title', { count: participants.length })}
      onClose={() => state.setPanel(null)}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={state.guest ? t('meet.people.search') : t('meet.people.searchAll')}
          aria-label={state.guest ? t('meet.people.search') : t('meet.people.searchAll')}
          className="h-9 rounded-lg bg-bg2 px-3 text-sm outline-none placeholder:text-fg3"
        />
        {state.moderator && lobby.items.length ? (
          <section className="flex flex-col gap-2">
            <h3 className="eyebrow">{t('meet.people.lobby', { count: lobby.items.length })}</h3>
            {lobby.items.map((r) => (
              <LobbyRow key={r.id} r={r} onDecide={lobby.decide} />
            ))}
            {lobby.items.length > 1 ? (
              <Button
                size="xs"
                variant="out"
                onClick={() =>
                  lobby.decide(
                    lobby.items.map((r) => r.id),
                    true,
                  )
                }
              >
                {t('meet.lobby.admitAll')}
              </Button>
            ) : null}
          </section>
        ) : null}
        {raised.length ? (
          <section className="flex flex-col gap-1">
            <h3 className="eyebrow">{t('meet.people.hands', { count: raised.length })}</h3>
            {raised.map((p, i) => (
              <HandRow key={p.identity} p={p} n={i + 1} canLower={state.moderator || p.isLocal} />
            ))}
          </section>
        ) : null}
        <section className="flex flex-col gap-1">
          <h3 className="eyebrow">{t('meet.people.inMeeting', { count: participants.length })}</h3>
          {list.map((p) => (
            <PersonRow key={p.identity} p={p} />
          ))}
        </section>
        <InviteSection query={q} inMeeting={inMeeting} />
      </div>
      {state.moderator && !state.guest ? (
        <footer className="flex gap-2 border-t border-line p-3">
          <Button
            size="sm"
            variant="out"
            className="min-w-0 flex-1"
            loading={muteAll.isPending}
            onClick={() => muteAll.mutate()}
          >
            <MicOff size={14} />
            {t('meet.people.muteAll')}
          </Button>
          <Button size="sm" className="min-w-0 flex-1" onClick={onInvite}>
            <Icon name="plus" size={14} />
            {t('meet.people.invite')}
          </Button>
        </footer>
      ) : null}
    </PanelShell>
  );
}

function useModerate() {
  const { t } = useI18n();
  const state = useRoomState();
  const fail = useFail();
  return useMutation({
    mutationFn: (input: { identity: string; action: ModerateAction }) =>
      api.call('moderateMeetingParticipant', {
        params: { meetingId: state.meeting!.id },
        body: input,
      }),
    onSuccess: (_, v) => toast(t(`meet.moderate.done.${v.action}`)),
    onError: fail,
  });
}

function HandRow({ p, n, canLower }: { p: Participant; n: number; canLower: boolean }) {
  const { t } = useI18n();
  const now = useNow(30_000);
  const moderate = useModerate();
  const { localParticipant } = useLocalParticipant();
  const since = handOf(p)
    ? Math.max(0, Math.round((now - new Date(handOf(p)).getTime()) / 60_000))
    : 0;
  const lower = () => {
    if (p.isLocal) void localParticipant.setAttributes({ [MEET_ATTRIBUTES.hand]: '' });
    else moderate.mutate({ identity: p.identity, action: 'lower_hand' });
  };
  return (
    <div className="flex items-center gap-2.5 py-1">
      <Avatar name={p.name ?? p.identity} src={parseMeta(p)?.imageUrl} size="md" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold">
          {p.isLocal ? t('meet.chat.you') : p.name}
        </span>
        <span className="text-xs text-fg3">{t('meet.people.handSince', { n, min: since })}</span>
      </div>
      {canLower ? (
        <Button size="xs" variant="out" onClick={lower}>
          {t('meet.people.lower')}
        </Button>
      ) : null}
    </div>
  );
}

function PersonRow({ p }: { p: Participant }) {
  const { t } = useI18n();
  const meId = useMe()?.user.id;
  const state = useRoomState();
  const moderate = useModerate();
  const meta = parseMeta(p);
  const micOn = p.isMicrophoneEnabled;
  const role =
    meta?.role === 'moderator'
      ? t('meet.roles.moderator')
      : meta?.role === 'guest'
        ? t('meet.guest')
        : meta?.role === 'listener'
          ? t('meet.roles.listener')
          : null;
  // My other device, in the same room.
  const myOtherDevice = !p.isLocal && Boolean(meId) && meta?.userId === meId;
  const act = (action: ModerateAction) => moderate.mutate({ identity: p.identity, action });
  const cameraOn = Boolean(p.getTrackPublication(Track.Source.Camera)?.isMuted === false);
  const { pinned, toggle } = usePin();
  const pin = pinKey(p.identity);
  return (
    <div className="flex items-center gap-2.5 py-1">
      <Avatar name={p.name ?? p.identity} src={meta?.imageUrl} size="md" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold">
          {p.isLocal ? t('meet.room.you', { name: (p.name ?? '').split(' ')[0] ?? '' }) : p.name}
        </span>
        {myOtherDevice ? (
          <span className="text-xs text-fg3">{t('meet.otherDevices.otherDevice')}</span>
        ) : role ? (
          <span className="text-xs text-fg3">{role}</span>
        ) : null}
      </div>
      <IconButton
        size="xs"
        tone="plain"
        aria-pressed={pinned === pin}
        aria-label={t(pinned === pin ? 'meet.room.unpin' : 'meet.room.pin', {
          name: p.name ?? p.identity,
        })}
        className={pinned === pin ? 'text-accent' : 'text-fg3'}
        onClick={() => toggle(pin)}
      >
        <Icon name="pin" size={14} />
      </IconButton>
      {!p.isLocal ? (
        <>
          <VolumeBadge identity={p.identity} className="text-fg2" />
          <VolumeButton identity={p.identity} name={p.name ?? p.identity} />
        </>
      ) : null}
      <span className={micOn ? 'text-fg3' : 'text-danger'}>
        {micOn ? <Icon name="mic" size={14} /> : <MicOff size={14} />}
      </span>
      {state.moderator && !state.guest && !p.isLocal ? (
        <Menu>
          <MenuTrigger asChild>
            <IconButton
              size="xs"
              tone="plain"
              aria-label={t('meet.people.actions', { name: p.name ?? '' })}
            >
              <Icon name="dots" size={14} />
            </IconButton>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem disabled={!micOn} onSelect={() => act('mute')}>
              {t('meet.moderate.mute')}
            </MenuItem>
            <MenuItem disabled={!cameraOn} onSelect={() => act('stop_camera')}>
              {t('meet.moderate.stop_camera')}
            </MenuItem>
            {p.isScreenShareEnabled ? (
              <MenuItem onSelect={() => act('stop_screen_share')}>
                {t('meet.moderate.stop_screen_share')}
              </MenuItem>
            ) : null}
            {meta?.role === 'guest' ? (
              <MenuItem onSelect={() => act('allow_screen_share')}>
                {t('meet.moderate.allow_screen_share')}
              </MenuItem>
            ) : null}
            {meta?.role === 'listener' ? (
              <MenuItem onSelect={() => act('allow_publish')}>
                {t('meet.moderate.allow_publish')}
              </MenuItem>
            ) : null}
            {meta && !meta.guest && meta.role !== 'moderator' ? (
              <MenuItem onSelect={() => act('make_moderator')}>
                {t('meet.moderate.make_moderator')}
              </MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem className="text-danger" onSelect={() => act('remove')}>
              {t('meet.moderate.remove')}
            </MenuItem>
          </MenuContent>
        </Menu>
      ) : null}
    </div>
  );
}

function LobbyRow({
  r,
  onDecide,
}: {
  r: LobbyRequest;
  onDecide: (ids: string[], admit: boolean) => void;
}) {
  const { t } = useI18n();
  const now = useNow(1000);
  return (
    <div className="flex items-center gap-2.5">
      <Avatar name={r.name} src={r.user?.imageUrl} size="md" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold">{r.name}</span>
        <span className="text-xs text-fg3">
          {r.guest ? t('meet.guest') : t('meet.lobby.member')} ·{' '}
          {clock((now - new Date(r.requestedAt).getTime()) / 1000)}
        </span>
      </div>
      <Button size="xs" variant="gh" onClick={() => onDecide([r.id], false)}>
        {t('meet.lobby.deny')}
      </Button>
      <Button size="xs" variant="inv" onClick={() => onDecide([r.id], true)}>
        {t('meet.lobby.admit')}
      </Button>
    </div>
  );
}

/** Lobby signals refetch the lobby at most once a second per meeting, however many arrive. */
const LOBBY_REFETCH_MS = 1000;
const lobbyRefetch = new Map<string, { last: number; timer?: number }>();

function refetchLobby(qc: QueryClient, meetingId: string) {
  let entry = lobbyRefetch.get(meetingId);
  if (!entry) lobbyRefetch.set(meetingId, (entry = { last: 0 }));
  if (entry.timer !== undefined) return;
  const e = entry;
  e.timer = window.setTimeout(
    () => {
      e.timer = undefined;
      e.last = Date.now();
      void qc.invalidateQueries({ queryKey: meetKeys.participants(meetingId) });
    },
    Math.max(0, e.last + LOBBY_REFETCH_MS - Date.now()),
  );
}

/** Lobby state for moderators: polled, and refetched when the api pings the room. */
export function useLobby() {
  const state = useRoomState();
  const qc = useQueryClient();
  const fail = useFail();
  const meetingId = state.meeting?.id ?? '';
  const enabled = state.moderator && !state.guest && Boolean(meetingId);
  const q = useQuery({ ...participantsQuery(meetingId, true), enabled });
  const { onSignal, setLobbyWaiting } = state;
  useEffect(
    () =>
      onSignal((s) => {
        if (s.type === 'lobby' && meetingId) refetchLobby(qc, meetingId);
      }),
    [onSignal, qc, meetingId],
  );
  const items = q.data?.lobby ?? [];
  useEffect(() => {
    if (enabled) setLobbyWaiting(items.length);
  }, [enabled, items.length, setLobbyWaiting]);
  const decide = useMutation({
    mutationFn: (v: { ids: string[]; admit: boolean }) =>
      api.call('decideMeetingLobby', {
        params: { meetingId },
        body: { requestIds: v.ids, admit: v.admit },
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: meetKeys.participants(meetingId) }),
    onError: fail,
  });
  return { items, decide: (ids: string[], admit: boolean) => decide.mutate({ ids, admit }) };
}

/** Design 7.15: card top right for moderators when someone knocks. */
export function LobbyCard() {
  const { t } = useI18n();
  const state = useRoomState();
  const lobby = useLobby();
  const [dismissed, setDismissed] = useState<string>('');
  const first = lobby.items[0];
  const sig = lobby.items.map((r) => r.id).join(',');
  const beeped = useRef('');
  useEffect(() => {
    if (!first || sig === beeped.current) return;
    beeped.current = sig;
    beep();
  }, [first, sig]);
  if (!state.moderator || !first || dismissed === sig || state.panel === 'people') return null;
  return (
    <div
      className={cn(
        'absolute top-3 z-20 flex w-[min(340px,calc(100%-24px))] flex-col gap-3 rounded-2xl bg-surface p-4 text-fg shadow-overlay',
        state.panel ? 'right-3 sm:right-[356px]' : 'right-3',
      )}
    >
      {lobby.items.length === 1 ? (
        <div className="flex items-center gap-3">
          <Avatar name={first.name} src={first.user?.imageUrl} size="md" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-bold">{t('meet.lobby.wants', { name: first.name })}</span>
            <span className="text-xs text-fg3">
              {first.guest ? t('meet.lobby.guestByLink') : t('meet.lobby.member')}
            </span>
          </div>
        </div>
      ) : (
        <span className="text-sm font-bold">
          {t('meet.lobby.many', { count: lobby.items.length })}
        </span>
      )}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="gh"
          onClick={() =>
            lobby.items.length === 1 ? lobby.decide([first.id], false) : setDismissed(sig)
          }
        >
          {lobby.items.length === 1 ? t('meet.lobby.deny') : t('meet.lobby.later')}
        </Button>
        <Button
          size="sm"
          variant="pri"
          onClick={() =>
            lobby.decide(
              lobby.items.map((r) => r.id),
              true,
            )
          }
        >
          {lobby.items.length === 1 ? t('meet.lobby.admit') : t('meet.lobby.admitAll')}
        </Button>
      </div>
    </div>
  );
}

/** Short chime (design 7.15 "kısa ses"): the message sound of @crewhall/sounds. */
function beep() {
  playSound('message');
}
