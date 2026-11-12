import {
  MEET_LIMITS,
  type Meeting,
  type MeetingRecurrence,
  type UpdateMeeting,
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
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  TimePicker,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ActionContextMenu,
  ActionDropdown,
  type ActionEntry,
} from '@/components/common/ActionMenu';
import { spaceName } from '@/components/spaces/spaceUtils';
import { api } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n/I18nContext';
import { meetKeys, meetSpaceSettingsQuery } from '@/lib/meet/queries';
import { useSpaces } from '@/lib/useSpaces';
import { SwitchRow, useCopyLink, useFail } from './bits';
import { DURATIONS, NO_SPACE, PeoplePicker } from './NewMeetingDialog';

type Open = 'edit' | 'people' | 'cancel' | null;

const pad = (n: number) => String(n).padStart(2, '0');

/** Local date and time fields of an instant. */
function localParts(iso: string | null) {
  const d = iso ? new Date(iso) : new Date();
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function zoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
}

/**
 * A scheduled meeting's actions (right-click on its row or the "…" button; also in the calendar
 * panel): edit, copy the link, manage the people, cancel. Only moderators (host, space admins)
 * get the changing ones; the server checks again. A meeting created from the calendar is changed
 * through its calendar event, where its repeat scopes live.
 */
export function useMeetingActions(m: Meeting) {
  const { t } = useI18n();
  const copy = useCopyLink();
  const navigate = useNavigate();
  const [open, setOpen] = useState<Open>(null);
  const manage = m.permissions.moderate && !m.cancelledAt;
  const inCalendar = Boolean(m.calendarEventId);
  const toCalendar = () =>
    void navigate({ to: '/calendar', search: { event: m.calendarEventId ?? undefined } });
  const entries: ActionEntry[] = [];
  if (manage) {
    entries.push({
      kind: 'item',
      key: 'edit',
      icon: inCalendar ? 'calendar' : 'edit',
      label: inCalendar ? t('meet.meetingActions.editInCalendar') : t('meet.meetingActions.edit'),
      onSelect: () => (inCalendar ? toCalendar() : setOpen('edit')),
    });
  }
  entries.push({
    kind: 'item',
    key: 'copy',
    icon: 'link',
    label: t('meet.actions.copyLink'),
    onSelect: () => void copy(m.url),
  });
  if (manage && !inCalendar) {
    entries.push(
      {
        kind: 'item',
        key: 'people',
        icon: 'users',
        label: t('meet.meetingActions.people'),
        onSelect: () => setOpen('people'),
      },
      { kind: 'sep', key: 'sep' },
      {
        kind: 'item',
        key: 'cancel',
        icon: 'trash',
        label: t('meet.meetingActions.cancel'),
        danger: true,
        disabledReason: m.live ? t('meet.meetingActions.endFirst') : undefined,
        onSelect: () => setOpen('cancel'),
      },
    );
  }
  const close = (o: boolean) => !o && setOpen(null);
  const dialogs =
    open === 'edit' || open === 'people' ? (
      <EditMeetingDialog
        meeting={m}
        focus={open === 'people' ? 'people' : undefined}
        onOpenChange={close}
      />
    ) : open === 'cancel' ? (
      <CancelMeetingDialog meeting={m} onOpenChange={close} />
    ) : null;
  return { entries, dialogs };
}

/** Only the "…" button (the meeting's own page header). */
export function MeetingMenuButton({ m }: { m: Meeting }) {
  const { t } = useI18n();
  const { entries, dialogs } = useMeetingActions(m);
  return (
    <>
      <ActionDropdown entries={entries}>
        <IconButton
          size="sm"
          tone="plain"
          aria-label={t('meet.meetingActions.menu', { title: m.title })}
        >
          <Icon name="dots" size={16} />
        </IconButton>
      </ActionDropdown>
      {dialogs}
    </>
  );
}

