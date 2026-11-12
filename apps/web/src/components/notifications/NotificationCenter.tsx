import { type NotificationSource } from '@crewhall/shared';
import {
  Button,
  Chip,
  cn,
  Count,
  EmptyState,
  Icon,
  SelectAllCheckbox,
  Skeleton,
  Switch,
  type IconName,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Fragment, useMemo, useState } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { dayLabel } from '@/components/chat/common';
import { notificationCountsQuery, notificationsQuery } from '@/lib/chat/queries';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useSelection, useSelectionKeys } from '@/lib/selection';
import { useNow } from '@/lib/useNow';
import { sameDay } from '@/lib/chat/text';
import { NotificationPrefsDialog } from './NotificationPrefs';
import { NotificationRow, SnoozeMenu, useNotificationActions } from './NotificationRow';
import { ModuleSidebar } from '@/components/shell/ModuleSidebar';

export interface CenterParams {
  box?: 'inbox' | 'snoozed' | 'dismissed';
  kind?: 'mentions' | 'assigned' | 'alerts';
  source?: NotificationSource;
  unread?: boolean;
}

const SOURCES: { key: NotificationSource; icon: IconName }[] = [
  { key: 'chat', icon: 'chat' },
  { key: 'pages', icon: 'page' },
  { key: 'boards', icon: 'board' },
  { key: 'meetings', icon: 'video' },
  { key: 'drive', icon: 'folder' },
  { key: 'vault', icon: 'vault' },
  { key: 'alerts', icon: 'alert' },
  { key: 'account', icon: 'shield' },
  { key: 'announcements', icon: 'flag' },
];

