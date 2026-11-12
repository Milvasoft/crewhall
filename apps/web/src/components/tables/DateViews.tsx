import { type TableField, type TableRow, type TableView, type ViewConfigInput } from '@crewhall/shared';
import { Button, cn, EmptyState, Icon, IconButton, todayIso, toIsoDate, weekStartOf } from '@crewhall/ui';
import { useState, type DragEvent } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { dayNum, monthGrid, shiftMonth, timelineRange } from '@/lib/tables/dates';
import { ViewFieldSelect } from './CardViews';
import { useTableCtx } from './context';

interface DateViewProps {
  view: TableView;
  rows: TableRow[];
  anchor: string;
  onAnchor: (iso: string) => void;
  onOpenRow: (row: TableRow) => void;
  onUpdateView: (config: ViewConfigInput) => void;
}

const DRAG_TYPE = 'application/x-crewhall-row';
const DATE_TYPES = new Set(['date', 'created_at', 'updated_at']);
const TIMELINE_WEEKS = 6;
const DAY_W = 34;

/** The view's start / end date fields (the first date field when none is chosen). */
function useDateFields(view: TableView) {
  const { table } = useTableCtx();
  const dates = table.fields.filter((f) => DATE_TYPES.has(f.type));
  const start = dates.find((f) => f.id === view.config.dateFieldId) ?? dates[0];
  const end = dates.find((f) => f.id === view.config.endDateFieldId && f.id !== start?.id);
  return { dates, start, end };
}

/** Start and end day of a row (end = start when missing or earlier). */
function span(row: TableRow, start: TableField, end: TableField | undefined) {
  const s = typeof row.values[start.id] === 'string' ? dayNum(row.values[start.id] as string) : null;
  if (s === null) return null;
  const e = end && typeof row.values[end.id] === 'string' ? dayNum(row.values[end.id] as string) : null;
  return { s, e: e !== null && e >= s ? e : s };
}

/** Moves a date value to another day, keeping its time of day. */
function moveDate(value: unknown, day: number) {
  const iso = toIsoDate(day);
  return typeof value === 'string' && value.length > 10 ? `${iso}${value.slice(10)}` : iso;
}

function title(row: TableRow, fields: TableField[], untitled: string) {
  const p = fields.find((f) => f.primary);
  return (p && String(row.values[p.id] ?? '')) || untitled;
}

function Nav({ label, onPrev, onNext, onToday }: { label: string; onPrev: () => void; onNext: () => void; onToday: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1">
      <IconButton size="sm" tone="plain" aria-label={t('tables.views.prev')} onClick={onPrev}>
        <Icon name="chevL" size={16} />
      </IconButton>
      <IconButton size="sm" tone="plain" aria-label={t('tables.views.next')} onClick={onNext}>
        <Icon name="chevR" size={16} />
      </IconButton>
      <span className="min-w-[150px] text-sub font-semibold capitalize">{label}</span>
      <Button size="xs" variant="gh" onClick={onToday}>
        {t('tables.views.today')}
      </Button>
    </div>
  );
}

function DateSettings({ view, onUpdateView, withEnd }: { view: TableView; onUpdateView: (c: ViewConfigInput) => void; withEnd: boolean }) {
  const { t } = useI18n();
  const { canEdit } = useTableCtx();
  const { dates, start, end } = useDateFields(view);
  return (
    <div className="flex flex-wrap gap-3">
      <ViewFieldSelect
        label={t('tables.views.startField')}
        fields={dates}
        value={start?.id ?? null}
        onChange={(id) => canEdit && onUpdateView({ dateFieldId: id })}
      />
      {withEnd ? (
        <ViewFieldSelect
          label={t('tables.views.endField')}
          fields={dates.filter((f) => f.id !== start?.id)}
          value={end?.id ?? null}
          allowNone
          onChange={(id) => canEdit && onUpdateView({ endDateFieldId: id })}
        />
      ) : null}
    </div>
  );
}

