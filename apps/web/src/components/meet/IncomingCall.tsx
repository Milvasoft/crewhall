import { type Call } from '@crewhall/shared';
import { Avatar, Button, Icon } from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { useLendTitleBarColors } from '@/lib/desktop-titlebar';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useModuleEnabled } from '@/lib/identity/modules';
import { callKeys, incomingCallsQuery, ringsFor } from '@/lib/meet/calls';
import { announceRing, askForCallNotifications, playTone, ringSilenced } from '@/lib/meet/ring';
import { useMe } from '@/lib/session';
import { EndCallIcon, useFail } from './bits';
import { useOpenMeeting } from './openMeeting';

/**
 * H7: an incoming call takes the whole screen and rings, wherever the person is in the app
 * (mounted once in the signed-in shell). Calls arrive over the WebSocket (call.ringing); the
 * list is also fetched once so a reload while it rings still shows it.
 */
export function IncomingCall() {
  const me = useMe();
  const meetOn = useModuleEnabled('meet');
  const enabled = Boolean(me) && meetOn;
  const incoming = useQuery({ ...incomingCallsQuery(), enabled });
  const userId = me?.user.id ?? '';
  const call = (incoming.data?.items ?? []).find((c) => ringsFor(c, userId));
  if (!enabled || !call) return null;
  return <Ringing key={call.id} call={call} />;
}

/** "X sesli/görüntülü arıyor", or "X seni toplantıya çağırıyor" for a ring into a meeting. */
const ringKey = (call: Call) =>
  call.invite
    ? 'meet.call.incomingInvite'
    : call.video
      ? 'meet.call.incomingVideo'
      : 'meet.call.incomingVoice';

function Ringing({ call }: { call: Call }) {
  const { t } = useI18n();
  // Desktop app: the window buttons take the dark ringing screen's colour while it shows.
  const screenRef = useRef<HTMLDivElement>(null);
  useLendTitleBarColors(screenRef, true);
  const qc = useQueryClient();
  const openMeeting = useOpenMeeting();
  const fail = useFail();

  const meId = useMe()?.user.id ?? '';
  useEffect(() => playTone('incoming', { silent: ringSilenced(qc, meId) }), [qc, meId]);
  // Seen even when the sound cannot play or the tab is in the background.
  // Rung into a call someone else started: the name is whoever rang.
  const ringer = call.members.find((m) => m.user.id === meId)?.by ?? call.caller;
  const ringText = t(ringKey(call), { name: ringer?.name ?? t('chat.mention.unknown') });
  useEffect(
    () => announceRing(ringText, { tag: `call-${call.id}`, body: call.conversationTitle ?? '' }),
    [ringText, call.id, call.conversationTitle],
  );

  const drop = () =>
    qc.setQueryData<{ items: Call[] }>(callKeys.incoming, (old) => ({
      items: (old?.items ?? []).filter((c) => c.id !== call.id),
    }));
  const answer = useMutation({
    mutationFn: () => api.call('answerCall', { params: { callId: call.id } }),
    onSuccess: (c) => {
      drop();
      openMeeting(c.slug, { call: c.id });
    },
    onError: (e) => {
      drop();
      fail(e);
    },
  });
  const decline = useMutation({
    mutationFn: (busy: boolean) =>
      api.call('declineCall', { params: { callId: call.id }, body: { busy } }),
    onSuccess: drop,
    onError: drop,
  });

  const name = ringer?.name ?? t('chat.mention.unknown');
  const pending = answer.isPending || decline.isPending;
  return (
    <div
      ref={screenRef}
      role="alertdialog"
      aria-modal="true"
      aria-label={t(ringKey(call), { name })}
      data-theme="dark"
      className="fixed inset-0 z-[80] flex flex-col items-center justify-center gap-8 bg-[#0d0e0f]/95 p-6 text-white"
    >
      <div className="flex flex-col items-center gap-4 text-center">
        <span className="relative flex">
          <span className="absolute inset-0 animate-ping rounded-full bg-success/30" />
          <Avatar name={name} src={ringer?.imageUrl} size="xl" />
        </span>
        <h1 className="m-0 text-h1 font-bold">{name}</h1>
        <p className="m-0 text-sm text-white/70">
          {t(ringKey(call), { name })}
          {call.conversationTitle ? ` · ${call.conversationTitle}` : ''}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button
          variant="pri"
          size="lg"
          loading={answer.isPending}
          disabled={pending}
          onClick={() => {
            askForCallNotifications();
            answer.mutate();
          }}
        >
          <Icon name={call.video ? 'video' : 'call'} size={18} />
          {call.invite ? t('meet.actions.join') : t('meet.call.accept')}
        </Button>
        <Button
          variant="dngf"
          size="lg"
          disabled={pending}
          onClick={() => {
            askForCallNotifications();
            decline.mutate(false);
          }}
        >
          <EndCallIcon />
          {t('meet.call.decline')}
        </Button>
        <Button
          variant="out"
          size="lg"
          disabled={pending}
          onClick={() => {
            askForCallNotifications();
            decline.mutate(true);
          }}
        >
          {t('meet.call.imBusy')}
        </Button>
      </div>
    </div>
  );
}
