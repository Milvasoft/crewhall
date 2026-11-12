import { type CreateMeeting, type MeetingRecurrence, type UserSummary } from '@crewhall/shared';
import {
  Avatar,
  Button,
  Dialog,
  DialogContent,
  DatePicker,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SuggestionPanel,
  Textarea,
  TimePicker,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { isEmail } from '@/components/common/EmailChips';
import { spaceName } from '@/components/spaces/spaceUtils';
import { api, idempotencyKey } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { meetKeys, meetSpaceSettingsQuery } from '@/lib/meet/queries';
import { useMemberSearch } from '@/lib/meet/memberSearch';
import { useMe } from '@/lib/session';
import { useSpaces } from '@/lib/useSpaces';
import { SwitchRow, useCopyLink, useFail } from './bits';
import { useOpenMeeting } from './openMeeting';

export type NewMeetingMode = 'instant' | 'scheduled' | 'room';

export const NO_SPACE = 'none';
export const DURATIONS = [15, 30, 45, 60, 90, 120];

function pad(n: number) {
  return String(n).padStart(2, '0');
}

/** Next half hour, local. */
function defaultStart() {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * Design 7.2 / 19.22: "Hemen başlat" asks only a title and opens the waiting room,
 * "Planla" adds date, people and guests (.ics invitations), "Kalıcı oda" makes a fixed link.
 */
export function NewMeetingDialog({
  mode: initialMode,
  onOpenChange,
  conversationId,
}: {
  mode: NewMeetingMode;
  onOpenChange: (open: boolean) => void;
  conversationId?: string;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const openMeeting = useOpenMeeting();
  const fail = useFail();
  const copy = useCopyLink();
  const { items: spaces, preferred } = useSpaces();
  const [mode, setMode] = useState<NewMeetingMode>(initialMode);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [spaceId, setSpaceId] = useState<string>(() => {
    const p = preferred();
    return p && p.kind === 'shared' ? p.id : NO_SPACE;
  });
  const [start] = useState(defaultStart);
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const [duration, setDuration] = useState(45);
  const [recurrence, setRecurrence] = useState<MeetingRecurrence>('none');
  const [people, setPeople] = useState<UserSummary[]>([]);
  const [emails, setEmails] = useState<string[]>([]);
  const [guestsAllowed, setGuestsAllowed] = useState(false);
  const [lobby, setLobby] = useState(true);
  const [autoRecord, setAutoRecord] = useState(false);
  const [slug, setSlug] = useState('');

  const space = spaces.find((s) => s.id === spaceId);
  const spaceSettings = useQuery({
    ...meetSpaceSettingsQuery(spaceId),
    enabled: spaceId !== NO_SPACE,
  });
  // Design 7.2: guests only when the space admin allows them.
  const guestsPossible = spaceId === NO_SPACE || spaceSettings.data?.guestsAllowed !== false;

  const create = useMutation({
    mutationFn: (body: CreateMeeting) =>
      api.call('createMeeting', { body, idempotencyKey: idempotencyKey() }),
    onSuccess: async (m) => {
      await qc.invalidateQueries({ queryKey: meetKeys.all });
      onOpenChange(false);
      if (mode === 'instant') {
        openMeeting(m.slug);
      } else {
        toast(mode === 'scheduled' ? t('meet.new.scheduled') : t('meet.new.roomCreated'), {
          action: { label: t('meet.actions.copyLink'), onClick: () => void copy(m.url) },
        });
      }
    },
    onError: fail,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const sid = spaceId === NO_SPACE ? undefined : spaceId;
    const settings = { guestsAllowed: guestsAllowed || emails.length > 0, lobby, autoRecord };
    if (mode === 'instant') {
      create.mutate({ mode, title: title.trim() || undefined, spaceId: sid, conversationId });
    } else if (mode === 'scheduled') {
      create.mutate({
        mode,
        title: title.trim(),
        description: description.trim() || undefined,
        spaceId: sid,
        conversationId,
        startsAt: new Date(`${date}T${time}`).toISOString(),
        durationMinutes: duration,
        recurrence,
        invitees: { userIds: people.map((p) => p.id), emails },
        settings,
      });
    } else {
      create.mutate({ mode, title: title.trim(), spaceId: sid, slug: slug || undefined, settings });
    }
  };

  const valid = mode === 'instant' || title.trim().length > 0;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent width={560}>
        <DialogHeader title={t('meet.new.title')} />
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Segmented
            value={mode}
            onValueChange={setMode}
            aria-label={t('meet.new.title')}
            options={[
              { value: 'instant', label: t('meet.new.instant') },
              { value: 'scheduled', label: t('meet.new.scheduled_tab') },
              { value: 'room', label: t('meet.new.room') },
            ]}
          />
          <Field label={t('meet.new.titleLabel')}>
            <Input
              autoFocus
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                mode === 'instant' ? t('meet.new.titleOptional') : t('meet.new.titlePlaceholder')
              }
            />
          </Field>
          {mode === 'scheduled' ? (
            <Field label={t('meet.meetingActions.description')}>
              <Textarea
                rows={2}
                value={description}
                maxLength={2000}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('meet.meetingActions.descriptionPlaceholder')}
              />
            </Field>
          ) : null}
          {mode === 'scheduled' ? (
            <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-3">
              <Field label={t('meet.new.date')}>
                <DatePicker value={date} clearable={false} onChange={(v) => v && setDate(v)} />
              </Field>
              <Field label={t('meet.new.time')}>
                <TimePicker value={time} onChange={(v) => v && setTime(v)} />
              </Field>
              <Field label={t('meet.new.duration')}>
                <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v))}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATIONS.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {t('meet.duration.minutes', { min: d })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('meet.new.space')}>
              <Select value={spaceId} onValueChange={setSpaceId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SPACE}>{t('meet.new.noSpace')}</SelectItem>
                  {spaces
                    .filter((s) => s.kind === 'shared' && s.myRole !== 'viewer' && !s.archivedAt)
                    .map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {spaceName(s, t)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
            {mode === 'scheduled' ? (
              <Field label={t('meet.new.repeat')}>
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
            ) : mode === 'room' ? (
              <Field label={t('meet.new.slug')} hint={t('meet.new.slugHint')}>
                <Input
                  value={slug}
                  onChange={(e) =>
                    setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
                  }
                  placeholder="team-daily"
                  maxLength={48}
                />
              </Field>
            ) : null}
          </div>
          {mode === 'scheduled' ? (
            <Field label={t('meet.new.people')}>
              <PeoplePicker
                people={people}
                onPeople={setPeople}
                emails={emails}
                onEmails={setEmails}
                guestsPossible={guestsPossible}
              />
            </Field>
          ) : null}
          {mode !== 'instant' ? (
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
          ) : (
            <p className="text-xs text-fg3">
              {space
                ? t('meet.new.instantHintSpace', { name: spaceName(space, t) })
                : t('meet.new.instantHint')}
            </p>
          )}
          <DialogFooter>
            <Button variant="gh" onClick={() => onOpenChange(false)}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="pri" loading={create.isPending} disabled={!valid}>
              {mode === 'instant'
                ? t('meet.new.submitInstant')
                : mode === 'scheduled'
                  ? t('meet.new.submitScheduled')
                  : t('meet.new.submitRoom')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Members by name, guests by e-mail ("Kişi ya da e-posta…"). */
export function PeoplePicker({
  people,
  onPeople,
  emails,
  onEmails,
  guestsPossible,
}: {
  people: UserSummary[];
  onPeople: (p: UserSummary[]) => void;
  emails: string[];
  onEmails: (e: string[]) => void;
  guestsPossible: boolean;
}) {
  const { t } = useI18n();
  const me = useMe();
  const [q, setQ] = useState('');
  // The query the user dismissed the suggestions for (outside click, Escape).
  const [dismissed, setDismissed] = useState<string | null>(null);
  const searched = useMemberSearch(q);
  const chosen = new Set(people.map((p) => p.id));
  const matches = searched.filter((u) => u.id !== me?.user.id && !chosen.has(u.id)).slice(0, 6);

  const addEmail = () => {
    const v = q.trim().toLowerCase();
    if (!isEmail(v)) return false;
    const member = searched.find((u) => u.email.toLowerCase() === v);
    if (member) onPeople([...people, member]);
    else if (guestsPossible) onEmails([...new Set([...emails, v])]);
    else return false;
    setQ('');
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (!addEmail() && matches[0]) {
        onPeople([...people, matches[0]]);
        setQ('');
      }
    } else if (e.key === 'Backspace' && !q) {
      if (emails.length) onEmails(emails.slice(0, -1));
      else if (people.length) onPeople(people.slice(0, -1));
    }
  };

  return (
    <SuggestionPanel
      open={matches.length > 0 && dismissed !== q}
      onDismiss={() => setDismissed(q)}
      anchor={
        <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg bg-bg2 px-2.5 py-2">
          {people.map((p) => (
            <span
              key={p.id}
              className="flex h-7 items-center gap-1.5 rounded-full bg-surface pr-2 pl-1 text-[13px] font-semibold shadow-line"
            >
              <Avatar name={p.name} src={p.imageUrl} size="sm" />
              {p.name}
              <button
                type="button"
                aria-label={t('meet.new.remove', { name: p.name })}
                onClick={() => onPeople(people.filter((x) => x.id !== p.id))}
                className="text-fg3 hover:text-fg"
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          {emails.map((e) => (
            <span
              key={e}
              className="flex h-7 items-center gap-1.5 rounded-full bg-surface px-2 text-[13px] font-semibold shadow-line"
            >
              <Icon name="mail" size={13} />
              {e}
              <span className="text-[11px] text-fg3">{t('meet.guest')}</span>
              <button
                type="button"
                aria-label={t('meet.new.remove', { name: e })}
                onClick={() => onEmails(emails.filter((x) => x !== e))}
                className="text-fg3 hover:text-fg"
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => addEmail()}
            placeholder={t('meet.new.peoplePlaceholder')}
            className="h-7 min-w-[160px] flex-1 bg-transparent text-sm outline-none placeholder:text-fg3"
          />
        </div>
      }
      className="p-1"
    >
      <ul className="m-0 flex list-none flex-col p-0">
        {matches.map((u) => (
          <li key={u.id}>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPeople([...people, u]);
                setQ('');
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-bg2"
            >
              <Avatar name={u.name} src={u.imageUrl} size="sm" />
              <span className="font-semibold">{u.name}</span>
              <span className="text-xs text-fg3">{u.email}</span>
            </button>
          </li>
        ))}
      </ul>
    </SuggestionPanel>
  );
}
