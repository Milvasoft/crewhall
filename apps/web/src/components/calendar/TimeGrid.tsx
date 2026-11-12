import { addDaysToDate, type CalendarOccurrence } from '@crewhall/shared';
import { cn } from '@crewhall/ui';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useSensor,
  useSensors,
  type ClientRect,
  type DragMoveEvent,
  type DragStartEvent,
  type MeasuringConfiguration,
} from '@dnd-kit/core';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  dropTarget,
  eventPoint,
  movedOccurrence,
  resizeTarget,
  zoneAt,
  type GridGeometry,
  type MoveTarget,
} from '@/lib/calendar/drag';
import {
  dateOf,
  datesOf,
  formatDateOnly,
  formatTimeIn,
  HOUR_PX,
  hhmm,
  instantAt,
  layoutDay,
  minuteOf,
  snap,
} from '@/lib/calendar/time';
import { edgeDirection, SWIPE } from '@/lib/calendar/swipe';
import { chipClass, SourceIcon, useOccurrenceTitle } from './bits';
import { useEdgeStep } from './motion';
import { OccurrenceMenu, SlotMenu } from './OccurrenceMenu';

export type { MoveTarget };

export interface SlotSelection {
  allDay: boolean;
  start: string;
  end: string;
}

/** Alt + arrows on a focused occurrence: 15 minutes up/down, a day left/right. */
export interface KeyStep {
  minutes: number;
  days: number;
}

interface Props {
  dates: string[];
  tz: string;
  items: CalendarOccurrence[];
  today: string;
  now: number;
  workdayStart: number;
  workdayEnd: number;
  onOpen: (o: CalendarOccurrence) => void;
  onCreate: (s: SlotSelection) => void;
  onMove: (o: CalendarOccurrence, to: MoveTarget) => void;
  onKeyMove: (o: CalendarOccurrence, step: KeyStep) => void;
  /** Dragging an event to the left or right edge moves the view a period that way. */
  onEdge?: (dir: -1 | 1) => void;
  /** Right after a period change: the order in which occurrences rise in. */
  enterOrder?: ReadonlyMap<string, number> | null;
}

export interface DragData {
  o: CalendarOccurrence;
  kind: 'move' | 'resize';
  date: string;
}

interface Preview {
  key: string;
  o: CalendarOccurrence;
  target: MoveTarget;
}

const MIN_HEIGHT = 18;

/** Keys that move the focused occurrence (with Alt). */
export function keyStep(e: KeyboardEvent): KeyStep | null {
  if (!e.altKey) return null;
  switch (e.key) {
    case 'ArrowUp':
      return { minutes: -15, days: 0 };
    case 'ArrowDown':
      return { minutes: 15, days: 0 };
    case 'ArrowLeft':
      return { minutes: 0, days: -1 };
    case 'ArrowRight':
      return { minutes: 0, days: 1 };
    default:
      return null;
  }
}

/** Mouse drags after 4 px, touch after a long press (the page scrolls before that). */
export function useCalendarSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 350, tolerance: 8 } }),
  );
}

/**
 * dnd-kit shifts the drag delta when the dragged node moves on screen. Edge auto-scroll swaps
 * the days under a drag (the chip unmounts, an anchor stands in), so the node's first rect is
 * kept for the whole drag: the delta stays the pointer's own. Call `reset` when a drag ends.
 */
export function useSteadyMeasuring() {
  const first = useRef<ClientRect | null>(null);
  const measuring = useMemo<MeasuringConfiguration>(
    () => ({
      draggable: {
        measure: (el) => {
          if (!first.current) {
            const r = el.getBoundingClientRect();
            first.current = {
              top: r.top,
              left: r.left,
              width: r.width,
              height: r.height,
              right: r.right,
              bottom: r.bottom,
            };
          }
          return first.current;
        },
      },
    }),
    [],
  );
  return {
    measuring,
    reset: () => {
      first.current = null;
    },
  };
}

/**
 * Day and week views (roadmap 14): an all-day row and a 24-hour grid. Events move by drag and
 * drop (dnd-kit; 15-minute steps, across days, between the all-day row and the grid), resize from
 * their bottom edge, and move with Alt + arrows; a ghost shows the new time while dragging.
 */
