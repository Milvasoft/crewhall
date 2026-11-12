import { type MeetingRecording } from '@crewhall/shared';
import { Avatar, Button, EmptyState, Icon, Progress, Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Fragment } from 'react';
import { Link } from '@tanstack/react-router';
import { MeetingAssistant } from '@/components/ai/MeetingAssistant';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import { formatBytes, formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { sessionQuery } from '@/lib/meet/queries';
import { useDuration, useFail } from './bits';
import { MeetingLink } from './openMeeting';

/** Design 7.17 / 13.18: duration, people and their minutes, the recording, the chat. */
export function SessionSummary({ sessionId }: { sessionId: string }) {
  const { t, locale } = useI18n();
  const duration = useDuration();
  const q = useQuery(sessionQuery(sessionId));
  const s = q.data;

  return (
    <Workspace
      crumbs={[
        { label: t('shell.modules.meet') },
        { label: s?.title ?? '' },
        { label: t('meet.summary.crumb') },
      ]}
      tools={
        s ? (
          <>
            {!s.meeting.cancelledAt ? (
              <Button size="sm" variant="out" asChild>
                <MeetingLink slug={s.meeting.slug}>{t('meet.summary.backToRoom')}</MeetingLink>
              </Button>
            ) : null}
            <Button size="sm" asChild>
              <Link to="/meetings">{t('meet.actions.backToMeetings')}</Link>
            </Button>
          </>
        ) : null
      }
    >
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : !s ? (
        <EmptyState
          icon="video"
          title={t('meet.notFound.title')}
          description={t('meet.notFound.body')}
        />
      ) : (
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h1 className="text-h1 font-bold">{t('meet.summary.title', { title: s.title })}</h1>
            <p className="text-sm text-fg2">
              {[
                `${formatDate(s.startedAt, locale, { day: 'numeric', month: 'long' })} ${formatTime(s.startedAt, locale)}${s.endedAt ? ` – ${formatTime(s.endedAt, locale)}` : ''}`,
                s.spaceName,
                s.meeting.host
                  ? t('meet.summary.startedBy', { name: s.meeting.host.name.split(' ')[0] ?? '' })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label={t('meet.summary.duration')}
              value={
                s.durationSeconds !== null ? duration(s.durationSeconds) : t('meet.summary.running')
              }
              hint={
                s.mySeconds ? t('meet.summary.you', { time: duration(s.mySeconds) }) : undefined
              }
            />
            <Stat
              label={t('meet.summary.people')}
              value={String(s.participantCount)}
              hint={t('meet.summary.peak', { n: s.peakParticipants })}
            />
            <Stat
              label={t('meet.summary.recording')}
              value={s.recordings.length ? duration(s.recordings[0]!.durationSeconds ?? 0) : '—'}
              hint={
                s.recordings[0]
                  ? t('meet.summary.recordedAt', {
                      time: formatTime(s.recordings[0].startedAt, locale),
                    })
                  : t('meet.history.notRecorded')
              }
            />
            <Stat
              label={t('meet.summary.chat')}
              value={s.meeting.chatConversationId ? t('meet.summary.inChat') : '—'}
            />
          </div>
          {s.recordings.map((r) => (
            <Fragment key={r.id}>
              <RecordingCard r={r} />
              <MeetingAssistant recording={r} />
            </Fragment>
          ))}
          <section className="flex flex-col gap-2 rounded-2xl bg-surface p-4 shadow-line sm:p-5">
            <h2 className="text-[15px] font-bold">
              {t('meet.summary.peopleTitle', { count: s.people.length })}
            </h2>
            <ul className="grid gap-2 sm:grid-cols-2">
              {s.people.map((p) => (
                <li key={p.identity} className="flex items-center gap-3">
                  <Avatar name={p.name} src={p.user?.imageUrl} size="md" />
                  <span className="flex-1 truncate text-sm font-semibold">{p.name}</span>
                  {p.guest ? <span className="text-xs text-fg3">{t('meet.guest')}</span> : null}
                  {p.seconds ? (
                    <span className="text-xs text-fg2">{duration(p.seconds)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Workspace>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-2xl bg-surface p-4 shadow-line">
      <span className="text-xs text-fg3">{label}</span>
      <span className="text-[20px] font-bold">{value}</span>
      {hint ? <span className="text-xs text-fg2">{hint}</span> : null}
    </div>
  );
}

function RecordingCard({ r }: { r: MeetingRecording }) {
  const { t, locale } = useI18n();
  const fail = useFail();
  const duration = useDuration();
  const open = async () => {
    try {
      const { url } = await api.call('getDownloadUrl', {
        params: { nodeId: r.nodeId! },
        query: { disposition: 'inline' },
      });
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      fail(e);
    }
  };
  return (
    <section className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface p-4 shadow-line sm:flex-nowrap sm:gap-4 sm:p-5">
      <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-bg2">
        <Icon name={r.audioOnly ? 'speaker' : 'film'} size={22} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate font-semibold">{r.fileName ?? t('meet.recording.title')}</span>
        {r.status === 'ready' ? (
          <span className="text-xs text-fg2">
            {[
              r.durationSeconds ? duration(r.durationSeconds) : null,
              r.sizeBytes ? formatBytes(r.sizeBytes, locale) : null,
              t('meet.recording.inDrive'),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ) : r.status === 'failed' ? (
          <span className="text-xs text-danger">{t('meet.recording.failed')}</span>
        ) : (
          <span className="flex items-center gap-2 text-xs text-fg2">
            {t(
              r.status === 'processing' ? 'meet.recording.processing' : 'meet.recording.inProgress',
            )}
            <Progress value={r.status === 'processing' ? 60 : 20} className="w-20 sm:w-32" />
          </span>
        )}
      </div>
      {r.status === 'ready' && r.nodeId ? (
        <Button size="sm" onClick={() => void open()}>
          <Icon name="play" size={14} />
          {t('meet.recording.play')}
        </Button>
      ) : null}
    </section>
  );
}
