import { type BoardDetail, type Sprint } from '@crewhall/shared';
import {
  Button,
  cn,
  DatePicker,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  toast,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { type BoardActions } from '@/lib/boards/actions';
import { burndownQuery } from '@/lib/boards/api';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNow } from '@/lib/useNow';
import { Burndown } from './Burndown';

const DAY = 86_400_000;
const isoDay = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const activeSprintOf = (d: BoardDetail) => d.sprints?.find((s) => s.status === 'active');

/** Points while the board has them, else the number of cards (the server's burndown unit). */
export const sprintWeight = (d: BoardDetail, c: { points: number | null }) =>
  d.board.settings.fields.points ? (c.points ?? 0) : 1;

/**
 * New or edited sprint (kararlar 2026-10-29): name, goal and dates. A new one follows the
 * last open sprint with the same length, two weeks by default.
 */
export function SprintDialog({
  detail,
  sprint,
  actions,
  onClose,
}: {
  detail: BoardDetail;
  sprint?: Sprint;
  actions: BoardActions;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(
    sprint?.name ?? t('boards.sprints.nextName', { n: (detail.sprints?.length ?? 0) + 1 }),
  );
  const [goal, setGoal] = useState(sprint?.goal ?? '');
  const [start] = useState(() => {
    const last = detail.sprints?.at(-1);
    return last ? Date.parse(`${last.endsOn}T12:00:00`) + DAY : Date.now();
  });
  const [startsOn, setStartsOn] = useState(sprint?.startsOn ?? isoDay(start));
  const [endsOn, setEndsOn] = useState(sprint?.endsOn ?? isoDay(start + 13 * DAY));
  const [busy, setBusy] = useState(false);
  const valid = name.trim() !== '' && endsOn >= startsOn;

  const save = async () => {
    setBusy(true);
    const body = { name: name.trim(), goal: goal.trim(), startsOn, endsOn };
    const out = await actions.sprint(() =>
      sprint
        ? api.call('updateBoardSprint', { params: { sprintId: sprint.id }, body })
        : api.call('createBoardSprint', { params: { boardId: detail.board.id }, body }),
    );
    setBusy(false);
    if (out) onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={480}>
        <DialogHeader
          icon="flag"
          title={sprint ? t('boards.sprints.edit') : t('boards.sprints.new')}
        />
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy) void save();
          }}
        >
          <Field label={t('boards.sprints.name')}>
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('boards.sprints.goal')}>
            <Textarea
              value={goal}
              maxLength={500}
              rows={2}
              placeholder={t('boards.sprints.goalPlaceholder')}
              onChange={(e) => setGoal(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('boards.sprints.startsOn')}>
              <DatePicker
                value={startsOn}
                clearable={false}
                aria-label={t('boards.sprints.startsOn')}
                onChange={(v) => v && setStartsOn(v)}
              />
            </Field>
            <Field label={t('boards.sprints.endsOn')}>
              <DatePicker
                value={endsOn}
                min={startsOn}
                clearable={false}
                aria-label={t('boards.sprints.endsOn')}
                onChange={(v) => v && setEndsOn(v)}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="gh" onClick={onClose}>
              {t('boards.sprints.cancel')}
            </Button>
            <Button type="submit" variant="inv" disabled={!valid || busy}>
              {sprint ? t('boards.sprints.save') : t('boards.sprints.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Closing the running sprint: its result, and where the unfinished cards go. */
export function CloseSprintDialog({
  detail,
  sprint,
  actions,
  onClose,
}: {
  detail: BoardDetail;
  sprint: Sprint;
  actions: BoardActions;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const planned = (detail.sprints ?? []).filter((s) => s.status === 'planned');
  const [target, setTarget] = useState(planned[0]?.id ?? 'backlog');
  const [busy, setBusy] = useState(false);
  const cards = detail.cards.filter((c) => c.sprintId === sprint.id);
  const open = cards.filter((c) => !c.doneAt);
  const unit = detail.board.settings.fields.points ? 'points' : 'cards';
  const sum = (list: typeof cards) => list.reduce((n, c) => n + sprintWeight(detail, c), 0);
  const total = sum(cards);

  const close = async () => {
    setBusy(true);
    const out = await actions.sprint(() =>
      api.call('closeBoardSprint', {
        params: { sprintId: sprint.id },
        body: { moveTo: target === 'backlog' ? null : target },
      }),
    );
    setBusy(false);
    if (out) {
      toast(t('boards.sprints.closed', { name: sprint.name, count: out.moved }));
      onClose();
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={460}>
        <DialogHeader
          icon="flag"
          title={t('boards.sprints.closeTitle', { name: sprint.name })}
          description={t('boards.sprints.closeResult', {
            done: t(`boards.sprints.units.${unit}`, { count: total - sum(open) }),
            total: t(`boards.sprints.units.${unit}`, { count: total }),
          })}
        />
        <p className="text-sm text-fg2">{t('boards.sprints.closeOpen', { count: open.length })}</p>
        {open.length ? (
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger aria-label={t('boards.sprints.moveTo')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {planned.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
              <SelectItem value="backlog">{t('boards.sprints.toBacklog')}</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('boards.sprints.cancel')}
          </Button>
          <Button variant="inv" disabled={busy} onClick={() => void close()}>
            {t('boards.sprints.closeConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Loads when shown (popover, backlog header) and follows board changes. */
export function BurndownPanel({ sprintId }: { sprintId: string }) {
  const q = useQuery(burndownQuery(sprintId));
  return q.data ? (
    <Burndown data={q.data} />
  ) : (
    <div className="h-[150px] animate-pulse rounded-md bg-bg2" />
  );
}

/**
 * Sprint band (design 6.9): the running sprint's name, goal, dates, working days left and
 * progress, with its burndown a click away and closing for board managers.
 */
export function SprintBand({
  detail,
  canManage,
  actions,
}: {
  detail: BoardDetail;
  canManage: boolean;
  actions: BoardActions;
}) {
  const { t, locale } = useI18n();
  const now = useNow(60_000);
  const [closing, setClosing] = useState(false);
  const active = activeSprintOf(detail);
  const sprint = active ?? detail.board.settings.sprint;
  if (!sprint) return null;
  const end = new Date(`${sprint.endsOn}T23:59:59`);
  let days = 0;
  for (let d = new Date(now); d <= end; d = new Date(d.getTime() + DAY)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) days++;
  }
  // Cards from servers before sprints carry no sprint id: the band covers the whole board.
  const cards = detail.cards.filter(
    (c) => !active || c.sprintId === undefined || c.sprintId === active.id,
  );
  const doneCols = new Set(detail.columns.filter((c) => c.isDone).map((c) => c.id));
  const total = cards.reduce((s, c) => s + (c.points ?? 0), 0);
  const done = cards
    .filter((c) => doneCols.has(c.columnId))
    .reduce((s, c) => s + (c.points ?? 0), 0);
  const ended = end.getTime() < now;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-2xl bg-bg2/70 px-4 py-2.5">
      <span className="text-[13.5px] font-bold text-fg">{sprint.name}</span>
      <span className="text-xs text-fg2">
        {t('boards.sprint.range', {
          start: formatDate(sprint.startsOn, locale, { day: 'numeric', month: 'short' }),
          end: formatDate(sprint.endsOn, locale, { day: 'numeric', month: 'short' }),
        })}
        {' · '}
        <span className={cn(ended && 'text-danger')}>
          {ended
            ? t('boards.sprint.ended')
            : t('boards.sprint.daysLeft', { days: Math.max(0, days - 1) })}
        </span>
      </span>
      {active?.goal ? (
        <span className="min-w-0 truncate text-xs text-fg3" title={active.goal}>
          {active.goal}
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-2">
        {total ? (
          <>
            <span className="text-xs font-semibold text-fg2 tn">
              {t('boards.sprint.points', { done, total })}
            </span>
            <Progress value={(done / total) * 100} className="w-40" />
            <span className="text-xs font-bold text-fg tn">
              %{Math.round((done / total) * 100)}
            </span>
          </>
        ) : null}
        {active ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button size="xs" variant="gh">
                <Icon name="activity" size={14} />
                {t('boards.sprints.showBurndown')}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[360px] p-3">
              <BurndownPanel sprintId={active.id} />
            </PopoverContent>
          </Popover>
        ) : null}
        {active && canManage ? (
          <Button size="xs" variant="out" onClick={() => setClosing(true)}>
            {t('boards.sprints.close')}
          </Button>
        ) : null}
      </span>
      {closing && active ? (
        <CloseSprintDialog
          detail={detail}
          sprint={active}
          actions={actions}
          onClose={() => setClosing(false)}
        />
      ) : null}
    </div>
  );
}
