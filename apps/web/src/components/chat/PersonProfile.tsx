import { Avatar, Button, EmptyState, Icon, Skeleton, SpaceBadge } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { KudosDialog, KudosList } from '@/components/announcements/Kudos';
import { Workspace } from '@/components/shell/Workspace';
import { isApiError } from '@/lib/api';
import { useChatEnabled } from '@/lib/chat/enabled';
import { userCardQuery } from '@/lib/chat/queries';
import { usePresence } from '@/lib/chat/stores';
import { personQuery } from '@/lib/contacts/queries';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { membersQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';
import { useOpenDirect } from './actions';
import { presenceDot } from './common';
import { useLocalTime, usePresenceLabel } from './PersonCard';
import { openReportDialog, useReportsEnabled } from './report';

/**
 * Person profile (19.14): a global screen (no space sidebar). Only what the viewer can see:
 * shared spaces and chats come from the person card.
 */
export function PersonProfile({ userId }: { userId: string }) {
  const { t, locale } = useI18n();
  const { data: card, error, isPending } = useQuery(userCardQuery(userId));
  const { data: members } = useQuery(membersQuery({ status: 'active' }));
  const live = usePresence(userId);
  const presence = live ?? card?.presence ?? null;
  const label = usePresenceLabel(presence);
  const local = useLocalTime(card?.timezone ?? null);
  const openDirect = useOpenDirect();
  const chatOn = useChatEnabled();
  const member = members?.items.find((m) => m.user.id === userId);
  const { me, role } = usePermissions();
  const guestViewer = role === 'guest';
  // Birthday and first working day live on the directory profile (absent if contacts is off).
  const { data: person } = useQuery({ ...personQuery(userId), retry: false });
  const [thanking, setThanking] = useState(false);
  const canThank = !!card && !card.isGuest && !guestViewer && me?.user.id !== userId;
  const canReport = useReportsEnabled() && me?.user.id !== userId;

  return (
    <Workspace
      crumbs={[{ label: t('chat.profile.people') }, { label: card?.user.name ?? '' }]}
      bodyClassName="items-center"
    >
      {isPending ? (
        <div className="flex w-full max-w-[880px] flex-col gap-3" aria-busy="true">
          <Skeleton className="size-[88px] rounded-full" />
          <Skeleton className="w-48" />
        </div>
      ) : !card ? (
        <EmptyState
          className="m-auto"
          icon="user"
          title={t(isApiError(error, 'not_found') ? 'chat.profile.notFound' : 'errors.internal')}
        />
      ) : (
        <div className="flex w-full max-w-[880px] flex-col gap-6">
          <section className="flex flex-wrap items-start gap-5">
            <Avatar
              name={card.user.name}
              src={card.user.imageUrl}
              size="xl"
              presence={presenceDot(presence)}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h1 className="m-0 text-wtitle font-bold">{card.user.name}</h1>
              <span className="text-cap text-fg2">
                {t(`admin.members.role.${card.orgRole}`)}
                {card.isGuest ? ` · ${t('chat.person.guest')}` : ''}
              </span>
              {label ? <span className="text-cap font-semibold">{label}</span> : null}
              {local ? (
                <span className="text-cap text-fg2">
                  {t('chat.person.localTime', { time: local.time, city: local.city })}
                </span>
              ) : null}
              {presence?.message ? (
                <span className="mt-1 self-start rounded-md bg-bg2 px-2.5 py-1 text-cap">
                  {presence.message.emoji ? `${presence.message.emoji} ` : ''}
                  {presence.message.text}
                </span>
              ) : null}
            </div>
            <div className="flex gap-2">
              {chatOn ? (
                <Button variant="inv" onClick={() => void openDirect(card.user.id)}>
                  <Icon name="chat" size={16} />
                  {t('chat.person.message')}
                </Button>
              ) : null}
              {canThank ? (
                <Button variant="out" onClick={() => setThanking(true)}>
                  <Icon name="sparkle" size={16} />
                  {t('announcements.kudos.thank')}
                </Button>
              ) : null}
              <Button variant="out" asChild>
                <a href={`mailto:${card.user.email}`}>
                  <Icon name="mail" size={16} />
                  {t('chat.profile.email')}
                </a>
              </Button>
              {canReport ? (
                <Button
                  variant="gh"
                  onClick={() =>
                    openReportDialog({ type: 'user', userId: card.user.id, name: card.user.name })
                  }
                >
                  <Icon name="flag" size={16} />
                  {t('chat.person.report')}
                </Button>
              ) : null}
            </div>
          </section>
          <div className="grid gap-6 md:grid-cols-[1fr_1fr]">
            <section className="flex flex-col gap-2.5 rounded-xl p-5 shadow-line">
              <h2 className="m-0 text-sub font-semibold">{t('chat.profile.details')}</h2>
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-cap">
                <dt className="text-fg2">{t('chat.profile.email')}</dt>
                <dd className="m-0 truncate">{card.user.email}</dd>
                {member?.joinedAt ? (
                  <>
                    <dt className="text-fg2">{t('chat.profile.since')}</dt>
                    <dd className="m-0">
                      {formatDate(member.joinedAt, locale, { month: 'long', year: 'numeric' })}
                    </dd>
                  </>
                ) : null}
                {person?.birthday ? (
                  <>
                    <dt className="text-fg2">{t('announcements.kudos.profile.birthday')}</dt>
                    <dd className="m-0">
                      {formatDate(`2000-${person.birthday}T12:00:00`, locale, {
                        day: 'numeric',
                        month: 'long',
                      })}
                    </dd>
                  </>
                ) : null}
                {person?.startedOn ? (
                  <>
                    <dt className="text-fg2">{t('announcements.kudos.profile.startedOn')}</dt>
                    <dd className="m-0">
                      {formatDate(`${person.startedOn}T12:00:00`, locale, {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                      })}
                    </dd>
                  </>
                ) : null}
                {card.timezone ? (
                  <>
                    <dt className="text-fg2">{t('chat.profile.timezone')}</dt>
                    <dd className="m-0">{card.timezone}</dd>
                  </>
                ) : null}
              </dl>
            </section>
            <section className="flex flex-col gap-2.5 rounded-xl p-5 shadow-line">
              <h2 className="m-0 text-sub font-semibold">{t('chat.profile.sharedSpaces')}</h2>
              {card.sharedSpaces.length ? (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {card.sharedSpaces.map((s) => (
                    <li key={s.id} className="flex items-center gap-2.5 text-cap font-semibold">
                      <SpaceBadge color={s.color} name={s.name} size="md" />
                      {s.name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 text-cap text-fg2">{t('chat.profile.noSpaces')}</p>
              )}
            </section>
          </div>
          {!card.isGuest && !guestViewer ? (
            <section
              aria-label={t('announcements.kudos.profile.received')}
              className="flex flex-col gap-2.5 rounded-xl p-5 shadow-line"
            >
              <h2 className="m-0 text-sub font-semibold">
                {t('announcements.kudos.profile.received')}
              </h2>
              <KudosList userId={userId} />
            </section>
          ) : null}
          {thanking ? <KudosDialog open onOpenChange={setThanking} to={card.user} /> : null}
          <section className="flex flex-col gap-2.5 rounded-xl p-5 shadow-line">
            <h2 className="m-0 text-sub font-semibold">
              {t('chat.profile.sharedChats', { count: card.sharedConversations.length })}
            </h2>
            {card.sharedConversations.length ? (
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                {card.sharedConversations.map((c) => (
                  <li key={c.id}>
                    <Link
                      to="/chat/c/$conversationId"
                      params={{ conversationId: c.id }}
                      className="inline-flex h-8 items-center gap-1.5 rounded-full bg-bg2 px-3 text-cap font-semibold hover:bg-capsule"
                    >
                      <Icon
                        name={c.type === 'direct' ? 'user' : c.type === 'alert' ? 'alert' : 'chat'}
                        size={14}
                      />
                      {c.title}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-cap text-fg2">{t('chat.profile.noChats')}</p>
            )}
          </section>
        </div>
      )}
    </Workspace>
  );
}
