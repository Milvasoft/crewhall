import { type Announcement } from '@crewhall/shared';
import { Badge, cn, Icon } from '@crewhall/ui';
import { Link } from '@tanstack/react-router';
import { PersonAvatar } from '@/components/chat/common';
import { isUnread } from '@/lib/announcements/queries';
import { formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';

/** "Önemli" and "Onay bekliyor" tags of an announcement. */
export function AnnouncementTags({ a }: { a: Announcement }) {
  const { t } = useI18n();
  return (
    <>
      {a.pinnedAt ? (
        <Badge tone="accent" plain>
          <Icon name="pin" size={11} />
          {t('announcements.important')}
        </Badge>
      ) : null}
      {a.requiresAck && !a.my.ackedAt ? (
        <Badge tone="warn">{t('announcements.ackPending')}</Badge>
      ) : null}
    </>
  );
}

export function publishedLabel(a: Announcement, locale: Parameters<typeof formatDate>[1]) {
  return `${formatDate(a.publishedAt, locale)} · ${formatTime(a.publishedAt, locale)}`;
}

/** "12 / 40 kişi okudu" (and confirmations when asked for). */
export function ReadStats({ a, className }: { a: Announcement; className?: string }) {
  const { t } = useI18n();
  return (
    <span className={cn('flex items-center gap-1 text-xs text-fg2', className)}>
      <Icon name="eye" size={12} />
      {t('announcements.readCount', { count: a.readCount, total: a.audienceCount })}
      {a.requiresAck ? (
        <>
          {' · '}
          {t('announcements.ackCount', { count: a.ackCount, total: a.audienceCount })}
        </>
      ) : null}
    </span>
  );
}

/** One row of the feed and of the home card. */
export function AnnouncementRow({ a, compact = false }: { a: Announcement; compact?: boolean }) {
  const { t, locale } = useI18n();
  const unread = isUnread(a);
  const flat = a.body.replace(/\s+/g, ' ').trim();
  return (
    <Link
      to="/announcements/$announcementId"
      params={{ announcementId: a.id }}
      className={cn(
        'press flex gap-3 rounded-xl px-3 py-2.5 transition-colors duration-(--t-fast) hover:bg-bg2',
        !compact && 'bg-surface shadow-line',
      )}
    >
      {a.author ? (
        <PersonAvatar user={a.author} size="base" card={false} />
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-bg2">
          <Icon name="flag" size={16} />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          {unread ? (
            <span
              className="size-2 shrink-0 rounded-full bg-accent"
              aria-label={t('announcements.unread')}
            />
          ) : null}
          <span
            className={cn('min-w-0 truncate text-[14px]', unread ? 'font-bold' : 'font-semibold')}
          >
            {a.title}
          </span>
          <AnnouncementTags a={a} />
        </span>
        {!compact ? <span className="line-clamp-2 text-cap text-fg2">{flat}</span> : null}
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-fg3">
          <span>
            {a.author?.name ?? t('announcements.unknownAuthor')} · {publishedLabel(a, locale)}
          </span>
          {!compact ? <ReadStats a={a} /> : null}
        </span>
      </span>
    </Link>
  );
}
