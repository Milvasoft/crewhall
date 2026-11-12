import { type BoardCard, type BoardDetail } from '@crewhall/shared';
import { Button, cn, Icon } from '@crewhall/ui';
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { type BoardActions } from '@/lib/boards/actions';
import { cardRef } from '@/lib/boards/filters';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNow } from '@/lib/useNow';
import { AvatarStack } from './parts';

const DAY = 86_400_000;
/** Width of one day column. */
const W = 32;
const ROW = 36;
const HEAD = 44;
const LABEL = 260;
/** The longest span drawn; cards beyond it sit at the edge. */
const MAX_DAYS = 400;

type Mode = 'move' | 'start' | 'end';
interface Shift {
  start: number;
  end: number;
}

/** The local calendar day of a moment, as a day number (days since 1970-01-01). */
const dayOf = (iso: string | number | Date) => {
  const d = new Date(iso);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;
};
/** Local midnight of a day number. */
const dateOfDay = (day: number) => {
  const u = new Date(day * DAY);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
};

/** Moves a timestamp by whole local days, keeping its time of day. */
function shiftIso(iso: string, days: number) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/** A new date on a day: starts at 09:00, ends at 18:00 local (like the due picker). */
function atDay(day: number, hour: number) {
  const d = dateOfDay(day);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour).toISOString();
}

const without = (s: Record<string, Shift>, id: string) =>
  Object.fromEntries(Object.entries(s).filter(([k]) => k !== id));

interface Bar {
  card: BoardCard;
  start: number;
  end: number;
}

const barOf = (c: BoardCard): Bar | null => {
  const s = c.startAt ?? c.dueAt;
  const e = c.dueAt ?? c.startAt;
  return s && e ? { card: c, start: dayOf(s), end: dayOf(e) } : null;
};

/**
 * Timeline (kararlar 2026-10-29, Gantt): one row per card grouped by column, a bar from the
 * start to the due day. Dragging the bar moves both dates, its edges change one; arrows move
 * a focused bar by a day (Shift: the end, Ctrl: the start). Blocks links are drawn as arrows;
 * a card that starts before its blocker ends turns the warning colour. Undated cards wait in
 * their own list.
 */
