import { type Call, type CallMemberState, type UserSummary } from '@crewhall/shared';
import { Avatar, Button, Icon, toast } from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { isEmail } from '@/components/common/EmailChips';
import { useFail } from '@/components/meet/bits';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { callKeys, callQuery } from '@/lib/meet/calls';
import { useMemberSearch } from '@/lib/meet/memberSearch';
import { useMe } from '@/lib/session';
import { useNow } from '@/lib/useNow';
import { useRoomState } from './context';

const MAX_RESULTS = 8;
const RING_POLL_MS = 3000;
/** The server rings no one who answered this recently: they are on their way in. */
const JOINING_MS = 30_000;

/**
 * "Toplantıya davet = çaldırma" in the people panel: the search box also finds everybody in the
 * organisation; "Davet et" rings them like a call, and their row shows ringing, joined, turned
 * down or no answer. A typed e-mail address sends a guest the meeting link.
 */
export function InviteSection({
  query,
  inMeeting,
}: {
  query: string;
  /** User ids already in the room (not offered again). */
  inMeeting: ReadonlySet<string>;
}) {
  const { t } = useI18n();
  const state = useRoomState();
  const qc = useQueryClient();
  const fail = useFail();
  const meId = useMe()?.user.id;
  const now = useNow(5000);
  const meeting = state.meeting;
  const [ringId, setRingId] = useState<string | null>(state.callId);
  // Someone who rings on a call they did not start gets no call.updated: ask while it rings.
  const ring = useQuery({
    ...callQuery(ringId ?? ''),
    enabled: Boolean(ringId),
    refetchInterval: (q) =>
      q.state.data?.members.some((m) => m.state === 'ringing') ? RING_POLL_MS : false,
  }).data;
  const searched = useMemberSearch(query, Boolean(meeting));

  const invite = useMutation({
    mutationFn: (userId: string) =>
      api.call('ringToMeeting', {
        params: { meetingId: meeting!.id },
        body: { userIds: [userId] },
      }),
    onSuccess: (call) => {
      qc.setQueryData<Call>(callKeys.call(call.id), call);
      setRingId(call.id);
    },
    onError: fail,
  });
  const mail = useMutation({
    mutationFn: (email: string) =>
      api.call('inviteToMeeting', {
        params: { meetingId: meeting!.id },
        body: { userIds: [], emails: [email] },
      }),
    onSuccess: (_, email) => toast(t('meet.people.mailed', { email })),
    onError: fail,
  });

  if (!meeting || state.guest) return null;
  const memberOf = new Map((ring?.members ?? []).map((m) => [m.user.id, m]));
  // People rung earlier stay listed with how it went; a search adds the organisation.
  const rung = (ring?.members ?? []).map((m) => m.user).filter((u) => !inMeeting.has(u.id));
  const found: UserSummary[] = searched
    .filter((u) => u.id !== meId && !inMeeting.has(u.id))
    .slice(0, MAX_RESULTS);
  const people = [...rung, ...found.filter((u) => !rung.some((r) => r.id === u.id))];
  const email = query.trim().toLowerCase();
  const offerMail = isEmail(email) && meeting.permissions.inviteGuests && !found.length;
  if (!people.length && !offerMail) return null;

  return (
    <section className="flex flex-col gap-1">
      <h3 className="eyebrow">{t('meet.people.toInvite')}</h3>
      {people.map((u) => {
        // Listed but not in the room: "accepted" means on the way in, or they left since.
        const member = memberOf.get(u.id);
        const left = member?.state === 'accepted' && now - Date.parse(member.at) > JOINING_MS;
        const s: CallMemberState | undefined = left ? undefined : member?.state;
        return (
          <div key={u.id} className="flex items-center gap-2.5 py-1">
            <Avatar name={u.name} src={u.imageUrl} size="md" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{u.name}</span>
            {s === 'ringing' ? (
              <span className="flex items-center gap-1.5 text-xs text-fg2">
                <span className="size-2 animate-pulse rounded-full bg-success" />
                {t('meet.people.ringState.ringing')}
              </span>
            ) : s ? (
              <span className="text-xs text-fg3">{t(`meet.people.ringState.${s}`)}</span>
            ) : null}
            {s !== 'ringing' && s !== 'accepted' ? (
              <Button
                size="xs"
                variant="out"
                disabled={invite.isPending}
                onClick={() => invite.mutate(u.id)}
                aria-label={t('meet.people.inviteOne', { name: u.name })}
              >
                <Icon name="call" size={13} />
                {member ? t('meet.people.ringAgain') : t('meet.people.ring')}
              </Button>
            ) : null}
          </div>
        );
      })}
      {offerMail ? (
        <div className="flex items-center gap-2.5 py-1">
          <span className="flex size-8 items-center justify-center rounded-full bg-bg2">
            <Icon name="mail" size={15} />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm">{email}</span>
          <Button
            size="xs"
            variant="out"
            disabled={mail.isPending}
            onClick={() => mail.mutate(email)}
          >
            {t('meet.people.mailLink')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