/** 19.17: every module's notifications by day, with source filter, tabs and bulk actions. */
export function NotificationCenter({ params }: { params: CenterParams }) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const now = useNow(60_000);
  const act = useNotificationActions();
  const box = params.box ?? 'inbox';
  const { data: counts } = useQuery(notificationCountsQuery);
  const { data, isPending } = useQuery(
    notificationsQuery({
      box,
      kind: params.kind,
      source: params.source,
      unreadOnly: params.unread ? 'true' : undefined,
    }),
  );
  const [prefs, setPrefs] = useState(false);
  const items = useMemo(() => data?.items ?? [], [data]);
  const selection = useSelection(items.map((n) => n.id));
  useSelectionKeys(selection);
  const selected = [...selection.selected];

  const set = (patch: Partial<CenterParams>) => {
    selection.clear();
    void navigate({ to: '/notifications', search: { ...params, ...patch } });
  };
  const bulk = (action: Parameters<typeof act>[0], until?: string) => {
    void act(action, { ids: selected }, until);
    selection.clear();
  };

  const sidebar = (
    <ModuleSidebar label={t('shell.notifications')} className="gap-1 px-3 py-4">
      <h2 className="m-0 flex items-center gap-2 px-2 pb-2 text-sub font-bold">
        {t('shell.notifications')}
        {counts?.unread ? <Count tone="accent">{counts.unread}</Count> : null}
      </h2>
      {(['inbox', 'snoozed', 'dismissed'] as const).map((b) => (
        <button
          key={b}
          type="button"
          aria-current={box === b ? 'page' : undefined}
          onClick={() => set({ box: b })}
          className={cn(
            'flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] font-semibold',
            box === b ? 'bg-capsule' : 'text-fg2 hover:bg-bg2',
          )}
        >
          <Icon name={b === 'inbox' ? 'inbox' : b === 'snoozed' ? 'clock' : 'archive'} size={16} />
          <span className="flex-1 text-left">{t(`chat.notifications.box.${b}`)}</span>
          {b === 'inbox' && counts?.unread ? (
            <span className="text-xs text-fg2">{counts.unread}</span>
          ) : null}
          {b === 'snoozed' && counts?.snoozed ? (
            <span className="text-xs text-fg2">{counts.snoozed}</span>
          ) : null}
        </button>
      ))}
      <h3 className="m-0 px-2.5 pt-4 pb-1 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
        {t('chat.notifications.source')}
      </h3>
      {SOURCES.map((s) => (
        <button
          key={s.key}
          type="button"
          aria-pressed={params.source === s.key}
          onClick={() => set({ source: params.source === s.key ? undefined : s.key })}
          className={cn(
            'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px]',
            params.source === s.key ? 'bg-capsule font-semibold' : 'text-fg2 hover:bg-bg2',
          )}
        >
          <Icon name={s.icon} size={15} />
          <span className="flex-1 text-left">{t(`chat.notifications.sources.${s.key}`)}</span>
          {counts?.bySource[s.key] ? (
            <span className="text-xs">{counts.bySource[s.key]}</span>
          ) : null}
        </button>
      ))}
      <Button
        size="sm"
        variant="gh"
        className="mt-auto justify-start"
        onClick={() => setPrefs(true)}
      >
        <Icon name="settings" size={15} />
        {t('chat.notifications.settings')}
      </Button>
    </ModuleSidebar>
  );

  return (
    <Workspace sidebar={sidebar} crumbs={[{ label: t('shell.notifications') }]}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col">
          <h1 className="m-0 text-wtitle font-bold">{t('shell.notifications')}</h1>
          <span className="text-cap text-fg2">{t('chat.notifications.subtitle')}</span>
        </div>
        <label className="ml-auto flex items-center gap-2 text-cap font-semibold">
          <Switch
            checked={Boolean(params.unread)}
            onCheckedChange={(v) => set({ unread: v || undefined })}
            aria-label={t('chat.notifications.unreadOnly')}
          />
          {t('chat.notifications.unreadOnly')}
        </label>
        {box === 'inbox' ? (
          <Button
            size="sm"
            variant="out"
            onClick={() => void act('read', { all: true })}
            disabled={!counts?.unread}
          >
            <Icon name="check" size={15} />
            {t('chat.notifications.readAll')}
          </Button>
        ) : null}
      </div>
      <div className="flex gap-2">
        {([undefined, 'mentions', 'assigned', 'alerts'] as const).map((k) => (
          <Chip key={k ?? 'all'} size="sm" on={params.kind === k} onClick={() => set({ kind: k })}>
            {t(`chat.notifications.tabs.${k ?? 'all'}`)}
          </Chip>
        ))}
      </div>
      {selected.length ? (
        <div
          role="toolbar"
          aria-label={t('chat.notifications.bulk')}
          className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg bg-fg px-3 py-2 text-bg"
        >
          <span className="text-cap font-semibold">
            {t('chat.notifications.selected', { count: selected.length })}
          </span>
          <Button size="xs" variant="inv" className="bg-bg/15 text-bg" onClick={() => bulk('read')}>
            {t('chat.notifications.markRead')}
          </Button>
          <Button
            size="xs"
            variant="inv"
            className="bg-bg/15 text-bg"
            onClick={() => bulk('unread')}
          >
            {t('chat.notifications.markUnread')}
          </Button>
          {box !== 'dismissed' ? (
            <SnoozeMenu onSnooze={(until) => bulk('snooze', until)}>
              <Button size="xs" variant="inv" className="bg-bg/15 text-bg">
                {t('chat.notifications.snooze.label')}
              </Button>
            </SnoozeMenu>
          ) : null}
          <Button
            size="xs"
            variant="inv"
            className="bg-bg/15 text-bg"
            onClick={() => bulk(box === 'dismissed' ? 'restore' : 'dismiss')}
          >
            {t(box === 'dismissed' ? 'chat.notifications.restore' : 'chat.notifications.dismiss')}
          </Button>
          <Button
            size="xs"
            variant="inv"
            className="ml-auto bg-transparent text-bg"
            onClick={selection.clear}
          >
            {t('chat.notifications.clearSelection')}
          </Button>
        </div>
      ) : null}
      {isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          className="m-auto"
          icon="bell"
          title={t('shell.noNotifications')}
          description={t(`chat.notifications.empty.${box}`)}
        />
      ) : (
        <div className="flex flex-col">
          <label className="flex items-center gap-3 px-3 py-1.5 text-cap text-fg2">
            <SelectAllCheckbox
              state={selection.state}
              onChange={selection.setAll}
              label={t('ui.selectAll')}
            />
            <span aria-hidden="true">{t('ui.selectAll')}</span>
          </label>
          {items.map((n, i) => {
            const prev = items[i - 1];
            const newDay = !prev || !sameDay(prev.createdAt, n.createdAt);
            return (
              <Fragment key={n.id}>
                {newDay ? (
                  <h3 className="m-0 px-3 pt-4 pb-1 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
                    {dayLabel(n.createdAt, locale, now, (k) => t(`chat.time.${k}`))}
                  </h3>
                ) : null}
                <NotificationRow
                  n={n}
                  now={now}
                  selectable
                  selected={selection.has(n.id)}
                  onSelect={() => selection.toggle(n.id)}
                />
              </Fragment>
            );
          })}
          <p className="m-0 px-3 pt-4 text-xs text-fg3">{t('chat.notifications.retention')}</p>
        </div>
      )}
      <NotificationPrefsDialog open={prefs} onOpenChange={setPrefs} />
    </Workspace>
  );
}
