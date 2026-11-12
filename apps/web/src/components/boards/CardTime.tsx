import { type BoardCardDetail, type TimeEntry } from '@crewhall/shared';
import {
  Avatar,
  Button,
  cn,
  DatePicker,
  Icon,
  IconButton,
  Input,
  Progress,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '@/lib/api';
import { type BoardActions } from '@/lib/boards/actions';
import {
  cardTimeQuery,
  clock,
  formatMinutes,
  invalidateTime,
  myTimerQuery,
} from '@/lib/boards/time';
import { errorKey } from '@/lib/errors';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNow } from '@/lib/useNow';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Time on a card (kararlar 2026-10-29): estimate against logged time, the caller's timer,
 * entries typed in by hand, and the list of entries (own ones editable, all for managers).
 */
export function CardTime({
  card,
  canEdit,
  actions,
}: {
  card: BoardCardDetail;
  canEdit: boolean;
  actions: BoardActions;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const entries = useQuery(cardTimeQuery(card.id));
  const timer = useQuery(myTimerQuery);
  const running = timer.data?.entry?.cardId === card.id ? timer.data.entry : null;
  const now = useNow(running ? 1000 : undefined);
  const [adding, setAdding] = useState(false);
  const spent = card.spentMinutes ?? 0;
  const estimate = card.estimateMinutes ?? null;

  const run = async (call: () => Promise<unknown>) => {
    try {
      await call();
      invalidateTime(qc, card.id);
    } catch (e) {
      toast(t(errorKey(e)));
    }
  };

  return (
    <section className="flex flex-col gap-2" aria-label={t('boards.time.title')}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[13.5px] font-bold text-fg">{t('boards.time.title')}</h4>
        <span className="text-xs text-fg2 tn">
          {estimate
            ? t('boards.time.of', {
                spent: formatMinutes(spent, t),
                estimate: formatMinutes(estimate, t),
              })
            : t('boards.time.spent', { spent: formatMinutes(spent, t) })}
        </span>
        {canEdit ? (
          <span className="ml-auto flex gap-1.5">
            {running ? (
              <Button
                size="xs"
                variant="inv"
                onClick={() => void run(() => api.call('stopMyBoardTimer'))}
              >
                <Icon name="pause" size={13} />
                <span className="tn">{clock(now - Date.parse(running.startedAt))}</span>
                {t('boards.time.stop')}
              </Button>
            ) : (
              <Button
                size="xs"
                variant="out"
                onClick={() =>
                  void run(() => api.call('startBoardCardTimer', { params: { cardId: card.id } }))
                }
              >
                <Icon name="play" size={13} />
                {t('boards.time.start')}
              </Button>
            )}
            <Button size="xs" variant="out" onClick={() => setAdding((v) => !v)}>
              <Icon name="plus" size={13} />
              {t('boards.time.add')}
            </Button>
          </span>
        ) : null}
      </div>
      {estimate ? (
        <Progress
          value={Math.min(100, (spent / estimate) * 100)}
          className={cn('h-1.5', spent > estimate && '[&>*]:bg-warning')}
          aria-label={t('boards.time.of', {
            spent: formatMinutes(spent, t),
            estimate: formatMinutes(estimate, t),
          })}
        />
      ) : null}
      {canEdit ? (
        <label className="flex items-center gap-2 text-[12.5px] text-fg2">
          {t('boards.time.estimate')}
          <input
            type="number"
            min={0}
            step={0.5}
            defaultValue={estimate !== null ? estimate / 60 : ''}
            key={estimate ?? 'none'}
            aria-label={t('boards.time.estimateHours')}
            onBlur={(e) => {
              const v = e.target.value === '' ? null : Math.round(Number(e.target.value) * 60);
              if (v !== estimate && (v === null || (v >= 0 && v <= 100_000))) {
                void actions.updateCard(card.id, { estimateMinutes: v });
              }
            }}
            className="h-7 w-20 rounded-md bg-bg2 px-2 text-[13px] outline-none tn"
          />
          <span className="text-fg3">{t('boards.time.hoursUnit')}</span>
        </label>
      ) : null}
      {adding ? (
        <AddTime
          onCancel={() => setAdding(false)}
          onAdd={(body) =>
            run(() => api.call('addBoardCardTime', { params: { cardId: card.id }, body })).then(
              () => setAdding(false),
            )
          }
        />
      ) : null}
      {entries.data?.items.length ? (
        <ul className="flex flex-col gap-px">
          {entries.data.items.map((e) => (
            <Entry
              key={e.id}
              entry={e}
              now={now}
              onSave={(body) =>
                run(() => api.call('updateBoardTimeEntry', { params: { entryId: e.id }, body }))
              }
              onDelete={() =>
                run(() => api.call('deleteBoardTimeEntry', { params: { entryId: e.id } }))
              }
            />
          ))}
        </ul>
      ) : entries.data ? (
        <p className="text-[13px] text-fg3">{t('boards.time.empty')}</p>
      ) : null}
    </section>
  );
}

function AddTime({
  onAdd,
  onCancel,
}: {
  onAdd: (body: { minutes: number; note: string; startedAt: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [h, setH] = useState('1');
  const [m, setM] = useState('0');
  const [day, setDay] = useState(today());
  const [note, setNote] = useState('');
  const minutes = (Number(h) || 0) * 60 + (Number(m) || 0);
  const valid = minutes >= 1 && minutes <= 24 * 60;
  return (
    <form
      className="flex flex-wrap items-end gap-2 rounded-lg bg-bg2 p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const [y, mo, d] = day.split('-').map(Number);
        void onAdd({
          minutes,
          note: note.trim(),
          startedAt: new Date(y!, mo! - 1, d!, 12, 0, 0).toISOString(),
        });
      }}
    >
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-fg3">
        {t('boards.time.hours')}
        <Input
          type="number"
          min={0}
          max={24}
          value={h}
          onChange={(e) => setH(e.target.value)}
          className="h-8 w-16"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-fg3">
        {t('boards.time.minutes')}
        <Input
          type="number"
          min={0}
          max={59}
          value={m}
          onChange={(e) => setM(e.target.value)}
          className="h-8 w-16"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11.5px] font-semibold text-fg3">
        {t('boards.time.day')}
        <DatePicker
          size="sm"
          className="h-8 w-[140px]"
          value={day}
          max={today()}
          clearable={false}
          aria-label={t('boards.time.day')}
          onChange={(v) => v && setDay(v)}
        />
      </label>
      <label className="flex min-w-[160px] flex-1 flex-col gap-1 text-[11.5px] font-semibold text-fg3">
        {t('boards.time.note')}
        <Input
          value={note}
          maxLength={500}
          placeholder={t('boards.time.notePlaceholder')}
          onChange={(e) => setNote(e.target.value)}
          className="h-8"
        />
      </label>
      <Button type="button" size="sm" variant="gh" onClick={onCancel}>
        {t('boards.time.cancel')}
      </Button>
      <Button type="submit" size="sm" variant="inv" disabled={!valid}>
        {t('boards.time.save')}
      </Button>
    </form>
  );
}

function Entry({
  entry,
  now,
  onSave,
  onDelete,
}: {
  entry: TimeEntry;
  now: number;
  onSave: (body: { minutes?: number; note?: string }) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [editing, setEditing] = useState(false);
  const [minutes, setMinutes] = useState(String(entry.minutes ?? ''));
  const [note, setNote] = useState(entry.note);
  const running = entry.minutes === null;
  return (
    <li className="flex flex-wrap items-center gap-2.5 rounded-md bg-bg2 px-2.5 py-1.5">
      <Avatar name={entry.user.name} src={entry.user.imageUrl} size="sm" />
      <span className="text-[13px] font-semibold">{entry.user.name.split(' ')[0]}</span>
      <span className="text-[11.5px] text-fg3">
        {formatDate(entry.startedAt, locale, { day: 'numeric', month: 'short' })}
      </span>
      {editing ? (
        <form
          className="flex flex-1 items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(minutes);
            void onSave({
              ...(!running && n >= 1 && n <= 1440 ? { minutes: n } : {}),
              note: note.trim(),
            }).then(() => setEditing(false));
          }}
        >
          {!running ? (
            <Input
              type="number"
              min={1}
              max={1440}
              value={minutes}
              aria-label={t('boards.time.minutes')}
              onChange={(e) => setMinutes(e.target.value)}
              className="h-7 w-20"
            />
          ) : null}
          <Input
            value={note}
            maxLength={500}
            aria-label={t('boards.time.note')}
            onChange={(e) => setNote(e.target.value)}
            className="h-7 min-w-0 flex-1"
          />
          <Button type="submit" size="xs" variant="inv">
            {t('boards.time.save')}
          </Button>
        </form>
      ) : (
        <>
          <span className={cn('text-[12.5px] font-bold tn', running && 'text-accent-fg')}>
            {running ? (
              <span className="rounded-full bg-accent px-1.5 py-0.5">
                {clock(now - Date.parse(entry.startedAt))}
              </span>
            ) : (
              formatMinutes(entry.minutes ?? 0, t)
            )}
          </span>
          {entry.source === 'timer' ? (
            <Icon
              name="clock"
              size={12}
              className="text-fg3"
              aria-label={t('boards.time.fromTimer')}
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg2">{entry.note}</span>
        </>
      )}
      {entry.canEdit && !editing ? (
        <span className="flex gap-0.5">
          <IconButton
            size="xs"
            tone="plain"
            aria-label={t('boards.time.edit')}
            onClick={() => setEditing(true)}
          >
            <Icon name="pencil" size={13} />
          </IconButton>
          <IconButton
            size="xs"
            tone="plain"
            aria-label={t('boards.time.remove')}
            onClick={() => void onDelete()}
          >
            <Icon name="trash" size={13} />
          </IconButton>
        </span>
      ) : null}
    </li>
  );
}

/**
 * The caller's running timer, wherever it runs (board toolbar): the card and the clock,
 * opening the card or stopping it.
 */
export function TimerPill() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const timer = useQuery(myTimerQuery);
  const entry = timer.data?.entry;
  const now = useNow(entry ? 1000 : undefined);
  if (!entry) return null;
  return (
    <span className="flex h-8 items-center gap-1 rounded-full bg-accent pr-1 pl-2.5 text-accent-fg">
      <button
        type="button"
        onClick={() =>
          void navigate({
            to: '/b/$boardId/$cardRef',
            params: { boardId: entry.card.boardId, cardRef: entry.card.key },
          })
        }
        className="flex items-center gap-1.5 text-[12.5px] font-bold"
        title={entry.card.title}
      >
        <Icon name="clock" size={14} />
        <span className="tn">{clock(now - Date.parse(entry.startedAt))}</span>
        <span className="font-mono text-[11px] font-semibold">{entry.card.key}</span>
      </button>
      <IconButton
        size="xs"
        tone="plain"
        className="text-accent-fg"
        aria-label={t('boards.time.stopOn', { key: entry.card.key })}
        onClick={async () => {
          try {
            await api.call('stopMyBoardTimer');
          } catch (e) {
            toast(t(errorKey(e)));
          }
          invalidateTime(qc, entry.cardId);
        }}
      >
        <Icon name="pause" size={14} />
      </IconButton>
    </span>
  );
}