/** Wraps a meeting row: its right-click menu, plus the "…" button placed by the row. */
export function MeetingActions({
  m,
  children,
}: {
  m: Meeting;
  children: (menuButton: ReactNode) => ReactNode;
}) {
  const { t } = useI18n();
  const { entries, dialogs } = useMeetingActions(m);
  const button = (
    <ActionDropdown entries={entries}>
      <IconButton
        size="sm"
        tone="plain"
        aria-label={t('meet.meetingActions.menu', { title: m.title })}
      >
        <Icon name="dots" size={16} />
      </IconButton>
    </ActionDropdown>
  );
  return (
    <>
      <ActionContextMenu entries={entries}>{children(button)}</ActionContextMenu>
      {dialogs}
    </>
  );
}

function useMeetingMutation<T>(fn: () => Promise<T>, done: MessageKey, onDone: () => void) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      // The calendar shows meetings too.
      await Promise.all([
        qc.invalidateQueries({ queryKey: meetKeys.all }),
        qc.invalidateQueries({ queryKey: ['calendar'] }),
      ]);
      toast(t(done));
      onDone();
    },
    onError: fail,
  });
}

/**
 * Everything of a scheduled meeting, as when planning it: title, description, date, time and
 * length, repeat, space, people and guests, lobby and recording. Saving tells the people in it
 * (the server sends the bell, push and updated .ics invitations).
 */