export function TimeGrid({
  dates,
  tz,
  items,
  today,
  now,
  workdayStart,
  workdayEnd,
  onOpen,
  onCreate,
  onMove,
  onKeyMove,
  onEdge,
  enterOrder,
}: Props) {
  const { t, locale } = useI18n();
  const title = useOccurrenceTitle();
  const scroller = useRef<HTMLDivElement>(null);
  const columns = useRef<HTMLDivElement>(null);
  const allDayRow = useRef<HTMLDivElement>(null);
  const sensors = useCalendarSensors();
  const [preview, setPreview] = useState<Preview | null>(null);
  const origin = useRef<{ x: number; y: number; grabMinutes: number } | null>(null);
  // The drag in progress: the view may move a period under it (edge auto-scroll).
  const [dragging, setDragging] = useState<DragData | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const edge = useEdgeStep(onEdge);
  const steady = useSteadyMeasuring();
  // The click that ends a drag must not open the event.
  const justDragged = useRef(false);
  const open = (o: CalendarOccurrence) => {
    if (!justDragged.current) onOpen(o);
  };
  const [select, setSelect] = useState<{
    date: string;
    from: number;
    to: number;
    x: number;
    y: number;
  } | null>(null);
  const selectRef = useRef(select);
  useLayoutEffect(() => {
    selectRef.current = select;
  });
  // The half hour under the last right click on the empty grid (its "new event" menu).
  const [slotMenu, setSlotMenu] = useState<{ date: string; minute: number } | null>(null);
  const slotMinute = (clientY: number) => {
    const r = columns.current?.getBoundingClientRect();
    const m = r ? Math.floor(((clientY - r.top) / HOUR_PX) * 2) * 30 : 0;
    return Math.max(0, Math.min(23 * 60 + 30, m));
  };
  const createAt = (date: string, minute: number) =>
    onCreate({
      allDay: false,
      start: instantAt(date, minute, tz).toISOString(),
      end: instantAt(date, Math.min(minute + 60, 24 * 60), tz).toISOString(),
    });
  const createAllDay = (d: string) =>
    onCreate({ allDay: true, start: d, end: addDaysToDate(d, 1) });

  // Start scrolled to the working day.
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (workdayStart - 1) * HOUR_PX);
  }, [workdayStart]);

  const geometry = (): GridGeometry | null => {
    const cols = columns.current?.getBoundingClientRect();
    const row = allDayRow.current?.getBoundingClientRect();
    if (!cols || !row) return null;
    return {
      dates,
      columns: { left: cols.left, width: cols.width, top: cols.top },
      allDay: { top: row.top, bottom: row.bottom },
    };
  };

  const onDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current as DragData | undefined;
    const p = eventPoint(e.activatorEvent);
    if (!data || !p) return;
    const g = geometry();
    const zone = g ? zoneAt(p.x, p.y, g) : null;
    // Where the event is held: the pointer's minute minus the event's start on that column.
    const grabMinutes =
      zone?.kind === 'timed' && !data.o.allDay
        ? zone.minute -
          (minuteOf(data.o.start, tz) + (dateOf(data.o.start, tz) === data.date ? 0 : -1440))
        : 0;
    origin.current = { x: p.x, y: p.y, grabMinutes };
    pointer.current = p;
    justDragged.current = true;
    setDragging(data);
  };

  /** The preview under the pointer (also after the view moved a period beneath it). */
  const previewAt = (data: DragData, p: { x: number; y: number }) => {
    const from = origin.current;
    if (!from) return;
    let target: MoveTarget | null;
    if (data.kind === 'resize') {
      target = resizeTarget(data.o, ((p.y - from.y) / HOUR_PX) * 60);
    } else {
      const g = geometry();
      const zone = g ? zoneAt(p.x, p.y, g) : null;
      target = zone
        ? dropTarget(data.o, zone, { minutes: from.grabMinutes, date: data.date }, tz)
        : null;
      edge.track(g ? edgeDirection(p.x, g.columns) : 0);
    }
    setPreview(target ? { key: data.o.key, o: data.o, target } : null);
  };

  const onDragMove = (e: DragMoveEvent) => {
    const data = e.active.data.current as DragData | undefined;
    const from = origin.current;
    if (!data || !from) return;
    pointer.current = { x: from.x + e.delta.x, y: from.y + e.delta.y };
    previewAt(data, pointer.current);
  };

  // Edge auto-scroll changed the days: the same pointer now points at another day.
  useLayoutEffect(() => {
    if (dragging && pointer.current) previewAt(dragging, pointer.current);
    // Only when the days change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dates]);

  const finish = () => {
    steady.reset();
    origin.current = null;
    pointer.current = null;
    edge.stop();
    setDragging(null);
    setTimeout(() => {
      justDragged.current = false;
    }, 0);
    const p = preview;
    setPreview(null);
    if (p) onMove(p.o, p.target);
  };

  // Selecting a range on the empty grid creates an event (pointer events; not a drag).
  useEffect(() => {
    if (!select) return;
    const minuteAt = (y: number) => {
      const r = columns.current?.getBoundingClientRect();
      return r ? Math.max(0, Math.min(24 * 60, ((y - r.top) / HOUR_PX) * 60)) : 0;
    };
    const move = (e: PointerEvent) => {
      const s = selectRef.current;
      if (s) setSelect({ ...s, to: snap(minuteAt(e.clientY)) });
    };
    const up = (e: PointerEvent) => {
      const s = selectRef.current;
      setSelect(null);
      if (!s) return;
      // A horizontal touch swipe changes the period (PeriodStage); it creates nothing.
      const dx = Math.abs(e.clientX - s.x);
      if (dx > SWIPE.lockPx * 2 && dx > Math.abs(e.clientY - s.y)) return;
      const a = Math.min(s.from, s.to);
      let b = Math.max(s.from, s.to);
      if (b - a < 15) b = a + 60;
      onCreate({
        allDay: false,
        start: instantAt(s.date, a, tz).toISOString(),
        end: instantAt(s.date, Math.min(b, 24 * 60), tz).toISOString(),
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // Only (re)attach when a selection starts or ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [select === null]);

  const ghost = preview ? movedOccurrence(preview.o, preview.target) : null;

  const byDate = useMemo(() => {
    const map = new Map<string, { item: CalendarOccurrence; top: number; bottom: number }[]>();
    const timed = items.filter((o) => !o.allDay);
    for (const o of timed) {
      const sDate = dateOf(o.start, tz);
      const eDate = dateOf(o.end, tz);
      for (const d of datesOf(o, tz)) {
        if (!dates.includes(d)) continue;
        const top = d === sDate ? minuteOf(o.start, tz) : 0;
        let bottom = d === eDate ? minuteOf(o.end, tz) : 24 * 60;
        if (o.start === o.end) bottom = top + 30;
        if (bottom <= top && d !== eDate) bottom = 24 * 60;
        map.set(d, [...(map.get(d) ?? []), { item: o, top, bottom: Math.max(bottom, top + 15) }]);
      }
    }
    return new Map([...map].map(([d, list]) => [d, layoutDay(list)]));
  }, [items, tz, dates]);

  const ghostByDate = useMemo(() => {
    const map = new Map<string, { top: number; bottom: number }[]>();
    if (!ghost || ghost.allDay) return map;
    const sDate = dateOf(ghost.start, tz);
    const eDate = dateOf(ghost.end, tz);
    for (const d of datesOf(ghost, tz)) {
      if (!dates.includes(d)) continue;
      const top = d === sDate ? minuteOf(ghost.start, tz) : 0;
      const bottom = d === eDate ? minuteOf(ghost.end, tz) : 1440;
      map.set(d, [...(map.get(d) ?? []), { top, bottom: Math.max(bottom, top + 15) }]);
    }
    return map;
  }, [ghost, tz, dates]);

  const allDayItems = items.filter((o) => o.allDay);
  const enter = (o: CalendarOccurrence) => {
    const i = enterOrder?.get(o.key);
    return i === undefined
      ? null
      : { className: 'cal-enter', style: { '--i': i } as React.CSSProperties };
  };
  const nowMinute = minuteOf(new Date(now).toISOString(), tz);
  const weekday = (d: string) => formatDateOnly(d, locale, { weekday: 'short' });
  const dayNum = (d: string) => Number(d.slice(8, 10));
  const gridCols = { gridTemplateColumns: `56px repeat(${dates.length}, minmax(0, 1fr))` };
  const when = (o: CalendarOccurrence) =>
    o.allDay
      ? t('calendar.allDay')
      : `${formatTimeIn(o.start, locale, tz)}–${formatTimeIn(o.end, locale, tz)}`;

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

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={finish}
      onDragCancel={() => {
        steady.reset();
        origin.current = null;
        pointer.current = null;
        justDragged.current = false;
        edge.stop();
        setDragging(null);
        setPreview(null);
      }}
      accessibility={{ restoreFocus: true }}
      measuring={steady.measuring}
    >
      <div className="flex min-h-0 flex-1 flex-col" data-testid="calendar-timegrid">
        <div className="grid shrink-0 border-b border-line pr-[var(--sbw,0px)]" style={gridCols}>
          <div />
          {dates.map((d) => (
            <div key={d} className="flex flex-col items-center gap-0.5 py-2">
              <span className="text-[11px] font-semibold tracking-wide text-fg3 uppercase">
                {weekday(d)}
              </span>
              <span
                className={cn(
                  'flex size-8 items-center justify-center rounded-full text-lg font-bold',
                  d === today && 'bg-accent text-accent-fg',
                )}
                aria-current={d === today ? 'date' : undefined}
              >
                {dayNum(d)}
              </span>
            </div>
          ))}
        </div>
        <div
          ref={allDayRow}
          className="grid shrink-0 border-b border-line"
          style={gridCols}
          data-testid="calendar-allday"
        >
          <div className="flex items-start justify-end py-1.5 pr-2 text-[11px] text-fg3">
            {t('calendar.allDay')}
          </div>
          {dates.map((d) => (
            <SlotMenu
              key={d}
              when={formatDateOnly(d, locale, { day: 'numeric', month: 'short' })}
              onCreate={() => createAllDay(d)}
            >
              <div
                data-date={d}
                className={cn(
                  'flex min-h-9 flex-col gap-0.5 border-l border-line p-0.5',
                  ghost?.allDay && datesOf(ghost, tz).includes(d) && 'bg-accent10',
                )}
                onDoubleClick={() => createAllDay(d)}
              >
                {allDayItems
                  .filter((o) => datesOf(o, tz).includes(d))
                  .map((o) => (
                    <OccurrenceMenu key={`${o.key}:${d}`} o={o}>
                      <Draggable
                        id={`move:${o.key}:${d}`}
                        data={{ o, kind: 'move', date: d }}
                        disabled={!o.editable}
                        className={cn(
                          'flex h-6 min-w-0 items-center gap-1 rounded-sm px-1.5 text-left text-xs font-semibold',
                          chipClass(o),
                          datesOf(o, tz).find((x) => dates.includes(x)) !== d && 'text-transparent',
                          'transition-[opacity,scale] duration-150',
                          preview?.key === o.key && 'scale-[0.98] opacity-40',
                          enter(o)?.className,
                        )}
                        style={enter(o)?.style}
                        occ={o}
                        label={`${title(o)}, ${when(o)}`}
                        onOpen={() => open(o)}
                        onKeyDown={keyDown(o)}
                      >
                        <SourceIcon o={o} />
                        <span className="truncate">{title(o)}</span>
                      </Draggable>
                    </OccurrenceMenu>
                  ))}
                {ghost?.allDay && datesOf(ghost, tz)[0] === d ? (
                  <GhostChip label={`${title(ghost)} · ${t('calendar.allDay')}`} o={ghost} />
                ) : null}
              </div>
            </SlotMenu>
          ))}
        </div>
        <div ref={scroller} className="relative min-h-0 flex-1 touch-pan-y overflow-y-auto">
          <div className="grid" style={gridCols}>
            <div className="relative" style={{ height: 24 * HOUR_PX }}>
              {Array.from({ length: 23 }, (_, h) => (
                <span
                  key={h}
                  className="absolute right-2 -translate-y-1/2 text-[11px] text-fg3 tabular-nums"
                  style={{ top: (h + 1) * HOUR_PX }}
                >
                  {hhmm((h + 1) * 60)}
                </span>
              ))}
            </div>
            <div
              ref={columns}
              data-testid="calendar-columns"
              // A mouse drag here selects a range; swiping the period is for the header rows.
              data-swipe="off"
              className="relative col-span-full col-start-2 grid"
              style={{
                gridTemplateColumns: `repeat(${dates.length}, minmax(0, 1fr))`,
                height: 24 * HOUR_PX,
              }}
            >
              {dates.map((d) => (
                <SlotMenu
                  key={d}
                  when={hhmm(slotMenu?.date === d ? slotMenu.minute : 0)}
                  onCreate={() => {
                    if (slotMenu?.date === d) createAt(d, slotMenu.minute);
                  }}
                  // A selection started by the same press (a touch long-press) creates nothing.
                  onOpenChange={(o) => {
                    if (o) setSelect(null);
                  }}
                >
                  <div
                    data-date={d}
                    className={cn(
                      'relative border-l border-line transition-colors duration-150',
                      ghostByDate.has(d) && 'bg-accent10/40',
                    )}
                    onContextMenu={(e) => {
                      // An event's own menu took this click.
                      if (e.defaultPrevented) return;
                      setSlotMenu({ date: d, minute: slotMinute(e.clientY) });
                    }}
                    onPointerDown={(e) => {
                      if (e.button !== 0 || e.target !== e.currentTarget) return;
                      const r = columns.current?.getBoundingClientRect();
                      const m = r ? Math.floor(((e.clientY - r.top) / HOUR_PX) * 2) * 30 : 0;
                      setSelect({ date: d, from: m, to: m, x: e.clientX, y: e.clientY });
                    }}
                  >
                    {/* Hour lines and the working day's background. */}
                    {Array.from({ length: 24 }, (_, h) => (
                      <div
                        key={h}
                        className={cn(
                          'pointer-events-none absolute inset-x-0 border-t border-line/60',
                          (h < workdayStart || h >= workdayEnd) && 'bg-bg2/50',
                        )}
                        style={{ top: h * HOUR_PX, height: HOUR_PX }}
                      />
                    ))}
                    {select?.date === d ? (
                      <div
                        className="pointer-events-none absolute inset-x-1 rounded-md bg-accent/30 px-1.5 text-[11px] font-semibold"
                        style={{
                          top: (Math.min(select.from, select.to) / 60) * HOUR_PX,
                          height: Math.max(12, (Math.abs(select.to - select.from) / 60) * HOUR_PX),
                        }}
                      >
                        {hhmm(Math.min(select.from, select.to))}–
                        {hhmm(Math.max(select.from, select.to))}
                      </div>
                    ) : null}
                    {(byDate.get(d) ?? []).map((p) => {
                      const o = p.item;
                      const height = Math.max(MIN_HEIGHT, ((p.bottom - p.top) / 60) * HOUR_PX - 2);
                      return (
                        <OccurrenceMenu key={`${o.key}:${d}`} o={o}>
                          <Draggable
                            id={`move:${o.key}:${d}`}
                            data={{ o, kind: 'move', date: d }}
                            disabled={!o.editable}
                            occ={o}
                            label={`${title(o)}, ${when(o)}`}
                            onOpen={() => open(o)}
                            onKeyDown={keyDown(o)}
                            className={cn(
                              'absolute overflow-hidden rounded-md px-1.5 py-0.5 text-xs leading-tight shadow-sm select-none',
                              'bg-surface',
                              chipClass(o),
                              'transition-[opacity,scale] duration-150',
                              preview?.key === o.key && 'scale-[0.98] opacity-40',
                              enter(o)?.className,
                            )}
                            style={{
                              top: (p.top / 60) * HOUR_PX + 1,
                              height,
                              left: `calc(${(p.column / p.columns) * 100}% + 2px)`,
                              width: `calc(${100 / p.columns}% - 4px)`,
                              ...enter(o)?.style,
                            }}
                            footer={
                              o.editable && o.start !== o.end ? (
                                <ResizeHandle o={o} date={d} label={t('calendar.dnd.resize')} />
                              ) : null
                            }
                          >
                            <span className="flex items-center gap-1 font-semibold">
                              <SourceIcon o={o} />
                              <span className="truncate">{title(o)}</span>
                            </span>
                            {height > 30 ? (
                              <span className="block truncate text-[11px] text-fg2">
                                {formatTimeIn(o.start, locale, tz)}
                                {o.end !== o.start ? `–${formatTimeIn(o.end, locale, tz)}` : ''}
                                {o.location ? ` · ${o.location}` : ''}
                              </span>
                            ) : null}
                          </Draggable>
                        </OccurrenceMenu>
                      );
                    })}
                    {(ghostByDate.get(d) ?? []).map((g, i) => (
                      <GhostChip
                        key={i}
                        o={ghost!}
                        label={`${title(ghost!)} · ${when(ghost!)}`}
                        style={{
                          top: 0,
                          translate: `0 ${(g.top / 60) * HOUR_PX + 1}px`,
                          height: Math.max(MIN_HEIGHT, ((g.bottom - g.top) / 60) * HOUR_PX - 2),
                        }}
                        absolute
                      />
                    ))}
                    {d === today ? (
                      <div
                        className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-s5"
                        style={{ top: (nowMinute / 60) * HOUR_PX }}
                        aria-hidden
                      >
                        <span className="absolute -top-[5px] -left-[5px] size-2 rounded-full bg-s5" />
                      </div>
                    ) : null}
                  </div>
                </SlotMenu>
              ))}
            </div>
          </div>
        </div>
      </div>
      {dragging && !dates.includes(dragging.date) ? (
        <DragAnchor id={`${dragging.kind}:${dragging.o.key}:${dragging.date}`} data={dragging} />
      ) : null}
    </DndContext>
  );
}

/**
 * Keeps a drag alive after edge auto-scroll moved its chip out of view: dnd-kit drops a drag
 * whose draggable unmounts, so an invisible one with the same id stands in.
 */
export function DragAnchor({ id, data }: { id: string; data: DragData }) {
  const { setNodeRef } = useDraggable({ id, data });
  return <span ref={setNodeRef} hidden />;
}

/**
 * One occurrence chip: draggable when editable, opens on click, moves with Alt + arrows. It
 * takes a ref and extra props so a context menu trigger (asChild) can wrap it.
 */
export function Draggable({
  id,
  data,
  disabled,
  occ,
  label,
  className,
  style,
  onOpen,
  onKeyDown,
  footer,
  children,
  ref,
  ...rest
}: {
  id: string;
  data: DragData;
  disabled: boolean;
  occ: CalendarOccurrence;
  label: string;
  className?: string;
  style?: React.CSSProperties;
  onOpen: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  footer?: ReactNode;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
} & Omit<HTMLAttributes<HTMLDivElement>, 'id' | 'onClick' | 'onKeyDown' | 'children'>) {
  const { t } = useI18n();
  const { setNodeRef, listeners, isDragging } = useDraggable({ id, data, disabled });
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [setNodeRef, ref],
  );
  return (
    <div
      {...rest}
      ref={setRef}
      role="button"
      tabIndex={0}
      data-occ={occ.key}
      aria-label={label}
      aria-description={occ.editable ? t('calendar.dnd.hint') : undefined}
      {...listeners}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      className={cn(
        className,
        occ.editable ? 'cursor-grab touch-manipulation' : 'cursor-pointer',
        isDragging && 'cursor-grabbing',
      )}
      style={style}
    >
      {children}
      {footer}
    </div>
  );
}

function ResizeHandle({ o, date, label }: { o: CalendarOccurrence; date: string; label: string }) {
  const { setNodeRef, listeners } = useDraggable({
    id: `resize:${o.key}:${date}`,
    data: { o, kind: 'resize', date } satisfies DragData,
  });
  return (
    <span
      ref={setNodeRef}
      aria-label={label}
      {...listeners}
      onClick={(e) => e.stopPropagation()}
      className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize"
    />
  );
}

/** Where the dragged occurrence would land, with its new time. */
function GhostChip({
  o,
  label,
  style,
  absolute,
}: {
  o: CalendarOccurrence;
  label: string;
  style?: React.CSSProperties;
  absolute?: boolean;
}) {
  return (
    <div
      data-testid="calendar-ghost"
      aria-hidden
      className={cn(
        'pointer-events-none z-20 scale-[1.02] overflow-hidden rounded-md border-2 border-dashed px-1.5 py-0.5 text-xs font-semibold shadow-xl',
        'transition-[translate,height] duration-75 ease-out',
        chipClass(o),
        'bg-surface',
        absolute ? 'absolute inset-x-1' : 'flex h-6 items-center',
      )}
      style={style}
    >
      <span className="truncate">{label}</span>
    </div>
  );
}

/** New times of a timed occurrence moved (or resized) by minutes and days, wall-clock in `tz`. */
export function shifted(
  o: CalendarOccurrence,
  kind: 'move' | 'resize',
  deltaMin: number,
  deltaDays: number,
  tz: string,
): { start: string; end: string } {
  const length = Date.parse(o.end) - Date.parse(o.start);
  if (kind === 'resize') {
    const end = Math.max(Date.parse(o.start) + 15 * 60_000, Date.parse(o.end) + deltaMin * 60_000);
    return { start: o.start, end: new Date(end).toISOString() };
  }
  const total = minuteOf(o.start, tz) + deltaMin;
  const date = addDaysToDate(dateOf(o.start, tz), deltaDays + Math.floor(total / 1440));
  const start = instantAt(date, ((total % 1440) + 1440) % 1440, tz);
  return { start: start.toISOString(), end: new Date(start.getTime() + length).toISOString() };
}
