import {
  type MeetingAction,
  type MeetingRecording,
  type MeetingTranscript,
} from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api, isApiError } from '@/lib/api';
import { useAiAvailability } from '@/lib/ai/availability';
import { boardsQuery } from '@/lib/boards/api';
import { useI18n } from '@/lib/i18n/I18nContext';

const RUNNING = new Set(['queued', 'transcribing', 'summarizing']);

const transcriptKey = (recordingId: string) => ['ai', 'transcript', recordingId] as const;

/**
 * Toplantı asistanı (yol haritası #12) under a ready recording: transcript, summary, decisions
 * and action items; one click turns an action item into a board card; the notes page opens in
 * Sayfalar. Shown only when AI and a speech server are set up.
 */
export function MeetingAssistant({ recording }: { recording: MeetingRecording }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { visible } = useAiAvailability();
  const state = useQuery({
    queryKey: transcriptKey(recording.id),
    queryFn: ({ signal }) =>
      api.call('getMeetingTranscript', { params: { recordingId: recording.id }, signal }),
    enabled: visible && recording.status === 'ready' && recording.nodeId !== null,
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.transcript && RUNNING.has(q.state.data.transcript.status) ? 4_000 : false,
  });
  const start = useMutation({
    mutationFn: () =>
      api.call('startMeetingTranscript', { params: { recordingId: recording.id }, body: {} }),
    onSuccess: (next) => qc.setQueryData(transcriptKey(recording.id), next),
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });

  const s = state.data;
  if (!visible || !s || (!s.available && !s.transcript)) return null;
  const tr = s.transcript;

  return (
    <section
      aria-label={t('ai.meeting.title')}
      className="flex flex-col gap-3 rounded-2xl bg-surface p-5 shadow-line"
    >
      <header className="flex items-center gap-2">
        <Icon name="sparkle" size={16} className="text-accent-text" />
        <h2 className="m-0 flex-1 text-[15px] font-bold">{t('ai.meeting.title')}</h2>
        {tr?.pageNodeId ? (
          <Button size="xs" variant="out" asChild>
            <Link to="/p/$pageRef" params={{ pageRef: tr.pageNodeId }}>
              <Icon name="page" size={13} /> {t('ai.meeting.openPage')}
            </Link>
          </Button>
        ) : null}
      </header>

      {!tr ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 flex-1 text-sm text-fg2">{t('ai.meeting.intro')}</p>
          <Button size="sm" variant="pri" loading={start.isPending} onClick={() => start.mutate()}>
            {t('ai.meeting.start')}
          </Button>
        </div>
      ) : RUNNING.has(tr.status) ? (
        <p role="status" className="m-0 flex items-center gap-2 text-sm text-fg2">
          <Spinner size={14} /> {t(`ai.meeting.status.${tr.status as 'queued'}`)}
        </p>
      ) : tr.status === 'failed' ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="m-0 flex-1 text-sm text-danger">
            {t(`errors.${(tr.error ?? 'internal') as 'internal'}`)}
          </p>
          {s.available ? (
            <Button
              size="sm"
              variant="out"
              loading={start.isPending}
              onClick={() => start.mutate()}
            >
              {t('ai.preview.retry')}
            </Button>
          ) : null}
        </div>
      ) : (
        <Ready transcript={tr} recording={recording} />
      )}
    </section>
  );
}

function Ready({
  transcript,
  recording,
}: {
  transcript: MeetingTranscript;
  recording: MeetingRecording;
}) {
  const { t } = useI18n();
  const [cardFor, setCardFor] = useState<number | null>(null);
  return (
    <div className="flex flex-col gap-4">
      {transcript.summary ? (
        <div className="text-sm whitespace-pre-wrap">{transcript.summary}</div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <span className="eyebrow">{t('ai.meeting.decisions')}</span>
        {transcript.decisions.length ? (
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm">
            {transcript.decisions.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        ) : (
          <span className="text-xs text-fg2">{t('ai.meeting.none')}</span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="eyebrow">{t('ai.meeting.actions')}</span>
        {transcript.actions.length ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {transcript.actions.map((a, i) => (
              <ActionRow key={i} action={a} onCard={() => setCardFor(i)} />
            ))}
          </ul>
        ) : (
          <span className="text-xs text-fg2">{t('ai.meeting.none')}</span>
        )}
      </div>
      {transcript.text ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-cap font-semibold text-fg2">
            {t('ai.meeting.transcript')}
          </summary>
          <p className="mt-2 max-h-[320px] overflow-y-auto whitespace-pre-wrap text-fg2">
            {transcript.text}
          </p>
        </details>
      ) : null}
      <span className="text-[11px] text-fg3">{t('ai.preview.note')}</span>
      {cardFor !== null && recording.spaceId ? (
        <CardDialog
          transcript={transcript}
          index={cardFor}
          spaceId={recording.spaceId}
          recordingId={recording.id}
          onClose={() => setCardFor(null)}
        />
      ) : null}
    </div>
  );
}

function ActionRow({ action, onCard }: { action: MeetingAction; onCard: () => void }) {
  const { t } = useI18n();
  return (
    <li className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-bg2">
      <Icon name="todo" size={14} className="shrink-0 text-fg2" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm">{action.title}</span>
        {action.owner || action.due ? (
          <span className="text-xs text-fg2">
            {[action.owner, action.due].filter(Boolean).join(' · ')}
          </span>
        ) : null}
      </span>
      {action.cardId && action.boardId ? (
        <Button size="xs" variant="gh" asChild>
          <Link
            to="/b/$boardId/$cardRef"
            params={{ boardId: action.boardId, cardRef: String(action.cardNumber ?? '') }}
          >
            <Icon name="card" size={13} /> {t('ai.meeting.openCard')}
          </Link>
        </Button>
      ) : (
        <Button size="xs" variant="out" onClick={onCard}>
          <Icon name="board" size={13} /> {t('ai.meeting.toCard')}
        </Button>
      )}
    </li>
  );
}

function CardDialog({
  transcript,
  index,
  spaceId,
  recordingId,
  onClose,
}: {
  transcript: MeetingTranscript;
  index: number;
  spaceId: string;
  recordingId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const boards = useQuery(boardsQuery(spaceId));
  const [boardId, setBoardId] = useState<string>('');
  const chosen = boardId || boards.data?.items[0]?.id || '';
  const create = useMutation({
    mutationFn: () =>
      api.call('createMeetingActionCard', {
        params: { transcriptId: transcript.id, index: String(index) },
        body: { boardId: chosen },
      }),
    onSuccess: (next) => {
      qc.setQueryData(transcriptKey(recordingId), (old: { available: boolean } | undefined) => ({
        available: old?.available ?? true,
        transcript: next,
      }));
      toast(t('ai.meeting.cardCreated'));
      onClose();
    },
    onError: (e) => toast(isApiError(e) ? t(`errors.${e.code}`) : t('errors.internal')),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={440}>
        <DialogHeader
          icon="board"
          title={t('ai.meeting.toCard')}
          description={transcript.actions[index]?.title}
        />
        {boards.data?.items.length === 0 ? (
          <p className="m-0 text-sm text-fg2">{t('ai.meeting.noBoards')}</p>
        ) : (
          <Select value={chosen} onValueChange={setBoardId}>
            <SelectTrigger aria-label={t('ai.meeting.board')}>
              <SelectValue placeholder={t('ai.meeting.board')} />
            </SelectTrigger>
            <SelectContent>
              {boards.data?.items.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <DialogFooter>
          <Button variant="gh" size="sm" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="pri"
            size="sm"
            disabled={!chosen}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            {t('ai.meeting.createCard')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
