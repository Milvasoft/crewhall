import {
  type AttendeeResponse,
  type CalendarEvent,
  type CalendarOccurrence,
  type Meeting,
  type SeriesScope,
} from '@crewhall/shared';
import {
  Avatar,
  Button,
  cn,
  Icon,
  IconButton,
  Segmented,
  Skeleton,
  toast,
  Tooltip,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useNow } from '@/lib/useNow';
import { useBookingActions } from './BookingsPage';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { calendarKeys, eventQuery, eventVersionsQuery } from '@/lib/calendar/queries';
import { addDaysToDate } from '@crewhall/shared';
import { dateOf, formatDateOnly, formatTimeIn } from '@/lib/calendar/time';
import { DOT, SOURCE_ICON, useFail } from './bits';
import { reminderLabel } from './EventEditor';
import { ScopeDialog } from './ScopeDialog';
import { MeetingLink } from '@/components/meet/openMeeting';
import { useMeetingActions } from '@/components/meet/MeetingActions';
import { meetingQuery } from '@/lib/meet/queries';
import { ResizablePane } from '@/components/shell/ResizablePane';

/** When an occurrence happens, in the calendar zone ("Pzt 2 Kas · 10:00 – 11:00"). */
export function useWhen(tz: string) {
  const { t, locale } = useI18n();
  return (o: Pick<CalendarOccurrence, 'allDay' | 'start' | 'end'>) => {
    const day = (d: string) =>
      formatDateOnly(d, locale, { weekday: 'short', day: 'numeric', month: 'short' });
    if (o.allDay) {
      const last = addDaysToDate(o.end, -1);
      return last > o.start
        ? `${day(o.start)} – ${day(last)}`
        : `${day(o.start)} · ${t('calendar.allDay')}`;
    }
    const sd = dateOf(o.start, tz);
    const ed = dateOf(o.end, tz);
    if (o.start === o.end) return `${day(sd)} · ${formatTimeIn(o.start, locale, tz)}`;
    return sd === ed
      ? `${day(sd)} · ${formatTimeIn(o.start, locale, tz)} – ${formatTimeIn(o.end, locale, tz)}`
      : `${day(sd)} ${formatTimeIn(o.start, locale, tz)} – ${day(ed)} ${formatTimeIn(o.end, locale, tz)}`;
  };
}

const RESPONSE_ICON: Record<AttendeeResponse, string> = {
  accepted: 'text-success',
  declined: 'text-danger',
  tentative: 'text-warning',
  needs_action: 'text-fg3',
};

