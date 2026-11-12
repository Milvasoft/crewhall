import {
  addDaysToDate,
  type Booking,
  type BookingKind,
  type BookingResource,
} from '@crewhall/shared';
import {
  Badge,
  Button,
  cn,
  DatePicker,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Segmented,
  Skeleton,
  TimePicker,
  toast,
  Tooltip,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { calendarKeys, calendarSettingsQuery } from '@/lib/calendar/queries';
import {
  bookingDefaults,
  bookingsQuery,
  firstBookableDate,
  resourcesQuery,
} from '@/lib/calendar/bookings';
import {
  browserZone,
  dateOf,
  formatDateOnly,
  formatTimeIn,
  instantAt,
  minuteOf,
  parseHhmm,
} from '@/lib/calendar/time';
import { useNow } from '@/lib/useNow';
import { useFail } from './bits';

/** The day strip shows these hours (bookings outside are clipped to the edges). */
const DAY_FROM = 7 * 60;
const DAY_TO = 21 * 60;

/**
 * Room and desk booking (sonraki-isler): the resources of a day with their bookings on a strip,
 * booking in two clicks, and the person's own bookings with check-in. No floor plan.
 */
export function BookingsPage() {
  const { t, locale } = useI18n();
  const settings = useQuery(calendarSettingsQuery()).data;
  const tz = settings?.timeZone ?? browserZone();
  const now = useNow(30_000);
  const [kind, setKind] = useState<BookingKind>('room');
  const [date, setDate] = useState(() => firstBookableDate(tz, now, settings?.workdayEnd ?? 18));
  const [booking, setBooking] = useState<BookingResource | null>(null);
  const resources = useQuery(resourcesQuery(kind));
  const from = instantAt(date, 0, tz).toISOString();
  const to = instantAt(addDaysToDate(date, 1), 0, tz).toISOString();
  const day = useQuery(bookingsQuery({ from, to, kind }));
  const byResource = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const b of day.data?.items ?? []) {
      map.set(b.resource.id, [...(map.get(b.resource.id) ?? []), b]);
    }
    return map;
  }, [day.data]);

  return (
    <Workspace crumbs={[{ label: t('calendar.title') }, { label: t('calendar.booking.title') }]}>
      <div className="flex w-full max-w-[960px] flex-col gap-5" data-testid="bookings-page">
        <div className="flex flex-col gap-1">
          <h1 className="text-h1 font-bold">{t('calendar.booking.title')}</h1>
          <p className="text-sm text-fg2">{t('calendar.booking.hint')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            size="sm"
            aria-label={t('calendar.booking.kind.label')}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: 'room', label: t('calendar.booking.kind.room') },
              { value: 'desk', label: t('calendar.booking.kind.desk') },
            ]}
          />
          <div className="ml-auto flex items-center gap-1">
            <IconButton
              size="sm"
              tone="plain"
              aria-label={t('calendar.actions.previous')}
              onClick={() => setDate(addDaysToDate(date, -1))}
            >
              <Icon name="chevL" size={18} />
            </IconButton>
            <DatePicker
              value={date}
              clearable={false}
              aria-label={t('calendar.booking.date')}
              onChange={(v) => v && setDate(v)}
            />
            <IconButton
              size="sm"
              tone="plain"
              aria-label={t('calendar.actions.next')}
              onClick={() => setDate(addDaysToDate(date, 1))}
            >
              <Icon name="chevR" size={18} />
            </IconButton>
          </div>
        </div>

        {resources.isLoading ? (
          <Skeleton className="h-40" />
        ) : !resources.data?.items.length ? (
          <EmptyState icon="users" title={t('calendar.booking.empty')} />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {resources.data.items.map((r) => (
              <ResourceRow
                key={r.id}
                r={r}
                bookings={byResource.get(r.id) ?? []}
                tz={tz}
                locale={locale}
                onBook={() => setBooking(r)}
              />
            ))}
          </ul>
        )}

        <MyBookings tz={tz} now={now} />
      </div>
      {booking ? (
        <BookDialog
          r={booking}
          date={date}
          tz={tz}
          now={now}
          workday={{ start: settings?.workdayStart ?? 9, end: settings?.workdayEnd ?? 18 }}
          onClose={() => setBooking(null)}
        />
      ) : null}
    </Workspace>
  );
}