export function TimelineView({
  detail,
  visible,
  canEdit,
  actions,
  onOpen,
}: {
  detail: BoardDetail;
  visible: BoardCard[];
  canEdit: boolean;
  actions: BoardActions;
  onOpen: (card: BoardCard) => void;
}) {
  const { t, locale } = useI18n();
  const now = useNow(60_000);
  const today = dayOf(now);
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{
    id: string;
    mode: Mode;
    x: number;
    moved: boolean;
  } | null>(null);
  const [shift, setShift] = useState<Record<string, Shift>>({});
  const key = (c: BoardCard) => cardRef(detail.board.settings.key, c.number);
  const doneCols = useMemo(
    () => new Set(detail.columns.filter((c) => c.isDone).map((c) => c.id)),
    [detail.columns],
  );

  const bars = useMemo(() => {
    const out = new Map<string, Bar>();
    for (const c of visible) {
      const b = barOf(c);
      if (!b) continue;
      const d = shift[c.id];
      out.set(c.id, d ? { ...b, start: b.start + d.start, end: b.end + d.end } : b);
    }
    return out;
  }, [visible, shift]);

  // From the Monday a week before the earliest date to two weeks after the latest.
  const range = useMemo(() => {
    const days = [today, ...[...bars.values()].flatMap((b) => [b.start, b.end])];
    const min = Math.max(Math.min(...days), today - MAX_DAYS / 2);
    const max = Math.min(Math.max(...days), today + MAX_DAYS / 2);
    const weekday = (dateOfDay(min).getDay() + 6) % 7;
    const from = min - weekday - 7;
    const to = Math.max(max + 14, from + 42);
    return { from, count: to - from + 1 };
    // Bars of the drag preview do not move the range.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, today]);

  const groups = detail.columns
    .map((col) => ({ col, cards: visible.filter((c) => c.columnId === col.id && barOf(c)) }))
    .filter((g) => g.cards.length);
  const undated = visible.filter((c) => !barOf(c) && !doneCols.has(c.columnId));

  // Row positions for the arrows: group headers take a row each.
  const rowOf = new Map<string, number>();
  let row = 0;
  for (const g of groups) {
    row++;
    for (const c of g.cards) rowOf.set(c.id, row++);
  }
  const height = row * ROW;
  const x = (day: number) => (day - range.from) * W;

  const blockerEnd = new Map<string, number>();
  for (const dep of detail.dependencies ?? []) {
    const from = bars.get(dep.fromId);
    if (!from || doneCols.has(from.card.columnId)) continue;
    blockerEnd.set(dep.toId, Math.max(blockerEnd.get(dep.toId) ?? -Infinity, from.end));
  }
  const late = (b: Bar) => (blockerEnd.get(b.card.id) ?? -Infinity) >= b.start;

  // Opens on the earliest bar, as long as today stays in view.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const fits = Math.floor((el.clientWidth - LABEL) / W);
    const earliest = Math.min(today, ...[...bars.values()].map((b) => b.start));
    el.scrollLeft = Math.max(0, x(Math.max(earliest - 1, today - fits + 4)));
    // Only when the view opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (card: BoardCard, d: Shift) => {
    const body: { startAt?: string; dueAt?: string } = {};
    // A one-date card that moves keeps one date; stretching it gives it the other.
    const stretch = d.start !== d.end;
    if (card.startAt) {
      if (d.start) body.startAt = shiftIso(card.startAt, d.start);
    } else if (stretch && d.start && card.dueAt) {
      body.startAt = atDay(dayOf(card.dueAt) + d.start, 9);
    }
    if (card.dueAt) {
      if (d.end) body.dueAt = shiftIso(card.dueAt, d.end);
    } else if (stretch && d.end && card.startAt) {
      body.dueAt = atDay(dayOf(card.startAt) + d.end, 18);
    }
    if (Object.keys(body).length) await actions.updateCard(card.id, body);
    setShift((s) => without(s, card.id));
  };

  /** Keeps start ≤ end while a preview grows or shrinks one side. */
  const clamp = (b: Bar, d: Shift): Shift => {
    const base = barOf(b.card)!;
    if (base.start + d.start > base.end + d.end) {
      return d.start !== 0 && d.end === 0
        ? { start: base.end - base.start, end: 0 }
        : { start: d.start, end: base.start - base.end + d.start };
    }
    return d;
  };

  const onPointerDown = (e: PointerEvent, card: BoardCard, mode: Mode) => {
    if (!canEdit || e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: card.id, mode, x: e.clientX, moved: false });
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag) return;
    const days = Math.round((e.clientX - drag.x) / W);
    const b = bars.get(drag.id);
    if (!b) return;
    if (days !== 0 && !drag.moved) setDrag({ ...drag, moved: true });
    const d: Shift =
      drag.mode === 'move'
        ? { start: days, end: days }
        : drag.mode === 'start'
          ? { start: days, end: 0 }
          : { start: 0, end: days };
    setShift((s) => ({ ...s, [drag.id]: clamp(b, d) }));
  };
  const onPointerUp = () => {
    if (!drag) return;
    const card = visible.find((c) => c.id === drag.id);
    const d = shift[drag.id];
    setDrag(null);
    if (!card) return;
    if (!drag.moved || !d || (d.start === 0 && d.end === 0)) {
      setShift((s) => without(s, drag.id));
      if (!drag.moved && drag.mode === 'move') onOpen(card);
      return;
    }
    void save(card, d);
  };

  const onKey = (e: KeyboardEvent, b: Bar) => {
    if (e.key === 'Enter') {
      onOpen(b.card);
      return;
    }
    if (!canEdit || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const d: Shift = e.shiftKey
      ? { start: 0, end: step }
      : e.ctrlKey || e.metaKey
        ? { start: step, end: 0 }
        : { start: step, end: step };
    const next = clamp(barOf(b.card)!, d);
    if (next.start === 0 && next.end === 0) return;
    setShift((s) => ({ ...s, [b.card.id]: next }));
    void save(b.card, next);
  };

  const day = (n: number) => formatDate(dateOfDay(n), locale, { day: 'numeric', month: 'short' });
  const days = Array.from({ length: range.count }, (_, i) => range.from + i);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <p id="timeline-help" className="sr-only">
        {t('boards.timeline.barHint')}
      </p>
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-auto rounded-2xl bg-bg2/50"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="relative" style={{ width: LABEL + range.count * W }}>
          {/* Header: months and days; weekends shaded below. */}
          <div className="sticky top-0 z-40 flex bg-bg" style={{ height: HEAD }}>
            <div
              className="sticky left-0 z-10 shrink-0 border-r border-line bg-bg"
              style={{ width: LABEL }}
            />
            <div className="relative" style={{ width: range.count * W }}>
              {days.map((n) => {
                const d = dateOfDay(n);
                return (
                  <div
                    key={n}
                    className={cn(
                      'absolute top-0 flex h-full flex-col items-center justify-end pb-1 text-[11px] text-fg3',
                      (d.getDay() === 0 || d.getDay() === 6) && 'text-fg3/60',
                      n === today && 'font-bold text-fg',
                    )}
                    style={{ left: x(n), width: W }}
                  >
                    {d.getDate() === 1 || n === range.from ? (
                      <span className="absolute top-1 left-1 text-[11px] font-bold whitespace-nowrap text-fg2">
                        {formatDate(d, locale, { month: 'long', year: 'numeric' })}
                      </span>
                    ) : null}
                    <span className="tn">{d.getDate()}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="relative flex">
            {/* Labels column: above the bars that scroll under it. */}
            <div
              className="sticky left-0 z-30 shrink-0 border-r border-line bg-bg"
              style={{ width: LABEL }}
            >
              {groups.map((g) => (
                <div key={g.col.id}>
                  <div
                    className="flex items-center gap-2 px-3 text-[12.5px] font-bold text-fg2"
                    style={{ height: ROW }}
                  >
                    {g.col.name}
                    <span className="text-fg3 tn">{g.cards.length}</span>
                  </div>
                  {g.cards.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => onOpen(c)}
                      className="flex w-full items-center gap-2 px-3 text-left hover:bg-bg2"
                      style={{ height: ROW }}
                    >
                      <span className="w-[62px] shrink-0 font-mono text-[11px] text-fg3">
                        {key(c)}
                      </span>
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate text-[13px] font-semibold text-fg',
                          doneCols.has(c.columnId) && 'text-fg3',
                        )}
                      >
                        {c.title}
                      </span>
                      <AvatarStack people={c.assignees} />
                    </button>
                  ))}
                </div>
              ))}
            </div>

            {/* Grid, bars and arrows */}
            <div className="relative" style={{ width: range.count * W, height }}>
              {days.map((n) => {
                const d = dateOfDay(n);
                return d.getDay() === 0 || d.getDay() === 6 ? (
                  <div
                    key={n}
                    aria-hidden
                    className="absolute top-0 h-full bg-bg2/70"
                    style={{ left: x(n), width: W }}
                  />
                ) : null;
              })}
              <div
                aria-hidden
                className="absolute top-0 z-10 h-full w-0.5 bg-accent"
                style={{ left: x(today) + W / 2 - 1 }}
              />
              <svg
                aria-hidden
                className="pointer-events-none absolute inset-0 z-10 overflow-visible"
                width={range.count * W}
                height={height}
              >
                <defs>
                  <marker
                    id="tl-arrow"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto"
                  >
                    <path d="M0,0 L8,4 L0,8 z" className="fill-fg3" />
                  </marker>
                  <marker
                    id="tl-arrow-late"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto"
                  >
                    <path d="M0,0 L8,4 L0,8 z" className="fill-warning" />
                  </marker>
                </defs>
                {(detail.dependencies ?? []).map((dep) => {
                  const from = bars.get(dep.fromId);
                  const to = bars.get(dep.toId);
                  const r1 = rowOf.get(dep.fromId);
                  const r2 = rowOf.get(dep.toId);
                  if (!from || !to || r1 === undefined || r2 === undefined) return null;
                  const x1 = x(from.end + 1);
                  const y1 = r1 * ROW + ROW / 2;
                  const x2 = x(to.start);
                  const y2 = r2 * ROW + ROW / 2;
                  const mid = y2 + (y2 > y1 ? -ROW / 2 : ROW / 2);
                  const bad = late(to) && !doneCols.has(from.card.columnId);
                  return (
                    <path
                      key={`${dep.fromId}-${dep.toId}`}
                      d={`M${x1},${y1} h8 V${mid} H${x2 - 10} V${y2} H${x2 - 1}`}
                      fill="none"
                      strokeWidth={1.5}
                      className={bad ? 'stroke-warning' : 'stroke-fg3'}
                      markerEnd={`url(#${bad ? 'tl-arrow-late' : 'tl-arrow'})`}
                    />
                  );
                })}
              </svg>
              {[...bars.values()].map((b) => {
                const r = rowOf.get(b.card.id);
                if (r === undefined) return null;
                const done = doneCols.has(b.card.columnId);
                const warn = late(b) && !done;
                const span = `${day(b.start)} – ${day(b.end)}`;
                return (
                  <div
                    key={b.card.id}
                    role="button"
                    tabIndex={0}
                    aria-label={t('boards.timeline.bar', {
                      key: key(b.card),
                      title: b.card.title,
                      range: span,
                    })}
                    aria-describedby="timeline-help"
                    title={warn ? t('boards.timeline.late') : span}
                    onPointerDown={(e) => onPointerDown(e, b.card, 'move')}
                    onKeyDown={(e) => onKey(e, b)}
                    className={cn(
                      'group/bar absolute z-20 flex items-center overflow-hidden rounded-md px-2 text-[12px] font-semibold whitespace-nowrap outline-none select-none focus-visible:ring-2 focus-visible:ring-fg',
                      done ? 'bg-bg text-fg3' : 'bg-accent text-accent-fg',
                      warn && 'ring-2 ring-warning',
                      canEdit && 'cursor-grab active:cursor-grabbing',
                      drag?.id === b.card.id && 'shadow-overlay',
                    )}
                    style={{
                      left: x(b.start) + 2,
                      width: (b.end - b.start + 1) * W - 4,
                      top: r * ROW + 6,
                      height: ROW - 12,
                    }}
                  >
                    {canEdit ? (
                      <span
                        aria-hidden
                        onPointerDown={(e) => onPointerDown(e, b.card, 'start')}
                        className="absolute inset-y-0 left-0 w-2 cursor-ew-resize opacity-0 group-hover/bar:opacity-100 hover:bg-black/15"
                      />
                    ) : null}
                    <span className="truncate">{b.card.title}</span>
                    {canEdit ? (
                      <span
                        aria-hidden
                        onPointerDown={(e) => onPointerDown(e, b.card, 'end')}
                        className="absolute inset-y-0 right-0 w-2 cursor-ew-resize opacity-0 group-hover/bar:opacity-100 hover:bg-black/15"
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
          {groups.length === 0 ? (
            <p className="sticky left-0 px-4 py-10 text-center text-sm text-fg3">
              {t('boards.timeline.empty')}
            </p>
          ) : null}
        </div>
      </div>

      {undated.length ? (
        <section
          aria-label={t('boards.timeline.undated')}
          className="flex max-h-[30%] shrink-0 flex-col gap-1 overflow-y-auto rounded-2xl bg-bg2/50 p-3"
        >
          <h3 className="flex items-center gap-2 text-[13px] font-bold text-fg">
            {t('boards.timeline.undated')}
            <span className="text-fg3 tn">{undated.length}</span>
            <span className="text-xs font-normal text-fg3">{t('boards.timeline.undatedHint')}</span>
          </h3>
          <ul className="flex flex-col gap-px">
            {undated.map((c) => (
              <li key={c.id} className="flex items-center gap-2.5 rounded-md bg-bg px-2.5 py-1.5">
                <span className="font-mono text-[11.5px] text-fg3">{key(c)}</span>
                <button
                  type="button"
                  onClick={() => onOpen(c)}
                  className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold hover:underline"
                >
                  {c.title}
                </button>
                {canEdit ? (
                  <Button
                    size="xs"
                    variant="gh"
                    onClick={() =>
                      void actions.updateCard(c.id, {
                        startAt: atDay(today, 9),
                        dueAt: atDay(today + 2, 18),
                      })
                    }
                  >
                    <Icon name="calendar" size={13} />
                    {t('boards.timeline.schedule')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