/** Right panel for a clicked occurrence: details, answer, edit and delete. */
export function EventPanel({
  occurrence,
  tz,
  onClose,
  onEdit,
}: {
  occurrence: CalendarOccurrence;
  tz: string;
  onClose: () => void;
  onEdit: (e: CalendarEvent) => void;
}) {
  const { t } = useI18n();
  const when = useWhen(tz);
  const qc = useQueryClient();
  const fail = useFail();
  const [askDelete, setAskDelete] = useState(false);
  const o = occurrence;
  const isEvent = o.source === 'event' && !o.hidden;
  const eventId = o.seriesId ?? o.sourceId;
  const ev = useQuery({ ...eventQuery(eventId, o.recurrenceId), enabled: isEvent });

  const respond = useMutation({
    mutationFn: (response: Exclude<AttendeeResponse, 'needs_action'>) =>
      api.call('respondCalendarEvent', { params: { eventId }, body: { response } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: calendarKeys.all }),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (scope: SeriesScope) =>
      api.call('deleteCalendarEvent', {
        params: { eventId },
        query: { scope, recurrenceId: o.recurrenceId ?? undefined },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: calendarKeys.all });
      onClose();
    },
    onError: fail,
  });

  const e = ev.data;
  const title = o.hidden ? t('calendar.busy') : o.title;
  return (
    <ResizablePane id="calendar-event" side="right" defaultWidth={340}>
      <aside
        aria-label={title}
        className="flex w-full min-w-0 flex-col gap-4 overflow-y-auto border-l border-line bg-bg px-5 py-4"
        data-testid="calendar-event-panel"
      >
        <div className="flex items-start gap-2">
          <span className={cn('mt-1.5 size-3 shrink-0 rounded-sm', DOT[o.color])} />
          <h2 className="min-w-0 flex-1 text-lg leading-snug font-bold break-words">{title}</h2>
          {e?.permissions.edit ? (
            <>
              <Tooltip content={t('calendar.actions.edit')}>
                <IconButton
                  size="sm"
                  tone="plain"
                  aria-label={t('calendar.actions.edit')}
                  onClick={() => onEdit(e)}
                >
                  <Icon name="edit" size={16} />
                </IconButton>
              </Tooltip>
              <Tooltip content={t('common.actions.delete')}>
                <IconButton
                  size="sm"
                  tone="plain"
                  aria-label={t('common.actions.delete')}
                  onClick={() => (o.recurring ? setAskDelete(true) : remove.mutate('all'))}
                >
                  <Icon name="trash" size={16} />
                </IconButton>
              </Tooltip>
            </>
          ) : null}
          <IconButton
            size="sm"
            tone="plain"
            aria-label={t('common.actions.close')}
            onClick={onClose}
          >
            <Icon name="x" size={16} />
          </IconButton>
        </div>
        <div className="flex flex-col gap-1 text-sm text-fg2">
          <span className="flex items-center gap-2">
            <Icon name="clock" size={15} />
            {when(o)}
          </span>
          {o.recurring ? (
            <span className="flex items-center gap-2">
              <Icon name="refresh" size={15} />
              {t('calendar.panel.recurring')}
            </span>
          ) : null}
          {o.location ? (
            <span className="flex items-center gap-2">
              <Icon name={o.source === 'card' ? 'board' : 'pin'} size={15} />
              {o.location}
            </span>
          ) : null}
          {e?.room ? <RoomLine room={e.room} tz={tz} canCheckIn={e.permissions.edit} /> : null}
          {e ? (
            <span className="flex items-center gap-2">
              <Icon name="calendar" size={15} />
              {e.calendar.kind === 'personal' && e.permissions.edit && !e.external
                ? t('calendar.sidebar.mine')
                : e.calendar.name}
            </span>
          ) : null}
        </div>

        {e?.meeting ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="pri">
              <MeetingLink slug={e.meeting.slug}>
                <Icon name="video" size={15} />
                {t('calendar.panel.join')}
              </MeetingLink>
            </Button>
            <Button
              size="sm"
              variant="out"
              onClick={() => {
                void navigator.clipboard?.writeText(e.meeting!.url);
                toast(t('calendar.settings.copied'));
              }}
            >
              {t('calendar.panel.copyLink')}
            </Button>
          </div>
        ) : null}

        {e?.external ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {e.external.joinUrl ? (
                <Button asChild size="sm" variant="pri">
                  <a href={e.external.joinUrl} target="_blank" rel="noopener noreferrer">
                    <Icon name="video" size={15} />
                    {t(joinLabel(e.external.joinUrl))}
                  </a>
                </Button>
              ) : null}
              {e.external.webUrl ? (
                <Button asChild size="sm" variant="out">
                  <a href={e.external.webUrl} target="_blank" rel="noopener noreferrer">
                    <Icon name="ext" size={14} />
                    {e.external.provider === 'google'
                      ? t('calendar.panel.openGoogle')
                      : t('calendar.panel.openMicrosoft')}
                  </a>
                </Button>
              ) : null}
            </div>
            {e.external.readOnly || e.external.occurrenceOnly ? (
              <span className="text-xs text-fg3">
                {e.external.readOnly
                  ? t('calendar.panel.readOnly')
                  : t('calendar.panel.occurrenceOnly')}
              </span>
            ) : null}
          </div>
        ) : null}

        {o.source !== 'event' ? (
          <div className="flex flex-col gap-2 rounded-xl bg-bg2 p-3 text-sm">
            <span className="flex items-center gap-2 font-semibold">
              <Icon name={SOURCE_ICON[o.source]} size={15} />
              {o.source === 'meeting' ? t('calendar.panel.meeting') : t('calendar.panel.card')}
            </span>
            <span className="text-xs text-fg3">
              {o.source === 'meeting'
                ? t('calendar.panel.meetingHint')
                : t('calendar.panel.cardHint')}
            </span>
            {o.url ? (
              <Button
                asChild
                size="sm"
                variant={o.source === 'meeting' ? 'pri' : 'out'}
                className="self-start"
              >
                <Link to={o.url}>
                  {o.source === 'meeting' ? t('calendar.panel.join') : t('calendar.panel.openCard')}
                </Link>
              </Button>
            ) : null}
            {o.source === 'meeting' ? (
              <MeetingPanelActions meetingId={o.sourceId} onCancelled={onClose} />
            ) : null}
          </div>
        ) : null}

        {isEvent && ev.isLoading ? <Skeleton className="h-24" /> : null}

        {e?.permissions.respond ? (
          <div className="flex flex-col gap-2">
            <span className="eyebrow">{t('calendar.panel.going')}</span>
            <Segmented
              size="sm"
              aria-label={t('calendar.panel.going')}
              value={
                e.myResponse && e.myResponse !== 'needs_action' ? e.myResponse : ('' as 'accepted')
              }
              onValueChange={(v) => v && respond.mutate(v)}
              options={[
                { value: 'accepted', label: t('calendar.response.accepted') },
                { value: 'tentative', label: t('calendar.response.tentative') },
                { value: 'declined', label: t('calendar.response.declined') },
              ]}
            />
          </div>
        ) : null}

        {e?.description ? <p className="text-sm whitespace-pre-wrap">{e.description}</p> : null}

        {e && (e.organizer || e.attendees.length) ? (
          <div className="flex flex-col gap-2">
            <span className="eyebrow">
              {t('calendar.panel.people', { count: e.attendees.length + (e.organizer ? 1 : 0) })}
            </span>
            {e.organizer ? (
              <span className="flex items-center gap-2 text-sm">
                <Avatar name={e.organizer.name} src={e.organizer.imageUrl} size="sm" />
                <span className="min-w-0 flex-1 truncate font-semibold">{e.organizer.name}</span>
                <span className="text-xs text-fg3">{t('calendar.panel.organizer')}</span>
              </span>
            ) : null}
            {e.attendees.map((a) => (
              <span key={a.id} className="flex items-center gap-2 text-sm">
                <Avatar name={a.name ?? a.email} src={a.user?.imageUrl ?? null} size="sm" />
                <span className="min-w-0 flex-1 truncate">
                  {a.name ?? a.email}
                  {a.optional ? (
                    <span className="text-xs text-fg3"> · {t('calendar.panel.optional')}</span>
                  ) : null}
                </span>
                <span className={cn('text-xs font-semibold', RESPONSE_ICON[a.response])}>
                  {t(`calendar.response.${a.response}`)}
                </span>
              </span>
            ))}
          </div>
        ) : null}

        {e?.reminders.length ? (
          <div className="flex flex-col gap-1">
            <span className="eyebrow">{t('calendar.editor.reminders')}</span>
            <span className="text-sm text-fg2">
              {e.reminders.map((m) => reminderLabel(m, e.allDay, t)).join(', ')}
            </span>
          </div>
        ) : null}

        {e?.external ? (
          <EventVersions eventId={e.id} tz={tz} provider={e.external.provider} />
        ) : null}

        {askDelete ? (
          <ScopeDialog
            kind="delete"
            withFollowing={!e?.external}
            onCancel={() => setAskDelete(false)}
            onPick={(s) => {
              setAskDelete(false);
              remove.mutate(s);
            }}
          />
        ) : null}
      </aside>
    </ResizablePane>
  );
}