function ResourceRow({
  r,
  bookings,
  tz,
  locale,
  onBook,
}: {
  r: BookingResource;
  bookings: Booking[];
  tz: string;
  locale: string;
  onBook: () => void;
}) {
  const { t } = useI18n();
  const span = DAY_TO - DAY_FROM;
  const pos = (iso: string) =>
    Math.min(1, Math.max(0, (minuteOf(iso, tz) - DAY_FROM) / span)) * 100;
  return (
    <li
      className="flex flex-col gap-2 rounded-xl border border-line p-3 sm:flex-row sm:items-center"
      data-testid="booking-resource"
      aria-label={r.name}
    >
      <div className="flex min-w-0 flex-col gap-0.5 sm:w-56">
        <span className="truncate text-sm font-semibold">{r.name}</span>
        <span className="truncate text-xs text-fg2">
          {[r.location, r.capacity ? t('calendar.booking.capacity', { count: r.capacity }) : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {r.equipment.length ? (
          <span className="flex flex-wrap gap-1 pt-0.5">
            {r.equipment.map((e) => (
              <Badge key={e}>{e}</Badge>
            ))}
          </span>
        ) : null}
      </div>
      <div
        className="relative h-8 min-w-0 flex-1 overflow-hidden rounded-lg bg-bg2"
        aria-label={bookings.length ? t('calendar.booking.busy') : t('calendar.booking.free')}
      >
        {bookings.map((b) => (
          <Tooltip
            key={b.id}
            content={t('calendar.booking.bookedBy', {
              name: b.title ?? b.user.name,
              time: `${formatTimeIn(b.start, locale, tz)}–${formatTimeIn(b.end, locale, tz)}`,
            })}
          >
            <span
              className={cn(
                'absolute inset-y-1 truncate rounded-md px-1.5 text-[11px] leading-6 font-semibold',
                b.status === 'released'
                  ? 'bg-bg3 text-fg3 line-through'
                  : 'bg-accent text-accent-fg',
              )}
              style={{
                left: `${pos(b.start)}%`,
                width: `${Math.max(2, pos(b.end) - pos(b.start))}%`,
              }}
            >
              {b.title ?? b.user.name}
            </span>
          </Tooltip>
        ))}
      </div>
      <Button
        size="sm"
        variant="out"
        onClick={onBook}
        aria-label={t('calendar.booking.bookTitle', { name: r.name })}
      >
        {t('calendar.booking.book')}
      </Button>
    </li>
  );
}

function BookDialog({
  r,
  date,
  tz,
  now,
  workday,
  onClose,
}: {
  r: BookingResource;
  date: string;
  tz: string;
  now: number;
  workday: { start: number; end: number };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  // Desks: the working hours; rooms: an hour; today from the next quarter hour.
  const [defaults] = useState(() => bookingDefaults(r.kind, date, tz, now, workday));
  const [start, setStart] = useState(defaults.start);
  const [end, setEnd] = useState(defaults.end);
  const book = useMutation({
    mutationFn: () =>
      api.call('createBooking', {
        body: {
          resourceId: r.id,
          start: instantAt(date, parseHhmm(start), tz).toISOString(),
          end: instantAt(date, parseHhmm(end), tz).toISOString(),
        },
      }),
    onSuccess: async () => {
      toast(t('calendar.booking.booked', { name: r.name }));
      await qc.invalidateQueries({ queryKey: calendarKeys.all });
      onClose();
    },
    onError: fail,
  });
  const valid = parseHhmm(end) > parseHhmm(start);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={420}>
        <DialogHeader title={t('calendar.booking.bookTitle', { name: r.name })} />
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('calendar.booking.start')}>
            <TimePicker value={start} minuteStep={15} onChange={(v) => v && setStart(v)} />
          </Field>
          <Field label={t('calendar.booking.end')}>
            <TimePicker value={end} minuteStep={15} onChange={(v) => v && setEnd(v)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="pri"
            disabled={!valid}
            loading={book.isPending}
            onClick={() => book.mutate()}
          >
            {t('calendar.booking.book')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The person's bookings of the next month: check in, cancel. */
function MyBookings({ tz, now }: { tz: string; now: number }) {
  const { t, locale } = useI18n();
  const [range] = useState(() => ({
    from: new Date(now - 3 * 3_600_000).toISOString(),
    to: new Date(now + 31 * 86_400_000).toISOString(),
  }));
  const mine = useQuery(bookingsQuery({ ...range, mine: 'true' }));
  const items = (mine.data?.items ?? []).filter((b) => Date.parse(b.end) > now);
  return (
    <section className="flex flex-col gap-2" data-testid="my-bookings">
      <h2 className="eyebrow">{t('calendar.booking.mine')}</h2>
      {!items.length ? (
        <p className="text-sm text-fg3">{t('calendar.booking.mineEmpty')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-xl border border-line p-0">
          {items.map((b) => (
            <MyBooking key={b.id} b={b} tz={tz} locale={locale} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function useBookingActions() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const refresh = () => qc.invalidateQueries({ queryKey: calendarKeys.all });
  const checkIn = useMutation({
    mutationFn: (id: string) => api.call('checkInBooking', { params: { bookingId: id } }),
    onSuccess: async () => {
      toast(t('calendar.booking.checkedIn'));
      await refresh();
    },
    onError: fail,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.call('cancelBooking', { params: { bookingId: id } }),
    onSuccess: async () => {
      toast(t('calendar.booking.cancelled'));
      await refresh();
    },
    onError: fail,
  });
  return { checkIn, cancel };
}

function MyBooking({ b, tz, locale }: { b: Booking; tz: string; locale: string }) {
  const { t } = useI18n();
  const { checkIn, cancel } = useBookingActions();
  const day = formatDateOnly(dateOf(b.start, tz), locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return (
    <li
      className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm"
      aria-label={b.resource.name}
    >
      <Icon name={b.resource.kind === 'room' ? 'users' : 'laptop'} size={16} className="text-fg2" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-semibold">{b.resource.name}</span>
        <span className="truncate text-xs text-fg2">
          {day} · {formatTimeIn(b.start, locale, tz)}–{formatTimeIn(b.end, locale, tz)}
          {b.status === 'confirmed' && b.checkIn
            ? ` · ${t('calendar.booking.checkInBy', { time: formatTimeIn(b.checkIn.closesAt, locale, tz) })}`
            : ''}
        </span>
      </span>
      <Badge>{t(`calendar.booking.status.${b.status}`)}</Badge>
      {b.permissions.checkIn ? (
        <Button
          size="sm"
          variant="pri"
          loading={checkIn.isPending}
          onClick={() => checkIn.mutate(b.id)}
        >
          {t('calendar.booking.checkIn')}
        </Button>
      ) : null}
      {b.permissions.cancel ? (
        <Tooltip content={t('calendar.booking.cancel')}>
          <IconButton
            size="sm"
            tone="plain"
            aria-label={t('calendar.booking.cancel')}
            onClick={() => cancel.mutate(b.id)}
          >
            <Icon name="x" size={16} />
          </IconButton>
        </Tooltip>
      ) : null}
    </li>
  );
}
