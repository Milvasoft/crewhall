import {
  Avatar,
  Checkbox,
  cn,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  toast,
  Tooltip,
} from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { api } from '@/lib/api';
import { chatKeys } from '@/lib/chat/queries';
import { type Notification } from '@/lib/chat/types';
import { errorKey } from '@/lib/errors';
import { formatRelative } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { middleClickOpens } from '@/lib/newTab';
import { notificationBody, notificationPath, notificationTitle } from './text';

export type BulkAction = 'read' | 'unread' | 'snooze' | 'dismiss' | 'restore';

export function useNotificationActions() {
  const qc = useQueryClient();
  const { t } = useI18n();
  return useCallback(
    async (action: BulkAction, target: { ids?: string[]; all?: boolean }, until?: string) => {
      try {
        const counts = await api.call('updateNotifications', {
          body: { action, ...target, until },
        });
        qc.setQueryData(chatKeys.notificationCounts, counts);
        void qc.invalidateQueries({ queryKey: chatKeys.notifications });
      } catch (e) {
        toast.error(t(errorKey(e)));
      }
    },
    [qc, t],
  );
}

/** Snooze choices of 19.17: one hour, tomorrow morning, next week (Monday 08:00). */
export function snoozeTimes(now = new Date()) {
  const hour = new Date(now.getTime() + 3_600_000);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  const week = new Date(now);
  week.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  week.setHours(8, 0, 0, 0);
  return { hour: hour.toISOString(), tomorrow: tomorrow.toISOString(), week: week.toISOString() };
}

export function SnoozeMenu({
  onSnooze,
  children,
}: {
  onSnooze: (until: string) => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const times = snoozeTimes();
  return (
    <Menu>
      <MenuTrigger asChild>{children}</MenuTrigger>
      <MenuContent align="end" className="w-[200px]">
        <MenuItem icon="clock" onSelect={() => onSnooze(times.hour)}>
          {t('chat.notifications.snooze.hour')}
        </MenuItem>
        <MenuItem icon="sun" onSelect={() => onSnooze(times.tomorrow)}>
          {t('chat.notifications.snooze.tomorrow')}
        </MenuItem>
        <MenuItem icon="calendar" onSelect={() => onSnooze(times.week)}>
          {t('chat.notifications.snooze.week')}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** One notification; `selectable` adds the hover checkbox and row tools of the full page. */
export function NotificationRow({
  n,
  now,
  selectable,
  selected,
  onSelect,
  onOpen,
}: {
  n: Notification;
  now: number;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (on: boolean) => void;
  onOpen?: () => void;
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const act = useNotificationActions();
  const unread = !n.readAt;
  const title = notificationTitle(n, t);
  const body = notificationBody(n);
  const critical = n.data.severity === 'critical';

  const open = () => {
    if (unread) void act('read', { ids: [n.id] });
    onOpen?.();
    void navigate({ href: notificationPath(n) });
  };

  return (
    <div
      className={cn(
        'group/n relative flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-bg2',
        selected && 'bg-bg2',
      )}
    >
      {selectable ? (
        <span
          className={cn(
            'pt-2 transition-opacity',
            selected
              ? 'opacity-100'
              : 'opacity-0 group-hover/n:opacity-100 focus-within:opacity-100',
          )}
        >
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onSelect?.(v === true)}
            aria-label={title}
          />
        </span>
      ) : null}
      <span className="relative shrink-0">
        {n.actor ? (
          <Avatar name={n.actor.name} src={n.actor.imageUrl} size="base" />
        ) : n.target.type === 'plugin' ? (
          // The plugin is the source: its icon (from its own origin), or a plug.
          typeof n.data.icon === 'string' && n.data.icon ? (
            <img
              src={n.data.icon}
              alt=""
              referrerPolicy="no-referrer"
              className="size-9 rounded-[10px] bg-bg2 object-cover"
            />
          ) : (
            <span className="flex size-9 items-center justify-center rounded-[10px] bg-bg2">
              <Icon name="plug" size={17} />
            </span>
          )
        ) : (
          <span
            className={cn(
              'flex size-9 items-center justify-center rounded-[10px] bg-bg2',
              critical && 'text-danger',
            )}
          >
            <Icon
              name={n.source === 'alerts' ? 'alert' : n.source === 'drive' ? 'folder' : 'bell'}
              size={17}
            />
          </span>
        )}
        {unread ? (
          <span className="absolute -top-0.5 -left-0.5 size-2.5 rounded-full bg-accent shadow-[0_0_0_2px_var(--bg)]" />
        ) : null}
      </span>
      <button
        type="button"
        onClick={open}
        {...middleClickOpens(() => {
          if (unread) void act('read', { ids: [n.id] });
          return notificationPath(n);
        })}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className={cn('text-cap leading-5', unread ? 'font-bold' : 'font-medium text-fg2')}>
          {title}
          {n.count > 1 ? ` · ${t('chat.notifications.more', { count: n.count })}` : ''}
        </span>
        {body ? <span className="line-clamp-2 text-xs text-fg2">{body}</span> : null}
        <span className="pt-0.5 text-[11px] text-fg3">
          {formatRelative(n.createdAt, locale, new Date(now))}
          {n.snoozedUntil
            ? ` · ${t('chat.notifications.snoozedUntil', { time: formatRelative(n.snoozedUntil, locale, new Date(now)) })}`
            : ''}
        </span>
      </button>
      {critical ? (
        <span className="shrink-0 rounded-xs bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] px-1.5 text-[10.5px] leading-[18px] font-bold text-danger">
          {t('chat.severity.critical')}
        </span>
      ) : null}
      <div className="absolute top-2 right-2 hidden items-center gap-0.5 rounded-full bg-bg p-0.5 shadow-line group-hover/n:flex has-[[data-state=open]]:flex">
        <Tooltip
          content={t(unread ? 'chat.notifications.markRead' : 'chat.notifications.markUnread')}
        >
          <IconButton
            size="xs"
            tone="plain"
            aria-label={t(unread ? 'chat.notifications.markRead' : 'chat.notifications.markUnread')}
            onClick={() => void act(unread ? 'read' : 'unread', { ids: [n.id] })}
          >
            <Icon name={unread ? 'check' : 'eye'} size={14} />
          </IconButton>
        </Tooltip>
        {n.dismissedAt ? (
          <Tooltip content={t('chat.notifications.restore')}>
            <IconButton
              size="xs"
              tone="plain"
              aria-label={t('chat.notifications.restore')}
              onClick={() => void act('restore', { ids: [n.id] })}
            >
              <Icon name="undo" size={14} />
            </IconButton>
          </Tooltip>
        ) : (
          <>
            <SnoozeMenu onSnooze={(until) => void act('snooze', { ids: [n.id] }, until)}>
              <IconButton size="xs" tone="plain" aria-label={t('chat.notifications.snooze.label')}>
                <Icon name="clock" size={14} />
              </IconButton>
            </SnoozeMenu>
            <Tooltip content={t('chat.notifications.dismiss')}>
              <IconButton
                size="xs"
                tone="plain"
                aria-label={t('chat.notifications.dismiss')}
                onClick={() => void act('dismiss', { ids: [n.id] })}
              >
                <Icon name="x" size={14} />
              </IconButton>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}