/** A scheduled meeting's moderators edit or cancel it here, with meet's own dialogs. */
function MeetingPanelActions({
  meetingId,
  onCancelled,
}: {
  meetingId: string;
  onCancelled: () => void;
}) {
  const m = useQuery(meetingQuery(meetingId));
  return m.data ? <MeetingButtons m={m.data} onCancelled={onCancelled} /> : null;
}

function MeetingButtons({ m, onCancelled }: { m: Meeting; onCancelled: () => void }) {
  const { entries, dialogs } = useMeetingActions(m);
  // Cancelled (here or elsewhere): the occurrence is gone from the views, so is the panel.
  useEffect(() => {
    if (m.cancelledAt) onCancelled();
  }, [m.cancelledAt, onCancelled]);
  const shown = entries.flatMap((e) =>
    e.kind === 'item' && (e.key === 'edit' || e.key === 'cancel') ? [e] : [],
  );
  if (!shown.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {shown.map((e) => {
        const button = (
          <Button
            key={e.key}
            size="sm"
            variant={e.danger ? 'gh' : 'out'}
            disabled={Boolean(e.disabledReason)}
            onClick={e.onSelect}
          >
            <Icon name={e.icon} size={14} />
            {e.label}
          </Button>
        );
        return e.disabledReason ? (
          <Tooltip key={e.key} content={e.disabledReason}>
            <span>{button}</span>
          </Tooltip>
        ) : (
          button
        );
      })}
      {dialogs}
    </div>
  );
}

