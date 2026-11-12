import { type Workload, type WorkloadCell } from '@crewhall/shared';
import {
  Avatar,
  Button,
  cn,
  Icon,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
} from '@crewhall/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '@/lib/api';
import { formatMinutes } from '@/lib/boards/time';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';

const WEEKS = 8;
const DAY = 86_400_000;

type Source = { boardId: string } | { spaceId: string };

const isoDay = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Workload (kararlar 2026-10-29): estimated hours of open, assigned cards per person and
 * week against the weekly capacity, for one board or every board of a space. A cell over
 * capacity turns the warning colour; cards without an estimate are counted beside the hours.
 * A cell opens the list of its cards.
 */
export function WorkloadView({ source }: { source: Source }) {
  const { t, locale } = useI18n();
  const [offset, setOffset] = useState(0);
  const [base] = useState(() => Date.now());
  const from = isoDay(base + offset * 7 * DAY);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const query = { from, weeks: WEEKS, tz };
  const q = useQuery({
    queryKey: ['boards', 'workload', source, from],
    queryFn: ({ signal }) =>
      'boardId' in source
        ? api.call('getBoardWorkload', { params: { boardId: source.boardId }, query, signal })
        : api.call('getSpaceBoardWorkload', { params: { spaceId: source.spaceId }, query, signal }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const w = q.data;
  const week = (iso: string) => formatDate(iso, locale, { day: 'numeric', month: 'short' });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <IconButton
          size="sm"
          aria-label={t('boards.workload.previous')}
          onClick={() => setOffset((o) => o - WEEKS)}
        >
          <Icon name="chevL" size={15} />
        </IconButton>
        <Button size="sm" variant="out" disabled={offset === 0} onClick={() => setOffset(0)}>
          {t('boards.workload.thisWeek')}
        </Button>
        <IconButton
          size="sm"
          aria-label={t('boards.workload.next')}
          onClick={() => setOffset((o) => o + WEEKS)}
        >
          <Icon name="chevR" size={15} />
        </IconButton>
        {w ? (
          <span className="text-[13px] font-semibold text-fg2">
            {week(w.weeks[0]!)} –{' '}
            {week(new Date(Date.parse(`${w.weeks.at(-1)!}T12:00:00`) + 6 * DAY).toISOString())}
          </span>
        ) : null}
        {w ? (
          <span className="ml-auto text-xs text-fg3">
            {t('boards.workload.capacity', { hours: w.capacityHours })}
          </span>
        ) : null}
      </div>
      {!w ? (
        <Skeleton className="h-64 w-full" />
      ) : w.people.length === 0 ? (
        <p className="py-10 text-center text-sm text-fg3">{t('boards.workload.empty')}</p>
      ) : (
        <div
          className={cn(
            'min-h-0 flex-1 overflow-auto rounded-2xl bg-bg2/50',
            q.isFetching && 'opacity-70',
          )}
        >
          <table className="w-full min-w-[760px] border-separate border-spacing-0">
            <thead className="sticky top-0 z-10 bg-bg">
              <tr>
                <th className="sticky left-0 z-10 w-[200px] bg-bg px-3 py-2 text-left text-[11.5px] font-bold tracking-wide text-fg3 uppercase">
                  {t('boards.workload.person')}
                </th>
                {w.weeks.map((d) => (
                  <th
                    key={d}
                    scope="col"
                    className="px-1.5 py-2 text-left text-[11.5px] font-bold text-fg3"
                  >
                    {week(d)}
                  </th>
                ))}
                <th scope="col" className="px-1.5 py-2 text-left text-[11.5px] font-bold text-fg3">
                  {t('boards.workload.undated')}
                </th>
              </tr>
            </thead>
            <tbody>
              {w.people.map((p) => (
                <tr key={p.user.id}>
                  <th
                    scope="row"
                    className="sticky left-0 z-[5] border-t border-line bg-bg px-3 py-1.5 text-left"
                  >
                    <span className="flex items-center gap-2">
                      <Avatar name={p.user.name} src={p.user.imageUrl} size="sm" />
                      <span className="truncate text-[13px] font-semibold text-fg">
                        {p.user.name}
                      </span>
                    </span>
                  </th>
                  {p.cells.map((c, i) => (
                    <td key={w.weeks[i]} className="border-t border-line px-1.5 py-1.5">
                      <Cell
                        cell={c}
                        workload={w}
                        label={t('boards.workload.cellLabel', {
                          name: p.user.name,
                          week: week(w.weeks[i]!),
                          hours: c.hours,
                          capacity: w.capacityHours,
                          count: c.cardIds.length,
                        })}
                      />
                    </td>
                  ))}
                  <td className="border-t border-line px-1.5 py-1.5">
                    <Cell
                      cell={p.undated}
                      workload={w}
                      undated
                      label={t('boards.workload.undatedLabel', {
                        name: p.user.name,
                        hours: p.undated.hours,
                        count: p.undated.cardIds.length,
                      })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-fg3">{t('boards.workload.hint')}</p>
    </div>
  );
}

function Cell({
  cell,
  workload,
  label,
  undated,
}: {
  cell: WorkloadCell;
  workload: Workload;
  label: string;
  undated?: boolean;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  if (cell.cardIds.length === 0) return <span className="block px-2 text-fg3">—</span>;
  const over = !undated && cell.hours > workload.capacityHours;
  const fill = undated ? 0 : Math.min(1, cell.hours / workload.capacityHours);
  const cards = workload.cards.filter((c) => cell.cardIds.includes(c.id));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'flex w-full min-w-[84px] flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-bg2',
            over && 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)]',
          )}
        >
          <span className="flex items-baseline gap-1">
            <span className={cn('text-[13px] font-bold tn', over ? 'text-warning' : 'text-fg')}>
              {t('boards.workload.hours', { hours: cell.hours })}
            </span>
            {cell.unestimated ? (
              <span className="text-[11px] text-fg3 tn">
                {t('boards.workload.unestimated', { count: cell.unestimated })}
              </span>
            ) : null}
          </span>
          {!undated ? (
            <span className="h-1 overflow-hidden rounded-full bg-bg">
              <span
                className={cn('block h-full rounded-full', over ? 'bg-warning' : 'bg-accent')}
                style={{ width: `${fill * 100}%` }}
              />
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-[320px] flex-col gap-1 p-2">
        {cards.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() =>
              void navigate({
                to: '/b/$boardId/$cardRef',
                params: { boardId: c.boardId, cardRef: c.key },
              })
            }
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-bg2"
          >
            <span className="font-mono text-[11.5px] text-fg3">{c.key}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{c.title}</span>
            <span className="text-[11.5px] text-fg3 tn">
              {c.estimateMinutes !== null
                ? formatMinutes(c.estimateMinutes, t)
                : t('boards.workload.noEstimate')}
            </span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
