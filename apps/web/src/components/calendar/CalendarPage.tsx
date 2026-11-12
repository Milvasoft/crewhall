import { type CalendarEvent, type CalendarOccurrence, type CalendarView } from '@crewhall/shared';
import { Button, Icon, IconButton, Segmented, Tooltip } from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  calendarKeys,
  calendarSettingsQuery,
  calendarsQuery,
  eventQuery,
  occurrencesQuery,
} from '@/lib/calendar/queries';
import {
  browserZone,
  datesBetween,
  formatDateOnly,
  instantAt,
  minuteOf,
  rangeInstants,
  shiftDate,
  todayIn,
  viewDates,
} from '@/lib/calendar/time';
import { useNow } from '@/lib/useNow';
import { useShellLayout } from '@/lib/shell';
import { AgendaList } from './AgendaList';
import { CalendarSidebar } from './CalendarSidebar';
import { EventEditor, type EditorInitial } from './EventEditor';
import { EventPanel } from './EventPanel';
import { MonthGrid } from './MonthGrid';
import { useEnterMotion, useEnterWindow } from './motion';
import {
  OccurrenceMenuProvider,
  useDeleteOccurrence,
  type OccurrenceMenuActions,
} from './OccurrenceMenu';
import { PeriodStage, PeriodTitle } from './PeriodStage';
import { TimeGrid } from './TimeGrid';
import { useCalendarMove } from './useCalendarMove';

