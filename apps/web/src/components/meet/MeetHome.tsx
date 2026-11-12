import {
  type Meeting,
  type MeetHome as MeetHomeData,
  type MeetingSessionSummary,
} from '@crewhall/shared';
import { Button, cn, EmptyState, Icon, IconButton, Input, Skeleton, Tag } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { formatBytes, formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { meetHistoryQuery, meetHomeQuery, meetingsQuery } from '@/lib/meet/queries';
import { useNow } from '@/lib/useNow';
import { AvatarStack, LiveDot, meetingWhere, Section, useCopyLink, useDuration } from './bits';
import { MeetSidebar } from './MeetSidebar';
import { NewMeetingDialog, type NewMeetingMode } from './NewMeetingDialog';
import { MeetingActions } from './MeetingActions';
import { RoomActions } from './RoomActions';
import { MeetingLink } from './openMeeting';

export type MeetView = 'home' | 'upcoming' | 'recordings' | 'history';

/** Design 7.1 / 19.21: open rooms, today, persistent rooms, history. */
export function MeetHome({ view, open }: { view: MeetView; open?: NewMeetingMode }) {
  const { t, locale } = useI18n();
  const home = useQuery(meetHomeQuery());
  const [dialog, setDialog] = useState<NewMeetingMode | null>(open ?? null);
  const now = useNow(30_000);

  const subtitle = home.data
    ? t('meet.home.subtitle', {
        date: formatDate(new Date(now), locale, { weekday: 'long', day: 'numeric', month: 'long' }),
        active: home.data.live.length,
        count: home.data.today.length,
      })
    : '';

  return (
    <Workspace
      sidebar={<MeetSidebar home={home.data} view={view} />}
      crumbs={[{ label: t('shell.modules.meet') }]}
      tools={
        <>
          {/* Phones: icons only (the label stays for screen readers). */}
          <Button size="sm" variant="out" onClick={() => setDialog('scheduled')}>
            <Icon name="calendar" size={16} />
            <span className="max-sm:sr-only">{t('meet.actions.schedule')}</span>
          </Button>
          <Button size="sm" variant="pri" onClick={() => setDialog('instant')}>
            <Icon name="video" size={16} />
            <span className="max-sm:sr-only">{t('meet.actions.new')}</span>
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-h1 font-bold">
            {view === 'upcoming'
              ? t('meet.nav.upcoming')
              : view === 'recordings'
                ? t('meet.nav.recordings')
                : view === 'history'
                  ? t('meet.history.title')
                  : t('meet.home.title')}
          </h1>
          <p className="text-sm text-fg2">{subtitle}</p>
        </div>
        <JoinByLink />
      </div>

      {view === 'home' ? (
        <HomeBody data={home.data} loading={home.isLoading} now={now} onNew={setDialog} />
      ) : view === 'upcoming' ? (
        <UpcomingList now={now} />
      ) : view === 'history' ? (
        <HistoryTable />
      ) : (
        <HistoryTable recorded />
      )}

      {dialog ? (
        <NewMeetingDialog mode={dialog} onOpenChange={(o) => !o && setDialog(null)} />
      ) : null}
    </Workspace>
  );
}

/** "Oda linki ya da kodu" → /m/<slug>. */
function JoinByLink() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const raw = value.trim();
    if (!raw) return;
    const slug = raw.includes('/m/') ? raw.split('/m/')[1]!.split(/[?#/]/)[0]! : raw;
    void navigate({ to: '/m/$slug', params: { slug: slug.toLowerCase() } });
  };
  return (
    <form onSubmit={submit} className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('meet.home.joinPlaceholder')}
        containerClassName="min-w-0 flex-1 sm:flex-none"
        className="sm:w-[260px]"
        aria-label={t('meet.home.joinPlaceholder')}
      />
      <Button type="submit" size="sm" disabled={!value.trim()}>
        {t('meet.actions.join')}
      </Button>
    </form>
  );
}

function HomeBody({
  data,
  loading,
  now,
  onNew,
}: {
  data: MeetHomeData | undefined;
  loading: boolean;
  now: number;
  onNew: (m: NewMeetingMode) => void;
}) {
  const { t } = useI18n();
  if (loading || !data) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
    );
  }
  const empty = !data.live.length && !data.today.length && !data.rooms.length;
  return (
    <>
      {data.live.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.live.map((m) => (
            <LiveCard key={m.id} m={m} now={now} />
          ))}
        </div>
      ) : null}
      {empty ? (
        <EmptyState
          icon="video"
          title={t('meet.home.emptyTitle')}
          description={t('meet.home.emptyBody')}
        >
          <Button variant="pri" onClick={() => onNew('instant')}>
            {t('meet.actions.startNow')}
          </Button>
        </EmptyState>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
          <Section
            title={t('meet.home.today', { count: data.today.length })}
            aside={t('meet.home.todayCount', { count: data.today.length })}
          >
            {data.today.length ? (
              <ul className="flex flex-col divide-y divide-line">
                {data.today.map((m) => (
                  <ScheduledRow key={m.id} m={m} now={now} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-fg3">{t('meet.home.noToday')}</p>
            )}
          </Section>
          <Section
            title={t('meet.home.rooms')}
            aside={
              <button
                type="button"
                className="font-semibold text-fg2 hover:text-fg"
                onClick={() => onNew('room')}
              >
                {t('meet.actions.newRoom')}
              </button>
            }
          >
            {data.rooms.length ? (
              <ul className="flex flex-col gap-1">
                {data.rooms.map((m) => (
                  <RoomRow key={m.id} m={m} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-fg3">{t('meet.home.noRooms')}</p>
            )}
          </Section>
        </div>
      )}
      <HistoryTable limit={8} />
    </>
  );
}

function LiveCard({ m, now }: { m: Meeting; now: number }) {
  const { t } = useI18n();
  const duration = useDuration();
  const live = m.live!;
  const secs = (now - new Date(live.startedAt).getTime()) / 1000;
  return (
    <article className="flex flex-col gap-3 rounded-2xl bg-surface p-5 shadow-line">
      <div className="flex items-center gap-2 text-xs font-bold tracking-wide text-success uppercase">
        <LiveDot />
        {t('meet.home.liveFor', { time: duration(secs) })}
        {live.recording ? (
          <Tag tone="prod" className="ml-auto">
            {t('meet.room.recording')}
          </Tag>
        ) : m.spaceName ? (
          <Tag className="ml-auto">{m.spaceName}</Tag>
        ) : null}
      </div>
      <div className="flex items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3 className="truncate text-[17px] font-bold">{m.title}</h3>
          <p className="truncate text-sm text-fg2">
            {[
              live.startedBy
                ? t('meet.home.startedBy', { name: live.startedBy.name.split(' ')[0] })
                : null,
              meetingWhere(m, t),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <AvatarStack people={live.participants} />
        <Button size="sm" variant="inv" asChild>
          <MeetingLink slug={m.slug}>
            <Icon name="video" size={16} />
            {t('meet.actions.join')}
          </MeetingLink>
        </Button>
      </div>
    </article>
  );
}

function ScheduledRow({ m, now }: { m: Meeting; now: number }) {
  return (
    <MeetingActions m={m}>
      {(menu) => <ScheduledRowBody m={m} now={now} menu={menu} />}
    </MeetingActions>
  );
}

function ScheduledRowBody({ m, now, menu, ...rest }: { m: Meeting; now: number; menu: ReactNode }) {
  const { t, locale } = useI18n();
  const copy = useCopyLink();
  const starts = m.startsAt ? new Date(m.startsAt).getTime() : now;
  const minutesTo = Math.round((starts - now) / 60_000);
  // Design 7.1: the Join button appears 5 minutes before the start; before that, the link.
  const joinable = minutesTo <= 5 || Boolean(m.live);
  const people = [
    ...(m.host ? [{ name: m.host.name, user: m.host }] : []),
    ...m.invitees.filter((i) => i.user).map((i) => ({ name: i.user!.name, user: i.user })),
  ];
  const guests = m.invitees.filter((i) => i.guest).length;
  return (
    // The right-click menu needs the row's own props (ActionContextMenu's trigger).
    <li {...rest} className="flex items-center gap-4 py-3">
      <div className="flex w-14 shrink-0 flex-col">
        <span className="text-[15px] font-bold">
          {m.startsAt ? formatTime(m.startsAt, locale) : '—'}
        </span>
        <span className="text-xs text-fg3">
          {m.durationMinutes ? t('meet.duration.minutes', { min: m.durationMinutes }) : ''}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 truncate font-semibold">
          {m.title}
          {guests ? <Tag tone="out">{t('meet.home.withGuests')}</Tag> : null}
          {m.settings.autoRecord ? <Tag tone="out">{t('meet.home.autoRecord')}</Tag> : null}
        </span>
        <span className="truncate text-xs text-fg2">
          {[m.spaceName, people.map((p) => p.name.split(' ')[0]).join(', ')]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <AvatarStack people={people} max={3} />
      {joinable ? (
        <Button size="sm" variant="inv" asChild>
          <MeetingLink slug={m.slug}>{t('meet.actions.join')}</MeetingLink>
        </Button>
      ) : (
        <span className="flex items-center gap-1">
          <span className="text-xs whitespace-nowrap text-fg3">
            {minutesTo < 60
              ? t('meet.home.inMinutes', { min: minutesTo })
              : t('meet.home.at', { time: formatTime(new Date(starts), locale) })}
          </span>
          <IconButton
            size="sm"
            tone="plain"
            aria-label={t('meet.actions.copyLink')}
            onClick={() => void copy(m.url)}
          >
            <Icon name="link" size={16} />
          </IconButton>
        </span>
      )}
      {menu}
    </li>
  );
}

function RoomRow({ m }: { m: Meeting }) {
  return <RoomActions m={m}>{(menu) => <RoomRowBody m={m} menu={menu} />}</RoomActions>;
}

function RoomRowBody({ m, menu, ...rest }: { m: Meeting; menu: ReactNode }) {
  const { t } = useI18n();
  const copy = useCopyLink();
  const inside = m.live?.participantCount ?? 0;
  return (
    // The right-click menu needs the row's own props (ActionContextMenu's trigger).
    <li {...rest} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-bg2">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg2 text-sm font-bold">
        {m.title.slice(0, 1).toLocaleUpperCase('tr')}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 truncate text-sm font-semibold">
          {m.live ? <LiveDot /> : null}
          {m.title}
        </span>
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate font-mono text-xs text-fg3">
            {m.url.replace(/^https?:\/\//, '')}
          </span>
          <IconButton
            size="xs"
            tone="plain"
            aria-label={t('meet.actions.copyLink')}
            onClick={() => void copy(m.url)}
          >
            <Icon name="copy" size={12} />
          </IconButton>
        </span>
      </div>
      {inside ? (
        <span className="flex shrink-0 items-center gap-2 text-xs text-fg2">
          <AvatarStack people={m.live!.participants} max={3} />
          <span className="max-sm:hidden">{t('meet.home.inside', { count: inside })}</span>
        </span>
      ) : null}
      <Button size="xs" variant="pri" asChild>
        <MeetingLink slug={m.slug}>
          <Icon name="video" size={14} />
          {t('meet.actions.join')}
        </MeetingLink>
      </Button>
      {menu}
    </li>
  );
}
function UpcomingList({ now }: { now: number }) {
  const { t, locale } = useI18n();
  const q = useQuery(meetingsQuery('upcoming'));
  if (q.isLoading) return <Skeleton className="h-40" />;
  const items = q.data?.items ?? [];
  if (!items.length) {
    return (
      <EmptyState
        icon="calendar"
        title={t('meet.upcoming.empty')}
        description={t('meet.upcoming.emptyBody')}
      />
    );
  }
  const byDay = new Map<string, Meeting[]>();
  for (const m of items) {
    const key = m.startsAt
      ? formatDate(m.startsAt, locale, { weekday: 'long', day: 'numeric', month: 'long' })
      : '';
    byDay.set(key, [...(byDay.get(key) ?? []), m]);
  }
  return (
    <div className="flex flex-col gap-4">
      {[...byDay].map(([day, list]) => (
        <Section key={day} title={day}>
          <ul className="flex flex-col divide-y divide-line">
            {list.map((m) => (
              <ScheduledRow key={m.id} m={m} now={now} />
            ))}
          </ul>
        </Section>
      ))}
    </div>
  );
}

export function HistoryTable({ recorded, limit }: { recorded?: boolean; limit?: number }) {
  const { t, locale } = useI18n();
  const duration = useDuration();
  const q = useQuery(meetHistoryQuery(recorded ? { recorded: true } : {}));
  const items = (q.data?.items ?? []).slice(0, limit);
  // "Kayıtlar" is about the files; the way back belongs to "Geçmiş toplantılar".
  const rejoin = !recorded && items.some((s) => s.rejoinSlug);
  return (
    <Section
      title={recorded ? t('meet.nav.recordings') : t('meet.history.title')}
      aside={
        limit ? (
          <Link
            to="/meetings"
            search={{ view: 'history' }}
            className="font-semibold text-fg2 hover:text-fg"
          >
            {t('meet.history.all')}
          </Link>
        ) : null
      }
    >
      {q.isLoading ? (
        <Skeleton className="h-24" />
      ) : !items.length ? (
        <p className="text-sm text-fg3">
          {recorded ? t('meet.history.noRecordings') : t('meet.history.empty')}
        </p>
      ) : (
        <>
          {/* Phones: one card per meeting instead of a six-column table. */}
          <ul className="flex flex-col divide-y divide-line sm:hidden">
            {items.map((s) => (
              <HistoryCard key={s.id} s={s} duration={duration} locale={locale} rejoin={rejoin} />
            ))}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-fg3">
                <tr className="[&>th]:px-2 [&>th]:py-2 [&>th]:font-semibold">
                  <th>{t('meet.history.meeting')}</th>
                  <th>{t('meet.history.where')}</th>
                  <th>{t('meet.history.date')}</th>
                  <th>{t('meet.history.duration')}</th>
                  <th>{t('meet.history.people')}</th>
                  <th>{t('meet.history.recording')}</th>
                  {rejoin ? <th className="sr-only">{t('meet.history.actions')}</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((s) => (
                  <HistoryRow
                    key={s.id}
                    s={s}
                    duration={duration}
                    locale={locale}
                    rejoin={rejoin}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  );
}

interface HistoryItemProps {
  s: MeetingSessionSummary;
  duration: (s: number) => string;
  locale: ReturnType<typeof useI18n>['locale'];
  /** The table has the "Yeniden katıl" column. */
  rejoin: boolean;
}

/** Shown only for what the server says is open (`rejoinSlug`); joins through the usual room. */
function RejoinButton({ slug }: { slug: string | null | undefined }) {
  const { t } = useI18n();
  if (!slug) return null;
  return (
    <Button size="xs" variant="out" asChild>
      <MeetingLink slug={slug}>
        <Icon name="video" size={14} />
        {t('meet.history.rejoin')}
      </MeetingLink>
    </Button>
  );
}

function HistoryCard({ s, duration, locale, rejoin }: HistoryItemProps) {
  const { t } = useI18n();
  const where = s.spaceName ? s.spaceName : s.kind === 'room' ? t('meet.kind.room') : null;
  return (
    <li className="flex flex-col gap-1.5 py-3">
      <span className="flex items-center justify-between gap-3">
        <Link
          to="/meetings/summary/$sessionId"
          params={{ sessionId: s.id }}
          className="truncate text-sm font-semibold hover:underline"
        >
          {s.title}
        </Link>
        {rejoin ? <RejoinButton slug={s.rejoinSlug} /> : null}
      </span>
      <span className="text-xs text-fg2">
        {[
          where,
          `${formatDate(s.startedAt, locale, { day: 'numeric', month: 'short' })}, ${formatTime(s.startedAt, locale)}`,
          s.durationSeconds !== null ? duration(s.durationSeconds) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      <span className="flex items-center justify-between gap-3 text-xs">
        <AvatarStack people={s.participants} max={5} />
        <RecordingState s={s} locale={locale} />
      </span>
    </li>
  );
}

function RecordingState({ s, locale }: Pick<HistoryItemProps, 's' | 'locale'>) {
  const { t } = useI18n();
  const rec = s.recordings.find((r) => r.status === 'ready') ?? s.recordings[0];
  return (
    <span className={cn('whitespace-nowrap', !rec && 'text-fg3')}>
      {rec?.status === 'ready' && rec.nodeId ? (
        <span className="inline-flex items-center gap-1.5 font-semibold">
          <Icon name="record" size={14} />
          {t('meet.history.recordingSize', {
            size: rec.sizeBytes ? formatBytes(rec.sizeBytes, locale) : '',
          })}
        </span>
      ) : rec?.status === 'processing' ? (
        t('meet.recording.processing')
      ) : rec?.status === 'failed' ? (
        t('meet.recording.failed')
      ) : (
        t('meet.history.notRecorded')
      )}
    </span>
  );
}

function HistoryRow({ s, duration, locale, rejoin }: HistoryItemProps) {
  const { t } = useI18n();
  return (
    <tr className="[&>td]:px-2 [&>td]:py-2.5">
      <td className="font-semibold">
        <Link
          to="/meetings/summary/$sessionId"
          params={{ sessionId: s.id }}
          className="hover:underline"
        >
          {s.title}
        </Link>
      </td>
      <td className="text-fg2">
        {s.spaceName ? s.spaceName : s.kind === 'room' ? t('meet.kind.room') : '—'}
      </td>
      <td className="whitespace-nowrap text-fg2">
        {formatDate(s.startedAt, locale, { day: 'numeric', month: 'short' })},{' '}
        {formatTime(s.startedAt, locale)}
      </td>
      <td className="whitespace-nowrap text-fg2">
        {s.durationSeconds !== null ? duration(s.durationSeconds) : '—'}
      </td>
      <td>
        <AvatarStack people={s.participants} max={5} />
      </td>
      <td>
        <RecordingState s={s} locale={locale} />
      </td>
      {rejoin ? (
        <td className="text-right whitespace-nowrap">
          <RejoinButton slug={s.rejoinSlug} />
        </td>
      ) : null}
    </tr>
  );
}
