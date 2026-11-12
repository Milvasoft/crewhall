import {
  CALENDAR_RAW_PATHS,
  dateToDay,
  dayToDate,
  type Calendar,
  type CalendarSettings,
} from '@crewhall/shared';
import {
  Calendar as MiniMonth,
  Checkbox,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { calendarKeys } from '@/lib/calendar/queries';
import { ModuleSidebar } from '@/components/shell/ModuleSidebar';
import { CHECK, SwitchRow, useFail } from './bits';
import { config } from '@/config';
import { CalendarDialog } from './CalendarDialog';
import { CalendarSettingsDialog } from './CalendarSettingsDialog';

/** Sidebar: month picker, the calendars with show/hide, linked items, settings. */
export function CalendarSidebar({
  date,
  today,
  calendars,
  settings,
  onDate,
  spaceId,
}: {
  date: string;
  today: string;
  calendars: Calendar[];
  settings: CalendarSettings | undefined;
  onDate: (d: string) => void;
  spaceId?: string;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const [dialog, setDialog] = useState<
    { kind: 'new' } | { kind: 'edit'; calendar: Calendar } | null
  >(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hidden = new Set(settings?.hiddenCalendarIds ?? []);

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.call<'updateCalendarSettings'>>[1]['body']) =>
      api.call('updateCalendarSettings', { body }),
    onSuccess: (s) => {
      qc.setQueryData(calendarKeys.settings(), s);
      void qc.invalidateQueries({ queryKey: ['calendar', 'occurrences'] });
    },
    onError: fail,
  });
  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    save.mutate({ hiddenCalendarIds: [...next] });
  };

  const own = calendars.filter((c) => c.kind !== 'space' && !c.external);
  // Mirrored Google / Microsoft calendars, grouped under their account.
  const connected = calendars.filter((c) => c.external);
  const spaces = calendars.filter((c) => c.kind === 'space');
  const shown = spaceId ? calendars.filter((c) => c.spaceId === spaceId) : null;

  return (
    <ModuleSidebar label={t('calendar.title')} className="gap-px overflow-hidden px-2.5 py-3">
      <div className="flex items-center gap-2.5 px-2 pb-2">
        <span className="flex size-9 items-center justify-center rounded-md bg-bg2">
          <Icon name="calendar" size={18} />
        </span>
        <span className="text-sm font-bold">{t('calendar.title')}</span>
      </div>
      <div className="-mx-1 pb-2" data-testid="calendar-mini-month">
        <MiniMonth
          selected={dateToDay(date)}
          min={null}
          max={null}
          today={dateToDay(today)}
          onSelect={(d) => onDate(dayToDate(d))}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
        {shown ? (
          <Group title={t('calendar.sidebar.space')}>
            {shown.map((c) => (
              <Row key={c.id} c={c} checked onToggle={() => undefined} t={t} />
            ))}
          </Group>
        ) : (
          <>
            <Group
              title={t('calendar.sidebar.calendars')}
              action={
                <IconButton
                  size="xs"
                  tone="plain"
                  aria-label={t('calendar.sidebar.newCalendar')}
                  onClick={() => setDialog({ kind: 'new' })}
                >
                  <Icon name="plus" size={14} />
                </IconButton>
              }
            >
              {own.map((c) => (
                <Row
                  key={c.id}
                  c={c}
                  checked={!hidden.has(c.id)}
                  onToggle={() => toggle(c.id)}
                  onEdit={
                    c.permissions.manage
                      ? () => setDialog({ kind: 'edit', calendar: c })
                      : undefined
                  }
                  t={t}
                />
              ))}
            </Group>
            {connected.length ? (
              <Group title={t('calendar.sidebar.connected')}>
                {connected.map((c) => (
                  <Row
                    key={c.id}
                    c={c}
                    checked={!hidden.has(c.id)}
                    onToggle={() => toggle(c.id)}
                    t={t}
                  />
                ))}
              </Group>
            ) : null}
            {spaces.length ? (
              <Group title={t('calendar.sidebar.spaces')}>
                {spaces.map((c) => (
                  <Row
                    key={c.id}
                    c={c}
                    checked={!hidden.has(c.id)}
                    onToggle={() => toggle(c.id)}
                    t={t}
                  />
                ))}
              </Group>
            ) : null}
          </>
        )}
        <Group title={t('calendar.sidebar.linked')}>
          <div className="flex flex-col gap-2.5 px-2.5 py-1.5">
            <SwitchRow
              label={t('calendar.sidebar.meetings')}
              checked={settings?.showMeetings ?? true}
              onChange={(v) => save.mutate({ showMeetings: v })}
            />
            <SwitchRow
              label={t('calendar.sidebar.cards')}
              checked={settings?.showCards ?? true}
              onChange={(v) => save.mutate({ showCards: v })}
            />
          </div>
        </Group>
      </div>
      <Link
        to="/bookings"
        className="mt-2 flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
      >
        <Icon name="users" size={16} />
        {t('calendar.booking.title')}
      </Link>
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        className="flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
      >
        <Icon name="settings" size={16} />
        {t('calendar.sidebar.settings')}
      </button>
      {dialog ? (
        <CalendarDialog
          calendar={dialog.kind === 'edit' ? dialog.calendar : undefined}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {settingsOpen && settings ? (
        <CalendarSettingsDialog
          settings={settings}
          calendars={calendars}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </ModuleSidebar>
  );
}

function Group({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-3 flex flex-col gap-px">
      <div className="mb-1 flex items-center px-2.5">
        <span className="eyebrow flex-1">{title}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({
  c,
  checked,
  onToggle,
  onEdit,
  t,
}: {
  c: Calendar;
  checked: boolean;
  onToggle: () => void;
  onEdit?: () => void;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const name = c.isDefault ? t('calendar.sidebar.mine') : c.name;
  return (
    <div className="group flex h-[var(--nv-h)] shrink-0 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg">
      <Checkbox
        checked={checked}
        onCheckedChange={onToggle}
        aria-label={t('calendar.sidebar.show', { name })}
        className={CHECK[c.color]}
      />
      <span
        className="min-w-0 flex-1 truncate"
        title={c.external ? `${name} · ${c.external.email}` : undefined}
      >
        {name}
      </span>
      {c.kind === 'team' ? <Icon name="users" size={13} className="text-fg3" /> : null}
      {c.external && !c.external.writable ? (
        <Icon
          name="lock"
          size={12}
          className="text-fg3"
          aria-label={t('calendar.sidebar.readOnly')}
        />
      ) : null}
      <Menu>
        <MenuTrigger asChild>
          <IconButton
            size="xs"
            tone="plain"
            aria-label={t('calendar.sidebar.options', { name })}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
          >
            <Icon name="dots" size={14} />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          {onEdit ? (
            <MenuItem icon="edit" onSelect={onEdit}>
              {t('calendar.sidebar.edit')}
            </MenuItem>
          ) : null}
          <MenuItem
            icon="download"
            onSelect={() => {
              window.location.href = new URL(
                CALENDAR_RAW_PATHS.exportIcs.replace(':calendarId', c.id),
                config.apiUrl,
              ).toString();
            }}
          >
            {t('calendar.sidebar.export')}
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
