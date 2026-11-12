import { type UserSummary } from '@crewhall/shared';
import { Avatar, cn, Icon, SuggestionPanel } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { freeBusyQuery } from '@/lib/calendar/queries';
import { formatTimeIn, instantAt } from '@/lib/calendar/time';
import { membersQuery } from '@/lib/queries';
import { useMe } from '@/lib/session';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Org members by name, outside guests by e-mail ("Kişi ya da e-posta…"). */
export function AttendeePicker({
  people,
  onPeople,
  emails,
  onEmails,
}: {
  people: UserSummary[];
  onPeople: (p: UserSummary[]) => void;
  emails: string[];
  onEmails: (e: string[]) => void;
}) {
  const { t } = useI18n();
  const me = useMe();
  const [q, setQ] = useState('');
  const [dismissed, setDismissed] = useState<string | null>(null);
  const members = useQuery({ ...membersQuery({ status: 'active' }), staleTime: 60_000 });
  const chosen = new Set(people.map((p) => p.id));
  const term = q.trim().toLocaleLowerCase('tr');
  const matches = term
    ? (members.data?.items ?? [])
        .map((m) => m.user)
        .filter(
          (u) =>
            u.id !== me?.user.id &&
            !chosen.has(u.id) &&
            (u.name.toLocaleLowerCase('tr').includes(term) || u.email.toLowerCase().includes(term)),
        )
        .slice(0, 6)
    : [];

  const addEmail = () => {
    const v = q.trim().toLowerCase();
    if (!EMAIL_RE.test(v)) return false;
    const member = (members.data?.items ?? []).find((m) => m.user.email.toLowerCase() === v);
    if (member) {
      if (!chosen.has(member.user.id)) onPeople([...people, member.user]);
    } else onEmails([...new Set([...emails, v])]);
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
                aria-label={t('calendar.editor.remove', { name: p.name })}
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
              <span className="text-[11px] text-fg3">{t('calendar.editor.guest')}</span>
              <button
                type="button"
                aria-label={t('calendar.editor.remove', { name: e })}
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
            placeholder={t('calendar.editor.peoplePlaceholder')}
            aria-label={t('calendar.editor.people')}
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

const FROM_H = 7;
const TO_H = 21;

/**
 * Availability of the chosen people on the event's day ("uygunluk"): their busy times
 * (no titles) on a 07-21 strip with the proposed time marked; conflicts are named.
 */
export function Availability({
  people,
  date,
  start,
  end,
  tz,
}: {
  people: UserSummary[];
  date: string;
  /** Proposed instants (ISO); null for all-day events. */
  start: string | null;
  end: string | null;
  tz: string;
}) {
  const { t, locale } = useI18n();
  const ids = useMemo(() => people.map((p) => p.id), [people]);
  const from = instantAt(date, 0, tz).toISOString();
  const to = instantAt(date, 24 * 60, tz).toISOString();
  const fb = useQuery({ ...freeBusyQuery(ids, from, to), enabled: ids.length > 0 });
  if (!ids.length) return null;
  const dayStart = instantAt(date, FROM_H * 60, tz).getTime();
  const span = (TO_H - FROM_H) * 3_600_000;
  const pos = (iso: string) => Math.max(0, Math.min(1, (Date.parse(iso) - dayStart) / span)) * 100;
  const conflicts = people.filter((p) =>
    fb.data?.items
      .find((i) => i.userId === p.id)
      ?.busy.some((b) => start && end && b.start < end && b.end > start),
  );
  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl bg-bg2 p-3"
      data-testid="calendar-availability"
    >
      <div className="flex items-center justify-between text-xs text-fg3">
        <span className="font-semibold text-fg2">{t('calendar.editor.availability')}</span>
        <span>
          {formatTimeIn(new Date(dayStart).toISOString(), locale, tz)} –{' '}
          {formatTimeIn(new Date(dayStart + span).toISOString(), locale, tz)}
        </span>
      </div>
      {people.map((p) => {
        const busy = fb.data?.items.find((i) => i.userId === p.id)?.busy ?? [];
        return (
          <div key={p.id} className="flex items-center gap-2">
            <span className="w-28 truncate text-xs font-semibold">{p.name}</span>
            <div className="relative h-4 flex-1 overflow-hidden rounded-sm bg-surface">
              {busy.map((b, i) => (
                <span
                  key={i}
                  className={cn('absolute inset-y-0', b.tentative ? 'bg-fg3/30' : 'bg-fg3/60')}
                  style={{ left: `${pos(b.start)}%`, width: `${pos(b.end) - pos(b.start)}%` }}
                />
              ))}
              {start && end ? (
                <span
                  className="absolute inset-y-0 border-x-2 border-accent bg-accent/25"
                  style={{
                    left: `${pos(start)}%`,
                    width: `${Math.max(1, pos(end) - pos(start))}%`,
                  }}
                />
              ) : null}
            </div>
          </div>
        );
      })}
      <span className={cn('text-xs', conflicts.length ? 'text-danger' : 'text-fg3')}>
        {conflicts.length
          ? t('calendar.editor.conflicts', { names: conflicts.map((p) => p.name).join(', ') })
          : t('calendar.editor.allFree')}
      </span>
    </div>
  );
}
