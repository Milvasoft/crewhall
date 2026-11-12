import {
  addDaysToDate,
  dateToDay,
  type Calendar,
  type CalendarEvent,
  type CreateCalendarEvent,
  type SeriesScope,
  type UpdateCalendarEvent,
  type UserSummary,
} from '@crewhall/shared';
import {
  Button,
  DatePicker,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  TimePicker,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { api, idempotencyKey } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { calendarKeys } from '@/lib/calendar/queries';
import { availabilityQuery } from '@/lib/calendar/bookings';
import { useModuleEnabled } from '@/lib/identity/modules';
import {
  customFrom,
  customRule,
  nthOfMonth,
  orderedWeekdays,
  presetOf,
  presetRule,
  REPEAT_PRESETS,
  weekdayName,
  type CustomRule,
  type RepeatPreset,
} from '@/lib/calendar/recurrence';
import {
  dateOf,
  formatDateOnly,
  hhmm,
  instantAt,
  minuteOf,
  parseHhmm,
  rollEndDate,
  settleEndDate,
} from '@/lib/calendar/time';
import { AttendeePicker, Availability } from './AttendeePicker';
import { ScopeDialog } from './ScopeDialog';
import { SwitchRow, useFail } from './bits';

export interface EditorInitial {
  allDay: boolean;
  start: string;
  end: string;
  calendarId?: string;
}

const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];

/**
 * New and edit event dialog (roadmap 14). Dates and times are picked with the kit pickers in
 * the person's calendar zone; all-day events show an inclusive end date (stored exclusive).
 */
