import { addDaysToDate, dateToDay, type CalendarOccurrence } from '@crewhall/shared';
import { cn } from '@crewhall/ui';
import { DndContext, type DragMoveEvent, type DragStartEvent } from '@dnd-kit/core';
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { eventPoint, shiftDays, type MoveTarget } from '@/lib/calendar/drag';
import { dateOf, datesOf, formatDateOnly, formatTimeIn } from '@/lib/calendar/time';
import { edgeDirection } from '@/lib/calendar/swipe';
import { chipClass, DOT, SourceIcon, useOccurrenceTitle } from './bits';
import { useEdgeStep } from './motion';
import { OccurrenceMenu, SlotMenu } from './OccurrenceMenu';
import {
  DragAnchor,
  Draggable,
  keyStep,
  useCalendarSensors,
  useSteadyMeasuring,
  type KeyStep,
  type SlotSelection,
} from './TimeGrid';

const MAX_CHIPS = 3;

/** The day cell of a 7×6 month grid under a screen point. */
export function monthCellAt(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
  dates: string[],
): string | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const col = Math.floor(((x - rect.left) / rect.width) * 7);
  const row = Math.floor(((y - rect.top) / rect.height) * 6);
  if (col < 0 || col > 6 || row < 0 || row > 5) return null;
  return dates[row * 7 + col] ?? null;
}