/** Calendar (roadmap 14): day, week, month and agenda views with the sidebar of calendars. */
export function CalendarPage({
  view: viewParam,
  date: dateParam,
  eventId,
  spaceId,
}: {
  view?: CalendarView;
  date?: string;
  /** ?event=… (from a notification): opens that event. */
  eventId?: string;
  spaceId?: string;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const phone = useShellLayout() === 'phone';
  const settingsQ = useQuery(calendarSettingsQuery());
  const calendarsQ = useQuery(calendarsQuery());
  const settings = settingsQ.data;
  const tz = settings?.timeZone ?? browserZone();
  const now = useNow(60_000);
  const today = todayIn(tz, now);
  const view: CalendarView = viewParam ?? (phone ? 'agenda' : (settings?.defaultView ?? 'week'));
  const date = dateParam ?? today;
  const weekStart = settings?.weekStart ?? 1;

  // The browser's zone becomes the calendar zone until the person picks one.
  const zoneSent = useRef(false);
  useEffect(() => {
    if (!settings || settings.timeZoneExplicit || zoneSent.current) return;
    const zone = browserZone();
    if (zone === settings.timeZone) return;
    zoneSent.current = true;
    void api
      .call('updateCalendarSettings', { body: { timeZone: zone, timeZoneExplicit: false } })
      .then((s) => qc.setQueryData(calendarKeys.settings(), s))
      .catch(() => undefined);
  }, [settings, qc]);

  const { first, end } = viewDates(view, date, weekStart);
  const dates = useMemo(() => datesBetween(first, end), [first, end]);
  const range = rangeInstants(first, end, tz);
  const occ = useQuery({
    ...occurrencesQuery(range.from, range.to, spaceId),
    enabled: Boolean(settings),
  });
  const items = occ.data?.items ?? [];

  const [selected, setSelected] = useState<CalendarOccurrence | null>(null);
  const [editor, setEditor] = useState<{ initial?: EditorInitial; event?: CalendarEvent } | null>(
    null,
  );

  // A notification link opens its event (until the panel is closed).
  const linked = useQuery({ ...eventQuery(eventId ?? ''), enabled: Boolean(eventId) });
  const [linkClosed, setLinkClosed] = useState(false);
  const linkedOccurrence = useMemo(
    () => (linked.data && !linkClosed ? occurrenceOf(linked.data) : null),
    [linked.data, linkClosed],
  );
  const panelItem = selected ?? linkedOccurrence;

  const go = (patch: { view?: CalendarView; date?: string }) =>
    void navigate({
      to: '/calendar',
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        event: undefined,
        ...(patch.view ? { view: patch.view } : {}),
        ...(patch.date ? { date: patch.date } : {}),
      }),
    });

  // Motion: how the period enters, the occurrences rising in once its data is here, and the
  // neighbouring periods fetched ahead so a swipe lands on a full view.
  const enter = useEnterMotion(view, first);
  const entering = useEnterWindow(
    `${view}:${first}:${spaceId ?? ''}`,
    Boolean(occ.data) && !occ.isPlaceholderData,
  );
  const loaded = occ.isSuccess && !occ.isPlaceholderData;
  useEffect(() => {
    if (!loaded || view === 'agenda') return;
    for (const dir of [-1, 1] as const) {
      const next = viewDates(view, shiftDate(view, date, dir), weekStart);
      const r = rangeInstants(next.first, next.end, tz);
      void qc.prefetchQuery(occurrencesQuery(r.from, r.to, spaceId));
    }
  }, [loaded, view, date, weekStart, tz, spaceId, qc]);
  const step = (dir: -1 | 1) => go({ date: shiftDate(view, date, dir) });
  const quietEnter = useRef(false);
  const edgeStep = (dir: -1 | 1) => {
    quietEnter.current = true;
    step(dir);
  };

  const mover = useCalendarMove({
    tz,
    occurrencesKey: occurrencesQuery(range.from, range.to, spaceId).queryKey,
  });
  const shown = mover.withPending(items);
  const enterOrder = useMemo(
    () =>
      entering
        ? new Map(
            [...shown]
              .sort((a, b) => Number(b.allDay) - Number(a.allDay) || (a.start < b.start ? -1 : 1))
              .map((o, i) => [o.key, i]),
          )
        : null,
    [entering, shown],
  );

  const title =
    view === 'month'
      ? formatDateOnly(date, locale, { month: 'long', year: 'numeric' })
      : view === 'day'
        ? formatDateOnly(date, locale, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })
        : `${formatDateOnly(first, locale, { day: 'numeric', month: 'short' })} – ${formatDateOnly(
            dates[dates.length - 1]!,
            locale,
            { day: 'numeric', month: 'short', year: 'numeric' },
          )}`;

  // Right-click menus of the occurrences: the same open, edit and delete as the panel.
  const deleteOccurrence = useDeleteOccurrence((id) =>
    setSelected((s) => (s && (s.seriesId ?? s.sourceId) === id ? null : s)),
  );
  const menuActions: OccurrenceMenuActions = {
    open: setSelected,
    edit: (e) => setEditor({ event: e }),
    remove: deleteOccurrence.start,
  };

  const calendars = calendarsQ.data?.items ?? [];
  const newEvent = (initial?: EditorInitial) => {
    const start = initial ?? defaultSlot(date, tz, now);
    setEditor({
      initial: spaceId
        ? { ...start, calendarId: calendars.find((c) => c.spaceId === spaceId)?.id }
        : start,
    });
  };

  return (
    <Workspace
      sidebar={
        <CalendarSidebar
          date={date}
          today={today}
          calendars={calendars}
          settings={settings}
          onDate={(d) => go({ date: d })}
          spaceId={spaceId}
        />
      }
      crumbs={[{ label: t('calendar.title') }]}
      bodyClassName="p-0 md:p-0 gap-0 overflow-hidden"
      tools={
        <Button size="sm" variant="pri" onClick={() => newEvent()}>
          <Icon name="plus" size={16} />
          {t('calendar.actions.new')}
        </Button>
      }
      panel={
        panelItem ? (
          <EventPanel
            key={panelItem.key}
            occurrence={panelItem}
            tz={tz}
            onClose={() => {
              setSelected(null);
              setLinkClosed(true);
            }}
            onEdit={(e) => setEditor({ event: e })}
          />
        ) : null
      }
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 md:px-6">
        <Button size="sm" variant="out" onClick={() => go({ date: today })}>
          {t('calendar.actions.today')}
        </Button>
        <Tooltip content={t('calendar.actions.previous')}>
          <IconButton
            size="sm"
            tone="plain"
            aria-label={t('calendar.actions.previous')}
            onClick={() => step(-1)}
          >
            <Icon name="chevL" size={18} />
          </IconButton>
        </Tooltip>
        <Tooltip content={t('calendar.actions.next')}>
          <IconButton
            size="sm"
            tone="plain"
            aria-label={t('calendar.actions.next')}
            onClick={() => step(1)}
          >
            <Icon name="chevR" size={18} />
          </IconButton>
        </Tooltip>
        <h1 className="min-w-0 truncate text-lg font-bold" data-testid="calendar-title">
          <PeriodTitle enter={enter}>{title}</PeriodTitle>
        </h1>
        <Segmented
          size="sm"
          className="ml-auto"
          aria-label={t('calendar.view.label')}
          value={view}
          onValueChange={(v) => go({ view: v })}
          options={(['day', 'week', 'month', 'agenda'] as const).map((v) => ({
            value: v,
            label: t(`calendar.view.${v}`),
          }))}
        />
      </div>
      <OccurrenceMenuProvider value={menuActions}>
        <PeriodStage enter={enter} swipe={view !== 'agenda'} onStep={step} quietRef={quietEnter}>
          {view === 'month' ? (
            <MonthGrid
              dates={dates}
              month={date.slice(0, 7)}
              tz={tz}
              items={shown}
              today={today}
              onOpen={setSelected}
              onCreate={newEvent}
              onMove={mover.onMove}
              onKeyMove={mover.onKeyMove}
              onEdge={edgeStep}
              enterOrder={enterOrder}
              onDay={(d) => go({ view: 'day', date: d })}
            />
          ) : view === 'agenda' ? (
            <AgendaList dates={dates} tz={tz} items={items} today={today} onOpen={setSelected} />
          ) : (
            <TimeGrid
              dates={dates}
              tz={tz}
              items={shown}
              today={today}
              now={now}
              workdayStart={settings?.workdayStart ?? 9}
              workdayEnd={settings?.workdayEnd ?? 18}
              onOpen={setSelected}
              onCreate={newEvent}
              onMove={mover.onMove}
              onKeyMove={mover.onKeyMove}
              onEdge={edgeStep}
              enterOrder={enterOrder}
            />
          )}
        </PeriodStage>
      </OccurrenceMenuProvider>
      {editor && settings ? (
        <EventEditor
          tz={tz}
          calendars={calendars}
          defaultReminders={settings.defaultReminders}
          weekStart={weekStart}
          initial={editor.initial}
          event={editor.event}
          onClose={() => setEditor(null)}
          onSaved={() => setSelected(null)}
        />
      ) : null}
      {deleteOccurrence.dialog}
      {mover.dialog}
      {mover.liveRegion}
    </Workspace>
  );
}