export function EditMeetingDialog({
  meeting: m,
  focus,
  onOpenChange,
}: {
  meeting: Meeting;
  /** "Davetlileri yönet": opens on the people field. */
  focus?: 'people';
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { items: spaces } = useSpaces();
  const start = localParts(m.startsAt);
  const [title, setTitle] = useState(m.title);
  const [description, setDescription] = useState(m.description ?? '');
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const [duration, setDuration] = useState(m.durationMinutes ?? 30);
  const [recurrence, setRecurrence] = useState<MeetingRecurrence>(m.recurrence);
  const [spaceId, setSpaceId] = useState(m.spaceId ?? NO_SPACE);
  const [people, setPeople] = useState<UserSummary[]>(() =>
    m.invitees.flatMap((i) => (i.user ? [i.user] : [])),
  );
  const [emails, setEmails] = useState<string[]>(() =>
    m.invitees.flatMap((i) => (!i.user && i.email ? [i.email] : [])),
  );
  const [guestsAllowed, setGuestsAllowed] = useState(m.settings.guestsAllowed);
  const [lobby, setLobby] = useState(m.settings.lobby);
  const [autoRecord, setAutoRecord] = useState(m.settings.autoRecord);
  const peopleRef = useRef<HTMLDivElement>(null);

  const spaceSettings = useQuery({
    ...meetSpaceSettingsQuery(spaceId),
    enabled: spaceId !== NO_SPACE,
  });
  const guestsPossible = spaceId === NO_SPACE || spaceSettings.data?.guestsAllowed !== false;
  const trimmed = title.trim();
  const valid = trimmed.length > 0 && trimmed.length <= MEET_LIMITS.titleChars && Boolean(date);

  const body = (): UpdateMeeting => ({
    title: trimmed,
    description: description.trim() || null,
    startsAt: new Date(`${date}T${time}`).toISOString(),
    durationMinutes: duration,
    recurrence,
    spaceId: spaceId === NO_SPACE ? null : spaceId,
    invitees: { userIds: people.map((p) => p.id), emails },
    settings: {
      guestsAllowed: (guestsAllowed || emails.length > 0) && guestsPossible,
      lobby,
      autoRecord,
    },
  });
  const save = useMeetingMutation(
    () => api.call('updateMeeting', { params: { meetingId: m.id }, body: body() }),
    'meet.meetingActions.saved',
    () => onOpenChange(false),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) save.mutate();
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        width={600}
        onOpenAutoFocus={(e) => {
          // "Davetlileri yönet": straight to the people field.
          if (focus !== 'people') return;
          e.preventDefault();
          peopleRef.current?.scrollIntoView({ block: 'center' });
          peopleRef.current?.querySelector('input')?.focus();
        }}
      >
        <DialogHeader title={t('meet.meetingActions.editTitle')} />
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field
            label={t('meet.new.titleLabel')}
            error={trimmed ? undefined : t('meet.meetingActions.titleRequired')}
          >
            <Input
              value={title}
              maxLength={MEET_LIMITS.titleChars}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label={t('meet.meetingActions.description')}>
            <Textarea
              rows={3}
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('meet.meetingActions.descriptionPlaceholder')}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr_1fr]">
            <Field label={t('meet.new.date')}>
              <DatePicker value={date} clearable={false} onChange={(v) => v && setDate(v)} />
            </Field>
            <Field label={t('meet.new.time')} hint={zoneName()}>
              <TimePicker value={time} onChange={(v) => v && setTime(v)} />
            </Field>
            <Field label={t('meet.new.duration')}>
              <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[...new Set([...DURATIONS, duration])]
                    .sort((a, b) => a - b)
                    .map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {t('meet.duration.minutes', { min: d })}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t('meet.new.repeat')}
              hint={recurrence !== 'none' ? t('meet.meetingActions.wholeSeries') : undefined}
            >
              <Select
                value={recurrence}
                onValueChange={(v) => setRecurrence(v as MeetingRecurrence)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['none', 'daily', 'weekdays', 'weekly'] as const).map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`meet.recurrence.${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('meet.new.space')}>
              <Select value={spaceId} onValueChange={setSpaceId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SPACE}>{t('meet.new.noSpace')}</SelectItem>
                  {spaces
                    .filter(
                      (s) =>
                        s.kind === 'shared' &&
                        !s.archivedAt &&
                        (s.myRole !== 'viewer' || s.id === m.spaceId),
                    )
                    .map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {spaceName(s, t)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div ref={peopleRef}>
            <Field label={t('meet.new.people')} hint={t('meet.meetingActions.peopleHint')}>
              <PeoplePicker
                people={people}
                onPeople={setPeople}
                emails={emails}
                onEmails={setEmails}
                guestsPossible={guestsPossible}
              />
            </Field>
          </div>
          <div className="flex flex-col gap-3 rounded-xl bg-bg2 p-4">
            <SwitchRow
              label={t('meet.new.guests')}
              hint={guestsPossible ? t('meet.new.guestsHint') : t('meet.new.guestsOff')}
              checked={(guestsAllowed || emails.length > 0) && guestsPossible}
              onChange={setGuestsAllowed}
              disabled={!guestsPossible}
            />
            <SwitchRow
              label={t('meet.new.lobby')}
              hint={t('meet.new.lobbyHint')}
              checked={lobby}
              onChange={setLobby}
            />
            <SwitchRow
              label={t('meet.new.autoRecord')}
              hint={t('meet.new.autoRecordHint')}
              checked={autoRecord}
              onChange={setAutoRecord}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="gh" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="pri" loading={save.isPending} disabled={!valid}>
              {t('common.actions.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "İptal et": the people get a cancellation (bell, push, cancel .ics); history stays. */
export function CancelMeetingDialog({
  meeting: m,
  onOpenChange,
}: {
  meeting: Meeting;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const cancel = useMeetingMutation(
    () => api.call('cancelMeeting', { params: { meetingId: m.id } }),
    'meet.meetingActions.cancelled',
    () => onOpenChange(false),
  );
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent width={460}>
        <DialogHeader
          title={t('meet.meetingActions.cancelTitle', { title: m.title })}
          description={t('meet.meetingActions.cancelBody')}
        />
        <DialogFooter>
          <Button variant="gh" onClick={() => onOpenChange(false)}>
            {t('meet.meetingActions.keep')}
          </Button>
          <Button variant="dngf" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
            {t('meet.meetingActions.cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