export function EventEditor({
  tz,
  calendars,
  defaultReminders,
  weekStart,
  initial,
  event,
  onClose,
  onSaved,
}: {
  tz: string;
  calendars: Calendar[];
  defaultReminders: number[];
  weekStart: number;
  /** New event: the slot clicked or dragged. */
  initial?: EditorInitial;
  /** Edit: the event (an occurrence of a series carries seriesId/recurrenceId). */
  event?: CalendarEvent;
  onClose: () => void;
  onSaved?: (e: CalendarEvent) => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  // An event stays on its side: a connected (Google / Microsoft) calendar or Crewhall's own.
  const source = event ?? null;
  const writable = calendars.filter(
    (c) =>
      c.permissions.write &&
      (!source || Boolean(c.external) === Boolean(source.external) || c.id === source.calendar.id),
  );
  const startIso = source?.start ?? initial!.start;
  const endIso = source?.end ?? initial!.end;
  const allDay0 = source?.allDay ?? initial!.allDay;

  const [title, setTitle] = useState(source?.title ?? '');
  const [allDay, setAllDay] = useState(allDay0);
  const [startDate, setStartDate] = useState(allDay0 ? startIso : dateOf(startIso, tz));
  // Timed events keep their real end date (an event ending at midnight ends the next day);
  // all-day events show the last day (stored exclusive).
  const [endDate, setEndDate] = useState(allDay0 ? addDaysToDate(endIso, -1) : dateOf(endIso, tz));
  const [startTime, setStartTime] = useState(allDay0 ? '09:00' : hhmm(minuteOf(startIso, tz)));
  const [endTime, setEndTime] = useState(allDay0 ? '10:00' : hhmm(minuteOf(endIso, tz)));
  const [calendarId, setCalendarId] = useState(
    source?.calendar.id ??
      initial?.calendarId ??
      writable.find((c) => c.isDefault)?.id ??
      writable[0]?.id ??
      '',
  );
  const seriesRule = source?.seriesId && !source.rrule ? null : (source?.rrule ?? null);
  const [preset, setPreset] = useState<RepeatPreset>(presetOf(seriesRule, startDate));
  const [custom, setCustom] = useState<CustomRule>(() => customFrom(seriesRule, startDate));
  const [location, setLocation] = useState(source?.location ?? '');
  const [description, setDescription] = useState(source?.description ?? '');
  const [people, setPeople] = useState<UserSummary[]>(
    source?.attendees.flatMap((a) => (a.user ? [a.user] : [])) ?? [],
  );
  const [emails, setEmails] = useState<string[]>(
    source?.attendees.filter((a) => !a.user).map((a) => a.email) ?? [],
  );
  const [reminders, setReminders] = useState<number[]>(source?.reminders ?? defaultReminders);
  const [busy, setBusy] = useState(source?.busy ?? true);
  const [isPrivate, setPrivate] = useState(source?.visibility === 'private');
  const meetOn = useModuleEnabled('meet');
  const [onlineMeeting, setOnlineMeeting] = useState(Boolean(source?.meeting));
  // The booked room (released or cancelled ones count as none).
  const room0 =
    source?.room && (source.room.status === 'confirmed' || source.room.status === 'checked_in')
      ? source.room.resourceId
      : null;
  const [roomId, setRoomId] = useState<string | null>(room0);
  const [askScope, setAskScope] = useState(false);
  const isOccurrence = Boolean(source?.seriesId && source.recurrenceId);
  // Connected calendars: the provider sends invitations and reminders, Crewhall adds no meeting.
  const external = Boolean(calendars.find((c) => c.id === calendarId)?.external);

  const times = useMemo(() => {
    if (allDay) {
      const end = addDaysToDate(endDate < startDate ? startDate : endDate, 1);
      return { start: startDate, end, valid: true };
    }
    const s = instantAt(startDate, parseHhmm(startTime), tz);
    let e = instantAt(rollEndDate(startDate, startTime, endDate, endTime), parseHhmm(endTime), tz);
    // An end date before the start date (typed by hand): keep half an hour.
    if (e <= s) e = new Date(s.getTime() + 30 * 60_000);
    return { start: s.toISOString(), end: e.toISOString(), valid: true };
  }, [allDay, startDate, endDate, startTime, endTime, tz]);

  // Rooms go on one-off timed events of Crewhall calendars.
  const roomsFit = !allDay && !external && !isOccurrence;

  const rule = useMemo(() => {
    if (preset === 'custom') {
      const until =
        custom.end === 'until' && !allDay ? instantAt(custom.until, 24 * 60 - 1, tz) : undefined;
      return customRule(custom, allDay, until);
    }
    return presetRule(preset, startDate);
  }, [preset, custom, allDay, startDate, tz]);

  const done = async (saved: CalendarEvent) => {
    await qc.invalidateQueries({ queryKey: calendarKeys.all });
    onSaved?.(saved);
    onClose();
  };

  const create = useMutation({
    mutationFn: (body: CreateCalendarEvent) =>
      api.call('createCalendarEvent', { body, idempotencyKey: idempotencyKey() }),
    onSuccess: done,
    onError: fail,
  });
  const update = useMutation({
    mutationFn: (body: UpdateCalendarEvent) =>
      api.call('updateCalendarEvent', {
        params: { eventId: source!.seriesId ?? source!.id },
        body,
      }),
    onSuccess: done,
    onError: fail,
  });

  const fields = () => ({
    title: title.trim(),
    description: description.trim() || null,
    location: location.trim() || null,
    busy,
    visibility: isPrivate ? ('private' as const) : ('default' as const),
    reminders,
    attendees: { userIds: people.map((p) => p.id), emails },
  });

  const save = (scope: SeriesScope) => {
    if (!source) {
      create.mutate({
        calendarId,
        allDay,
        start: times.start,
        end: times.end,
        timeZone: tz,
        rrule: rule,
        ...fields(),
        ...(onlineMeeting && !allDay && (!external || !rule) ? { onlineMeeting: true } : {}),
        ...(roomId && roomsFit ? { roomId } : {}),
      });
      return;
    }
    const timesChanged =
      times.start !== source.start || times.end !== source.end || allDay !== source.allDay;
    const ruleChanged = (rule ?? null) !== (seriesRule ?? null);
    update.mutate({
      ...fields(),
      ...(timesChanged ? { allDay, start: times.start, end: times.end } : {}),
      ...(ruleChanged && scope !== 'this' ? { rrule: rule } : {}),
      ...(calendarId !== source.calendar.id && scope === 'all' ? { calendarId } : {}),
      ...(onlineMeeting !== Boolean(source.meeting) && scope === 'all'
        ? { onlineMeeting: onlineMeeting && !allDay }
        : {}),
      ...((roomsFit ? roomId : null) !== room0 && scope === 'all'
        ? { roomId: roomsFit ? roomId : null }
        : {}),
      scope,
      recurrenceId: source.recurrenceId ?? undefined,
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !calendarId) return;
    if (isOccurrence) setAskScope(true);
    else save('all');
  };

  const date = (d: string) => formatDateOnly(d, locale, { day: 'numeric', month: 'long' });
  const { n, weekday } = nthOfMonth(startDate);
  const presetLabel = (p: RepeatPreset) => {
    switch (p) {
      case 'weekly':
        return t('calendar.repeat.weekly', { label: weekdayName(weekday, locale) });
      case 'monthlyDay':
        return t('calendar.repeat.monthlyDay', { value: Number(startDate.slice(8, 10)) });
      case 'monthlyNth':
        return n === -1
          ? t('calendar.repeat.monthlyLast', { label: weekdayName(weekday, locale) })
          : t('calendar.repeat.monthlyNth', { n, label: weekdayName(weekday, locale) });
      case 'yearly':
        return t('calendar.repeat.yearly', { date: date(startDate) });
      default:
        return t(`calendar.repeat.${p}`);
    }
  };
  const pending = create.isPending || update.isPending;

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent width={600}>
          <DialogHeader
            title={source ? t('calendar.editor.editTitle') : t('calendar.editor.newTitle')}
          />
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field label={t('calendar.editor.title')}>
              <Input
                autoFocus
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('calendar.editor.titlePlaceholder')}
              />
            </Field>
            <SwitchRow label={t('calendar.allDay')} checked={allDay} onChange={setAllDay} />
            <div className="grid grid-cols-[1.4fr_1fr] gap-3">
              <Field label={t('calendar.editor.startDate')}>
                <DatePicker
                  value={startDate}
                  clearable={false}
                  onChange={(v) => {
                    if (!v) return;
                    // Keep the length in days when the start moves.
                    const len = dateToDay(endDate) - dateToDay(startDate);
                    setStartDate(v);
                    setEndDate(addDaysToDate(v, Math.max(0, len)));
                  }}
                />
              </Field>
              {allDay ? null : (
                <Field label={t('calendar.editor.startTime')}>
                  <TimePicker
                    value={startTime}
                    minuteStep={15}
                    onChange={(v) => {
                      if (!v) return;
                      setStartTime(v);
                      setEndDate(settleEndDate(startDate, v, endDate, endTime));
                    }}
                  />
                </Field>
              )}
              <Field label={t('calendar.editor.endDate')}>
                <DatePicker
                  value={endDate}
                  min={startDate}
                  clearable={false}
                  onChange={(v) => v && setEndDate(v)}
                />
              </Field>
              {allDay ? null : (
                <Field label={t('calendar.editor.endTime')}>
                  <TimePicker
                    value={endTime}
                    minuteStep={15}
                    onChange={(v) => {
                      if (!v) return;
                      setEndTime(v);
                      setEndDate(settleEndDate(startDate, startTime, endDate, v));
                    }}
                  />
                </Field>
              )}
            </div>
            <p className="-mt-2 text-xs text-fg3">{t('calendar.editor.zone', { zone: tz })}</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('calendar.editor.repeat')}>
                <Select
                  value={preset}
                  onValueChange={(v) => setPreset(v as RepeatPreset)}
                  disabled={isOccurrence && !source?.rrule}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REPEAT_PRESETS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {presetLabel(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('calendar.editor.calendar')}>
                <Select value={calendarId} onValueChange={setCalendarId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('calendar.editor.calendar')} />
                  </SelectTrigger>
                  <SelectContent>
                    {writable.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.isDefault ? t('calendar.sidebar.mine') : c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {preset === 'custom' ? (
              <CustomRepeat value={custom} onChange={setCustom} weekStart={weekStart} />
            ) : null}
            <Field label={t('calendar.editor.people')}>
              <AttendeePicker
                people={people}
                onPeople={setPeople}
                emails={emails}
                onEmails={setEmails}
              />
            </Field>
            <Availability
              people={people}
              date={startDate}
              start={allDay ? null : times.start}
              end={allDay ? null : times.end}
              tz={tz}
            />
            <Field label={t('calendar.editor.location')}>
              <Input
                value={location}
                maxLength={500}
                onChange={(e) => setLocation(e.target.value)}
              />
            </Field>
            <RoomField
              value={roomId}
              onChange={setRoomId}
              from={times.start}
              to={times.end}
              people={people.length + emails.length + 1}
              eventId={source?.seriesId ?? source?.id}
              disabled={!roomsFit || Boolean(rule)}
            />
            <Field label={t('calendar.editor.description')}>
              <Textarea
                value={description}
                rows={3}
                maxLength={10_000}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            {external ? null : (
              <Reminders value={reminders} onChange={setReminders} allDay={allDay} />
            )}
            <div className="flex flex-col gap-3 rounded-xl bg-bg2 p-4">
              {meetOn && (!external || !rule) ? (
                <SwitchRow
                  label={t('calendar.editor.onlineMeeting')}
                  hint={
                    allDay
                      ? t('calendar.editor.onlineMeetingAllDay')
                      : t('calendar.editor.onlineMeetingHint')
                  }
                  checked={onlineMeeting && !allDay}
                  disabled={allDay || (isOccurrence && !source?.meeting)}
                  onChange={setOnlineMeeting}
                />
              ) : null}
              <SwitchRow
                label={t('calendar.editor.busy')}
                hint={t('calendar.editor.busyHint')}
                checked={busy}
                onChange={setBusy}
              />
              <SwitchRow
                label={t('calendar.editor.private')}
                hint={t('calendar.editor.privateHint')}
                checked={isPrivate}
                onChange={setPrivate}
              />
            </div>
            <DialogFooter>
              <Button variant="gh" onClick={onClose}>
                {t('common.actions.cancel')}
              </Button>
              <Button
                type="submit"
                variant="pri"
                loading={pending}
                disabled={!title.trim() || !calendarId}
              >
                {source ? t('common.actions.save') : t('calendar.editor.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {askScope ? (
        <ScopeDialog
          kind="edit"
          withFollowing={!source?.external}
          onCancel={() => setAskScope(false)}
          onPick={(s) => {
            setAskScope(false);
            save(s);
          }}
        />
      ) : null}
    </>
  );
}

function CustomRepeat({
  value,
  onChange,
  weekStart,
}: {
  value: CustomRule;
  onChange: (v: CustomRule) => void;
  weekStart: number;
}) {
  const { t, locale } = useI18n();
  const set = (patch: Partial<CustomRule>) => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-bg2 p-4" data-testid="calendar-custom-repeat">
      <div className="flex items-center gap-2">
        <span className="text-sm">{t('calendar.repeat.every')}</span>
        <Input
          type="number"
          min={1}
          max={999}
          value={value.interval}
          onChange={(e) => set({ interval: Number(e.target.value) || 1 })}
          className="w-20"
          aria-label={t('calendar.repeat.interval')}
        />
        <Select value={value.freq} onValueChange={(v) => set({ freq: v as CustomRule['freq'] })}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const).map((f) => (
              <SelectItem key={f} value={f}>
                {t(`calendar.repeat.unit.${f}`, { count: value.interval })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {value.freq === 'WEEKLY' ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('calendar.repeat.on')}>
          {orderedWeekdays(weekStart).map((w) => {
            const on = value.weekdays.includes(w);
            return (
              <button
                key={w}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  set({
                    weekdays: on ? value.weekdays.filter((x) => x !== w) : [...value.weekdays, w],
                  })
                }
                className={
                  on
                    ? 'flex size-9 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-fg'
                    : 'flex size-9 items-center justify-center rounded-full bg-surface text-xs font-semibold text-fg2 shadow-line'
                }
              >
                {weekdayName(w, locale, 'short').slice(0, 2)}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">{t('calendar.repeat.ends')}</span>
        <Select value={value.end} onValueChange={(v) => set({ end: v as CustomRule['end'] })}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['never', 'count', 'until'] as const).map((x) => (
              <SelectItem key={x} value={x}>
                {t(`calendar.repeat.end.${x}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {value.end === 'count' ? (
          <Input
            type="number"
            min={1}
            max={1000}
            value={value.count}
            onChange={(e) => set({ count: Number(e.target.value) || 1 })}
            className="w-24"
            aria-label={t('calendar.repeat.count')}
          />
        ) : value.end === 'until' ? (
          <div className="w-48">
            <DatePicker
              value={value.until}
              clearable={false}
              onChange={(v) => v && set({ until: v })}
              aria-label={t('calendar.repeat.until')}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Reminders({
  value,
  onChange,
  allDay,
}: {
  value: number[];
  onChange: (v: number[]) => void;
  allDay: boolean;
}) {
  const { t } = useI18n();
  const label = (m: number) => reminderLabel(m, allDay, t);
  const left = REMINDER_CHOICES.filter((m) => !value.includes(m));
  return (
    <Field label={t('calendar.editor.reminders')}>
      <div className="flex flex-wrap items-center gap-1.5">
        {value
          .slice()
          .sort((a, b) => a - b)
          .map((m) => (
            <span
              key={m}
              className="flex h-8 items-center gap-1.5 rounded-full bg-bg2 px-3 text-[13px] font-semibold"
            >
              <Icon name="bell" size={13} />
              {label(m)}
              <button
                type="button"
                aria-label={t('calendar.editor.remove', { name: label(m) })}
                onClick={() => onChange(value.filter((x) => x !== m))}
                className="text-fg3 hover:text-fg"
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        {value.length < 5 && left.length ? (
          <Select value="" onValueChange={(v) => onChange([...value, Number(v)])}>
            <SelectTrigger className="h-8 w-auto gap-1 rounded-full px-3 text-[13px]">
              <SelectValue placeholder={t('calendar.editor.addReminder')} />
            </SelectTrigger>
            <SelectContent>
              {left.map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {label(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
    </Field>
  );
}

export function reminderLabel(
  m: number,
  allDay: boolean,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (allDay) {
    return m === 0
      ? t('calendar.reminder.sameDay')
      : t('calendar.reminder.daysBefore', { count: Math.ceil(m / 1440) });
  }
  if (m === 0) return t('calendar.reminder.atStart');
  if (m % 10080 === 0) return t('calendar.reminder.weeks', { count: m / 10080 });
  if (m % 1440 === 0) return t('calendar.reminder.days', { count: m / 1440 });
  if (m % 60 === 0) return t('calendar.reminder.hours', { count: m / 60 });
  return t('calendar.reminder.minutes', { count: m });
}

/**
 * The meeting's room (sonraki-isler, booking): free rooms for the chosen time, the smallest one
 * that fits everyone suggested. Hidden when the org has no rooms.
 */
function RoomField({
  value,
  onChange,
  from,
  to,
  people,
  eventId,
  disabled,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  from: string;
  to: string;
  people: number;
  eventId?: string;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const q = useQuery({
    ...availabilityQuery({ from, to, kind: 'room', capacity: people, eventId }),
    enabled: from < to,
    placeholderData: (prev) => prev,
  });
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  const suggested = items.find((i) => i.resource.id === q.data?.suggestedId);
  const label = (i: (typeof items)[number]) =>
    !i.free
      ? t('calendar.booking.roomBusy', { name: i.resource.name })
      : !i.fits
        ? t('calendar.booking.roomSmall', { name: i.resource.name })
        : i.resource.capacity
          ? `${i.resource.name} · ${t('calendar.booking.capacity', { count: i.resource.capacity })}`
          : i.resource.name;
  return (
    <Field
      label={t('calendar.booking.room')}
      hint={disabled ? t('calendar.booking.roomHint') : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={value ?? NO_ROOM}
          disabled={disabled}
          onValueChange={(v) => onChange(v === NO_ROOM ? null : v)}
        >
          <SelectTrigger className="min-w-[220px] flex-1" aria-label={t('calendar.booking.room')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_ROOM}>{t('calendar.booking.noRoom')}</SelectItem>
            {items.map((i) => (
              <SelectItem
                key={i.resource.id}
                value={i.resource.id}
                disabled={!i.free && i.resource.id !== value}
              >
                {label(i)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!disabled && !value && suggested ? (
          <Button
            type="button"
            size="sm"
            variant="out"
            onClick={() => onChange(suggested.resource.id)}
          >
            <Icon name="sparkle" size={14} />
            {t('calendar.booking.suggested', { name: suggested.resource.name })}
          </Button>
        ) : null}
      </div>
    </Field>
  );
}

const NO_ROOM = '__none__';