/** An event opened from a link, shaped like the occurrence the views would show. */
function occurrenceOf(e: CalendarEvent): CalendarOccurrence {
  return {
    key: `event:${e.id}`,
    source: 'event',
    sourceId: e.id,
    seriesId: e.seriesId,
    recurrenceId: e.recurrenceId,
    calendarId: e.calendar.id,
    color: e.calendar.color,
    title: e.title,
    hidden: false,
    location: e.location,
    allDay: e.allDay,
    start: e.start,
    end: e.end,
    status: e.status,
    busy: e.busy,
    recurring: Boolean(e.rrule || e.seriesId),
    myResponse: e.myResponse,
    attendeeCount: e.attendees.length,
    editable: e.permissions.edit,
    url: null,
    flag: null,
  };
}

/** The next full hour of the shown day (today) or 09:00 (another day). */
function defaultSlot(date: string, tz: string, now: number): EditorInitial {
  const startMin =
    date === todayIn(tz, now)
      ? Math.min(23 * 60, (Math.floor(minuteOf(new Date(now).toISOString(), tz) / 60) + 1) * 60)
      : 9 * 60;
  const start = instantAt(date, startMin, tz);
  return {
    allDay: false,
    start: start.toISOString(),
    end: new Date(start.getTime() + 3_600_000).toISOString(),
  };
}