/** Month view (roadmap 14): six weeks, chips per day; drag a chip to another day (same time). */
export function MonthGrid({
  dates,
  month,
  tz,
  items,
  today,
  onOpen,
  onCreate,
  onMove,
  onKeyMove,
  onDay,
  onEdge,
  enterOrder,
}: {
  dates: string[];
  /** `YYYY-MM` of the month shown (other days are dimmed). */
  month: string;
  tz: string;
  items: CalendarOccurrence[];
  today: string;
  onOpen: (o: CalendarOccurrence) => void;
  onCreate: (s: SlotSelection) => void;
  onMove: (o: CalendarOccurrence, to: MoveTarget) => void;
  onKeyMove: (o: CalendarOccurrence, step: KeyStep) => void;
  /** "+3 daha" and the day number open the day view. */
  onDay: (date: string) => void;
  /** Dragging a chip to the left or right edge moves to the previous or next month. */
  onEdge?: (dir: -1 | 1) => void;
  /** Right after a period change: the order in which chips rise in. */
  enterOrder?: ReadonlyMap<string, number> | null;
}) {
  const { t, locale } = useI18n();
  const title = useOccurrenceTitle();
  const sensors = useCalendarSensors();
  const grid = useRef<HTMLDivElement>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const edge = useEdgeStep(onEdge);
  const steady = useSteadyMeasuring();
  const justDragged = useRef(false);
  const [drag, setDrag] = useState<{ o: CalendarOccurrence; from: string; over: string } | null>(
    null,
  );

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarOccurrence[]>();
    const sorted = [...items].sort(
      (a, b) => Number(b.allDay) - Number(a.allDay) || (a.start < b.start ? -1 : 1),
    );
    for (const o of sorted) for (const d of datesOf(o, tz)) map.set(d, [...(map.get(d) ?? []), o]);
    return map;
  }, [items, tz]);

  const onDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current as { o: CalendarOccurrence; date: string } | undefined;
    const p = eventPoint(e.activatorEvent);
    if (!data || !p) return;
    origin.current = p;
    pointer.current = p;
    justDragged.current = true;
    setDrag({ o: data.o, from: data.date, over: data.date });
  };

  const overAt = (p: { x: number; y: number }) => {
    const rect = grid.current?.getBoundingClientRect();
    if (!rect || !drag) return;
    const over = monthCellAt(p.x, p.y, rect, dates);
    if (over && over !== drag.over) setDrag({ ...drag, over });
    edge.track(edgeDirection(p.x, rect));
  };

  const onDragMove = (e: DragMoveEvent) => {
    const from = origin.current;
    if (!from) return;
    pointer.current = { x: from.x + e.delta.x, y: from.y + e.delta.y };
    overAt(pointer.current);
  };

  // Edge auto-scroll changed the month: the pointer now points at another day.
  useLayoutEffect(() => {
    if (pointer.current && drag) overAt(pointer.current);
    // Only when the days change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dates]);

  const onDragEnd = () => {
    const d = drag;
    steady.reset();
    origin.current = null;
    pointer.current = null;
    edge.stop();
    setDrag(null);
    setTimeout(() => {
      justDragged.current = false;
    }, 0);
    if (!d || d.over === d.from) return;
    const target = shiftDays(d.o, dateToDay(d.over) - dateToDay(d.from), tz);
    if (target) onMove(d.o, target);
  };

  const keyDown = (o: CalendarOccurrence) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(o);
      return;
    }
    const step = keyStep(e);
    if (step && o.editable) {
      e.preventDefault();
      onKeyMove(o, step);
    }
  };

  const weekdays = dates.slice(0, 7).map((d) => formatDateOnly(d, locale, { weekday: 'short' }));

  return (
    <DndContext
      sensors={sensors}
      measuring={steady.measuring}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        steady.reset();
        origin.current = null;
        pointer.current = null;
        edge.stop();
        justDragged.current = false;
        setDrag(null);
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col" data-testid="calendar-month">
        <div className="grid shrink-0 grid-cols-7 border-b border-line">
          {weekdays.map((w, i) => (
            <span
              key={i}
              className="py-2 text-center text-[11px] font-semibold tracking-wide text-fg3 uppercase"
            >
              {w}
            </span>
          ))}
        </div>
        <div
          ref={grid}
          data-testid="calendar-month-grid"
          className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6"
        >
          {dates.map((d) => {
            const list = byDate.get(d) ?? [];
            const inMonth = d.startsWith(month);
            const over = drag && drag.over !== drag.from && drag.over === d;
            return (
              <SlotMenu
                key={d}
                when={formatDateOnly(d, locale, { day: 'numeric', month: 'short' })}
                onCreate={() => onCreate({ allDay: true, start: d, end: addDaysToDate(d, 1) })}
              >
                <div
                  data-date={d}
                  className={cn(
                    'flex min-h-0 flex-col gap-0.5 overflow-hidden border-r border-b border-line p-1',
                    !inMonth && 'bg-bg2/40',
                    'transition-colors duration-150',
                    over && 'bg-accent10',
                  )}
                  onDoubleClick={(e) => {
                    if (e.target === e.currentTarget) {
                      onCreate({ allDay: true, start: d, end: addDaysToDate(d, 1) });
                    }
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onDay(d)}
                    className={cn(
                      'flex size-6 items-center justify-center self-start rounded-full text-xs font-semibold',
                      !inMonth && 'text-fg3',
                      d === today && 'bg-accent text-accent-fg',
                    )}
                    aria-label={formatDateOnly(d, locale, {
                      day: 'numeric',
                      month: 'long',
                      weekday: 'long',
                    })}
                  >
                    {Number(d.slice(8, 10))}
                  </button>
                  {list.slice(0, MAX_CHIPS).map((o) => (
                    <OccurrenceMenu key={o.key} o={o}>
                      <Draggable
                        id={`month:${o.key}:${d}`}
                        data={{ o, kind: 'move', date: d }}
                        disabled={!o.editable}
                        occ={o}
                        label={title(o)}
                        onOpen={() => {
                          if (!justDragged.current) onOpen(o);
                        }}
                        onKeyDown={keyDown(o)}
                        className={cn(
                          'flex h-5 min-w-0 shrink-0 items-center gap-1 rounded-sm px-1 text-left text-[11.5px]',
                          o.allDay ? cn('font-semibold', chipClass(o)) : 'hover:bg-bg2',
                          'transition-[opacity,scale] duration-150',
                          drag?.o.key === o.key &&
                            drag.over !== drag.from &&
                            'scale-[0.98] opacity-40',
                          enterOrder?.has(o.key) && 'cal-enter',
                        )}
                        style={
                          enterOrder?.has(o.key)
                            ? ({ '--i': enterOrder.get(o.key) } as React.CSSProperties)
                            : undefined
                        }
                      >
                        {o.allDay ? null : (
                          <span className={cn('size-1.5 shrink-0 rounded-full', DOT[o.color])} />
                        )}
                        <SourceIcon o={o} size={11} />
                        {!o.allDay && dateOf(o.start, tz) === d ? (
                          <span className="shrink-0 text-fg3 tabular-nums">
                            {formatTimeIn(o.start, locale, tz)}
                          </span>
                        ) : null}
                        <span className="truncate">{title(o)}</span>
                      </Draggable>
                    </OccurrenceMenu>
                  ))}
                  {over && drag ? (
                    <div
                      data-testid="calendar-ghost"
                      aria-hidden
                      className={cn(
                        'pointer-events-none flex h-5 scale-[1.03] items-center rounded-sm border-2 border-dashed px-1 text-[11.5px] font-semibold shadow-lg',
                        chipClass(drag.o),
                      )}
                    >
                      <span className="truncate">{title(drag.o)}</span>
                    </div>
                  ) : null}
                  {list.length > MAX_CHIPS ? (
                    <button
                      type="button"
                      onClick={() => onDay(d)}
                      className="self-start px-1 text-[11px] font-semibold text-fg2 hover:text-fg"
                    >
                      {t('calendar.more', { count: list.length - MAX_CHIPS })}
                    </button>
                  ) : null}
                </div>
              </SlotMenu>
            );
          })}
        </div>
      </div>
      {drag && !dates.includes(drag.from) ? (
        <DragAnchor
          id={`month:${drag.o.key}:${drag.from}`}
          data={{ o: drag.o, kind: 'move', date: drag.from }}
        />
      ) : null}
    </DndContext>
  );
}
