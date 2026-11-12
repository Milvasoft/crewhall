import {
  Button,
  cn,
  Count,
  EmptyState,
  Icon,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { notificationCountsQuery, notificationsQuery } from '@/lib/chat/queries';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useBadgeMotion } from '@/lib/motion';
import { useNow } from '@/lib/useNow';
import { NotificationRow, useNotificationActions } from './NotificationRow';

/** Top bar bell (2.10): unread count, the latest notifications, "Tümünü gör" to 19.17. */
export function NotificationBell() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { data: counts } = useQuery(notificationCountsQuery);
  const unread = counts?.unread ?? 0;
  // A new notification rings the bell once; reading them only shrinks the badge.
  const pulse = useBadgeMotion(unread);
  const [rung, setRung] = useState({ unread, key: 0 });
  if (rung.unread !== unread) {
    setRung({ unread, key: unread > rung.unread ? rung.key + 1 : rung.key });
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          aria-label={
            unread
              ? t('chat.notifications.bellUnread', { count: unread })
              : t('shell.notifications')
          }
          tone="plain"
          size="sm"
        >
          <span
            // Distinct key prefixes: both counters start at 0 and these are siblings.
            key={`ring-${rung.key}`}
            data-testid="bell-icon"
            className={cn('flex origin-top', rung.key > 0 && 'animate-ring')}
          >
            <Icon name="bell" size={18} />
          </span>
          {unread ? (
            <Count
              key={`count-${pulse.key}`}
              tone="accent"
              className={cn(
                'absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 text-[9.5px] leading-4 shadow-[0_0_0_2px_var(--bg)]',
                pulse.className,
              )}
            >
              {unread > 99 ? '99+' : unread}
            </Count>
          ) : null}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-0">
        {open ? <Panel onClose={() => setOpen(false)} /> : null}
      </PopoverContent>
    </Popover>
  );
}

function Panel({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const now = useNow(60_000);
  const act = useNotificationActions();
  const { data, isPending } = useQuery(notificationsQuery({ box: 'inbox' }));
  const items = data?.items.slice(0, 8) ?? [];
  const hasUnread = items.some((n) => !n.readAt);
  return (
    <div className="flex max-h-[min(560px,80vh)] flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="flex-1 text-sub font-semibold">{t('shell.notifications')}</span>
        {hasUnread ? (
          <Button size="xs" variant="gh" onClick={() => void act('read', { all: true })}>
            {t('chat.notifications.readAll')}
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {isPending ? (
          <div className="flex flex-col gap-2 p-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon="bell"
            title={t('shell.noNotifications')}
            description={t('shell.noNotificationsHint')}
          />
        ) : (
          <div className="stagger-in flex flex-col">
            {items.map((n) => (
              <NotificationRow key={n.id} n={n} now={now} onOpen={onClose} />
            ))}
          </div>
        )}
      </div>
      <div className="border-t border-line p-2">
        <Button size="sm" variant="gh" full asChild>
          <Link to="/notifications" onClick={onClose}>
            {t('chat.notifications.seeAll')}
          </Link>
        </Button>
      </div>
    </div>
  );
}