/** The provider's name on the join button (Google Meet, Teams), by the link's host. */
function joinLabel(url: string) {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  if (host === 'meet.google.com') return 'calendar.panel.joinGoogle' as const;
  if (host.endsWith('teams.microsoft.com') || host.endsWith('teams.live.com')) {
    return 'calendar.panel.joinTeams' as const;
  }
  return 'calendar.panel.joinOther' as const;
}

/** The meeting's room: its booking state and, in the check-in window, "Giriş yap". */
function RoomLine({
  room,
  tz,
  canCheckIn,
}: {
  room: NonNullable<CalendarEvent['room']>;
  tz: string;
  canCheckIn: boolean;
}) {
  const { t, locale } = useI18n();
  const now = useNow(30_000);
  const { checkIn } = useBookingActions();
  const open =
    canCheckIn &&
    room.status === 'confirmed' &&
    room.checkIn !== null &&
    now >= Date.parse(room.checkIn.opensAt) &&
    now <= Date.parse(room.checkIn.closesAt);
  return (
    <span className="flex flex-wrap items-center gap-2" data-testid="event-room">
      <Icon name="users" size={15} />
      <span className={cn(room.status === 'released' && 'line-through')}>{room.name}</span>
      <span className="text-xs text-fg3">{t(`calendar.booking.status.${room.status}`)}</span>
      {room.status === 'confirmed' && room.checkIn ? (
        <span className="text-xs text-fg3">
          {t('calendar.booking.checkInBy', {
            time: formatTimeIn(room.checkIn.closesAt, locale, tz),
          })}
        </span>
      ) : null}
      {open ? (
        <Button
          size="sm"
          variant="pri"
          loading={checkIn.isPending}
          onClick={() => checkIn.mutate(room.bookingId)}
        >
          {t('calendar.booking.checkIn')}
        </Button>
      ) : null}
    </span>
  );
}

/**
 * Mirrored events: versions lost to "the last writer wins" (changed at the same time here and at
 * the provider). Nothing is shown until there is one.
 */
function EventVersions({
  eventId,
  tz,
  provider,
}: {
  eventId: string;
  tz: string;
  provider: NonNullable<CalendarEvent['external']>['provider'];
}) {
  const { t, locale } = useI18n();
  const when = useWhen(tz);
  const q = useQuery(eventVersionsQuery(eventId));
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  const at = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <details className="flex flex-col gap-2" data-testid="event-versions">
      <summary className="eyebrow cursor-pointer">
        {t('calendar.panel.versions', { count: items.length })}
      </summary>
      <p className="mt-1 text-xs text-fg3">{t('calendar.panel.versionsHint')}</p>
      <ul className="m-0 mt-1 flex list-none flex-col gap-2 p-0">
        {items.map((v) => (
          <li key={v.id} className="flex flex-col gap-0.5 rounded-lg bg-bg2 p-3 text-sm">
            <span className="text-xs text-fg3">
              {t(
                v.overwritten === 'crewhall'
                  ? 'calendar.panel.versionCrewhall'
                  : `calendar.accounts.provider.${provider}`,
              )}{' '}
              · {at.format(new Date(v.replacedAt))}
            </span>
            <span className="font-semibold break-words">{v.title}</span>
            <span className="text-xs text-fg2">{when(v)}</span>
            {v.location ? <span className="text-xs text-fg2">{v.location}</span> : null}
            {v.description ? (
              <span className="text-xs whitespace-pre-wrap text-fg2">{v.description}</span>
            ) : null}
            {v.attendees.length ? (
              <span className="text-xs text-fg2">
                {v.attendees.map((a) => a.name ?? a.email).join(', ')}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