/** Calendar: a month grid, rows on their dates; drag to another day, add on a day. */
export function CalendarView({ view, rows, anchor, onAnchor, onOpenRow, onUpdateView }: DateViewProps) {
  const { t, locale } = useI18n();
  const { table, canEdit, updateCell, addRow } = useTableCtx();
  const { start, end } = useDateFields(view);
  const [over, setOver] = useState<number | null>(null);
  if (!start) {
    return <EmptyState className="m-auto" icon="calendar" title={t('tables.views.needDate')} description={t('tables.views.needDateBody')} />;
  }
  const weekStart = weekStartOf(locale);
  const grid = monthGrid(anchor, weekStart);
  const today = dayNum(todayIso()) ?? 0;
  const byDay = new Map<number, TableRow[]>();
  for (const r of rows) {
    const sp = span(r, start, end);
    if (!sp) continue;
    for (let d = Math.max(sp.s, grid.days[0]!); d <= Math.min(sp.e, grid.days[grid.days.length - 1]!); d++) {
      byDay.set(d, [...(byDay.get(d) ?? []), r]);
    }
  }
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const month = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const writable = canEdit && start.type === 'date';
  const drop = (e: DragEvent, day: number) => {
    e.preventDefault();
    setOver(null);
    const row = rows.find((r) => r.id === e.dataTransfer.getData(DRAG_TYPE));
    if (!row) return;
    const sp = span(row, start, end);
    if (!sp || sp.s === day) return;
    void updateCell(row, start.id, moveDate(row.values[start.id], day));
    if (end && row.values[end.id]) void updateCell(row, end.id, moveDate(row.values[end.id], sp.e + day - sp.s));
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Nav
          label={month.format(new Date(grid.first * 86_400_000))}
          onPrev={() => onAnchor(shiftMonth(anchor, -1))}
          onNext={() => onAnchor(shiftMonth(anchor, 1))}
          onToday={() => onAnchor(todayIso())}
        />
        <DateSettings view={view} onUpdateView={onUpdateView} withEnd />
      </div>
      <div className="grid grid-cols-7 overflow-hidden rounded-2xl shadow-[0_0_0_1px_var(--line)]">
        {grid.days.slice(0, 7).map((d) => (
          <div key={`h${d}`} className="border-b border-line bg-bg2 px-2 py-1.5 text-xs font-semibold text-fg2 capitalize">
            {weekday.format(new Date(d * 86_400_000))}
          </div>
        ))}
        {grid.days.map((d) => {
          const items = byDay.get(d) ?? [];
          const inMonth = d >= grid.first && d <= grid.last;
          return (
            <div
              key={d}
              onDragOver={(e) => {
                if (!writable || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                setOver(d);
              }}
              onDragLeave={() => setOver((o) => (o === d ? null : o))}
              onDrop={(e) => drop(e, d)}
              className={cn(
                'group flex min-h-[104px] min-w-0 flex-col gap-1 border-line p-1.5 [&:not(:nth-child(7n))]:border-r [&:nth-last-child(n+8)]:border-b',
                !inMonth && 'bg-bg2/50',
                over === d && 'bg-accent/15',
              )}
            >
              <span className="flex items-center justify-between">
                <span
                  className={cn(
                    'flex size-6 items-center justify-center rounded-full text-xs tabular-nums',
                    inMonth ? 'text-fg' : 'text-fg3',
                    d === today && 'bg-accent font-bold text-accent-fg',
                  )}
                >
                  {new Date(d * 86_400_000).getUTCDate()}
                </span>
                {writable ? (
                  <button
                    type="button"
                    aria-label={t('tables.views.addOn', { date: toIsoDate(d) })}
                    className="flex size-6 items-center justify-center rounded-md text-fg3 opacity-0 group-hover:opacity-100 hover:bg-bg2 hover:text-fg focus-visible:opacity-100"
                    onClick={() => void addRow({ [start.id]: toIsoDate(d) }).then((r) => r && onOpenRow(r))}
                  >
                    <Icon name="plus" size={13} />
                  </button>
                ) : null}
              </span>
              {items.slice(0, 4).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  draggable={writable}
                  onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, r.id)}
                  onClick={() => onOpenRow(r)}
                  className="truncate rounded-md bg-info/15 px-1.5 py-0.5 text-left text-xs font-semibold text-fg hover:bg-info/25"
                >
                  {title(r, table.fields, t('tables.cell.untitled'))}
                </button>
              ))}
              {items.length > 4 ? <span className="px-1.5 text-[11px] text-fg3">{t('tables.views.more', { count: items.length - 4 })}</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Timeline: a bar per row from start to end date over a few weeks. */
export function TimelineView({ view, rows, anchor, onAnchor, onOpenRow, onUpdateView }: DateViewProps) {
  const { t, locale } = useI18n();
  const { table } = useTableCtx();
  const { start, end } = useDateFields(view);
  if (!start) {
    return <EmptyState className="m-auto" icon="calendar" title={t('tables.views.needDate')} description={t('tables.views.needDateBody')} />;
  }
  const range = timelineRange(anchor, weekStartOf(locale), TIMELINE_WEEKS);
  const today = dayNum(todayIso()) ?? 0;
  const items = rows
    .map((r) => ({ r, sp: span(r, start, end) }))
    .filter((x): x is { r: TableRow; sp: { s: number; e: number } } => x.sp !== null)
    .sort((a, b) => a.sp.s - b.sp.s);
  const dayFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', timeZone: 'UTC' });
  const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shift = (weeks: number) => onAnchor(toIsoDate(range.start + weeks * 7));
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Nav
          label={monthFmt.format(new Date(range.start * 86_400_000))}
          onPrev={() => shift(-2)}
          onNext={() => shift(2)}
          onToday={() => onAnchor(todayIso())}
        />
        <DateSettings view={view} onUpdateView={onUpdateView} withEnd />
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-2xl shadow-[0_0_0_1px_var(--line)]">
        <div className="relative" style={{ width: 220 + range.days.length * DAY_W }}>
          <div className="sticky top-0 z-10 flex border-b border-line bg-bg2">
            <div className="sticky left-0 z-10 w-[220px] shrink-0 border-r border-line bg-bg2 px-3 py-1.5 text-xs font-semibold text-fg2">
              {table.fields.find((f) => f.primary)?.name}
            </div>
            {range.days.map((d) => (
              <div
                key={d}
                style={{ width: DAY_W }}
                className={cn('shrink-0 py-1.5 text-center text-[11px] tabular-nums text-fg3', d === today && 'font-bold text-fg')}
              >
                {dayFmt.format(new Date(d * 86_400_000))}
              </div>
            ))}
          </div>
          {items.map(({ r, sp }) => {
            const from = Math.max(sp.s, range.start);
            const to = Math.min(sp.e, range.end);
            return (
              <div key={r.id} className="flex h-9 border-b border-line last:border-b-0">
                <button
                  type="button"
                  onClick={() => onOpenRow(r)}
                  className="sticky left-0 z-[1] w-[220px] shrink-0 truncate border-r border-line bg-surface px-3 text-left text-sm hover:bg-bg2"
                >
                  {title(r, table.fields, t('tables.cell.untitled'))}
                </button>
                <div className="relative flex-1">
                  {today >= range.start && today <= range.end ? (
                    <span className="absolute inset-y-0 w-px bg-accent" style={{ left: (today - range.start) * DAY_W + DAY_W / 2 }} />
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onOpenRow(r)}
                    title={title(r, table.fields, t('tables.cell.untitled'))}
                    style={{ left: (from - range.start) * DAY_W + 2, width: (to - from + 1) * DAY_W - 4 }}
                    className={cn(
                      'absolute top-1.5 h-6 truncate rounded-md bg-info/25 px-2 text-left text-xs font-semibold text-fg hover:bg-info/35',
                      sp.s < range.start && 'rounded-l-none',
                      sp.e > range.end && 'rounded-r-none',
                    )}
                  >
                    {title(r, table.fields, t('tables.cell.untitled'))}
                  </button>
                </div>
              </div>
            );
          })}
          {items.length === 0 ? <p className="px-3 py-8 text-center text-sm text-fg3">{t('tables.views.nothingInRange')}</p> : null}
        </div>
      </div>
    </div>
  );
}
