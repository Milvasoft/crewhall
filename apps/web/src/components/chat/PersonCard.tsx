import { type AppLocale } from '@crewhall/i18n';
import {
  Avatar,
  Button,
  cn,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  Icon,
  Skeleton,
  SpaceDot,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode } from 'react';
import { useChatEnabled } from '@/lib/chat/enabled';
import { userCardQuery } from '@/lib/chat/queries';
import { usePresence } from '@/lib/chat/stores';
import { type Presence } from '@/lib/chat/types';
import { formatRelative, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNow } from '@/lib/useNow';
import { useOpenDirect } from './actions';

/**
 * Person card (19.13): 400 ms on an avatar or name (a tap on touch). Same card in chat,
 * pages, boards, notifications and search results.
 */
export function PersonHover({ userId, children }: { userId: string; children: ReactNode }) {
  return (
    <HoverCard openDelay={400} closeDelay={150}>
      <HoverCardTrigger asChild>
        <span className="inline-flex cursor-pointer" data-person={userId}>
          {children}
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" className="w-[300px] p-0">
        <PersonCardBody userId={userId} />
      </HoverCardContent>
    </HoverCard>
  );
}

const BCP47: Record<AppLocale, string> = { tr: 'tr-TR', en: 'en-US' };

/** Minutes the zone is ahead of UTC right now. */
function zoneOffset(timeZone: string, at: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(at));
    const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    return Math.round((asUtc - at) / 60_000);
  } catch {
    return null;
  }
}

export function useLocalTime(timeZone: string | null): {
  time: string;
  city: string;
  diffHours: number;
} | null {
  const { locale } = useI18n();
  const now = useNow(30_000);
  if (!timeZone) return null;
  const theirs = zoneOffset(timeZone, now);
  if (theirs === null) return null;
  const mine = -new Date(now).getTimezoneOffset();
  const time = new Intl.DateTimeFormat(BCP47[locale], {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(now));
  const city = (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
  return { time, city, diffHours: Math.round(((theirs - mine) / 60) * 10) / 10 };
}

/**
 * "Çevrimiçi", "Toplantıda · otomatik", "Rahatsız etmeyin · 14:30'a kadar",
 * "Uzakta · son görülme 20 dk önce"…
 */
export function usePresenceLabel(p: Presence | null): string | null {
  const { t, locale } = useI18n();
  if (!p) return null;
  if (p.auto === 'meeting') return t('chat.presence.autoMeeting');
  if (p.auto === 'screen_share') return t('chat.presence.autoScreen');
  const label = t(`chat.presence.${p.state}`);
  if (p.until && p.state !== 'online' && p.state !== 'offline') {
    return `${label} · ${t('chat.presence.until', { time: formatTime(p.until, locale) })}`;
  }
  if ((p.state === 'away' || p.state === 'offline') && p.lastSeenAt) {
    return `${label} · ${t('chat.presence.lastSeen', { time: formatRelative(p.lastSeenAt, locale) })}`;
  }
  return label;
}

export function PersonCardBody({ userId }: { userId: string }) {
  const { t } = useI18n();
  const { data: card } = useQuery(userCardQuery(userId));
  const live = usePresence(userId);
  const presence = live ?? card?.presence ?? null;
  const label = usePresenceLabel(presence);
  const local = useLocalTime(card?.timezone ?? null);
  const openDirect = useOpenDirect();
  const chatOn = useChatEnabled();

  if (!card) {
    return (
      <div className="flex flex-col gap-3 p-4" aria-busy="true">
        <Skeleton className="size-14 rounded-full" />
        <Skeleton className="w-32" />
        <Skeleton className="w-48" />
      </div>
    );
  }
  const dot = presence && presence.state !== 'offline' ? presence.state : null;
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-3 p-4 pb-3">
        <Avatar name={card.user.name} src={card.user.imageUrl} size="lg" presence={dot} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sub font-semibold">{card.user.name}</span>
          <span className="truncate text-xs text-fg2">
            {t(`admin.members.role.${card.orgRole}`)}
            {card.isGuest ? ` · ${t('chat.person.guest')}` : ''}
          </span>
          {label ? (
            <span className="mt-1 flex items-center gap-1.5 text-xs font-semibold">
              <span
                className={cn(
                  'size-2 rounded-full',
                  dot === 'online'
                    ? 'bg-success'
                    : dot === 'away'
                      ? 'bg-warning'
                      : dot
                        ? 'bg-danger'
                        : 'bg-fg3',
                )}
              />
              {label}
            </span>
          ) : null}
        </div>
      </div>
      {presence?.message ? (
        <p className="mx-4 mb-2 rounded-md bg-bg2 px-3 py-2 text-cap">
          {presence.message.emoji ? `${presence.message.emoji} ` : ''}
          {presence.message.text}
        </p>
      ) : null}
      <dl className="m-0 flex flex-col gap-1.5 border-t border-line px-4 py-3 text-xs">
        {local ? (
          <div className="flex items-center gap-2 text-fg2">
            <Icon name="clock" size={14} />
            <span>
              {t('chat.person.localTime', { time: local.time, city: local.city })}
              {' · '}
              {local.diffHours === 0
                ? t('chat.person.sameTime')
                : t('chat.person.timeDiff', { hours: local.diffHours })}
            </span>
          </div>
        ) : null}
        <div className="flex items-center gap-2 text-fg2">
          <Icon name="mail" size={14} />
          <a href={`mailto:${card.user.email}`} className="truncate hover:underline">
            {card.user.email}
          </a>
        </div>
        {card.sharedSpaces.length ? (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-fg2">
            <span>{t('chat.person.sharedSpaces')}</span>
            {card.sharedSpaces.map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1 font-semibold text-fg">
                <SpaceDot color={s.color} />
                {s.name}
              </span>
            ))}
          </div>
        ) : null}
      </dl>
      <div className="flex gap-2 border-t border-line p-3">
        {chatOn ? (
          <Button
            size="sm"
            variant="inv"
            className="flex-1"
            onClick={() => openDirect(card.user.id)}
          >
            <Icon name="chat" size={15} />
            {t('chat.person.message')}
          </Button>
        ) : null}
        <Button size="sm" variant="out" className="flex-1" asChild>
          <Link to="/people/$userId" params={{ userId: card.user.id }}>
            <Icon name="user" size={15} />
            {t('chat.person.profile')}
          </Link>
        </Button>
      </div>
    </div>
  );
}
