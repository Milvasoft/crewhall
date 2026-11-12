import { addDaysToDate, dateToDay, type CalendarOccurrence } from '@crewhall/shared';
import { dateOf, HOUR_PX, instantAt, minuteOf, moveDates, snap } from './time';

/**
 * Where a dragged (or keyboard-moved) occurrence lands (roadmap 14, drag and drop). Pure
 * functions over the person's calendar zone so the views and the tests share them: a drop in
 * the time grid gives a timed event, a drop in the all-day row an all-day one.
 */

export interface MoveTarget {
  allDay: boolean;
  start: string;
  end: string;
}

export type DropZone =
  { kind: 'timed'; date: string; minute: number } | { kind: 'allday'; date: string };

export interface GridGeometry {
  dates: string[];
  /** The day columns of the time grid (screen coordinates; top is the 00:00 line). */
  columns: { left: number; width: number; top: number };
  /** The all-day row (vertical band). */
  allDay: { top: number; bottom: number };
}

/** A timed event dropped into the all-day row (or the reverse) gets this length. */
export const DROPPED_TIMED_MINUTES = 60;

/** The zone under a screen point, or null outside the grid. */
export function zoneAt(x: number, y: number, g: GridGeometry): DropZone | null {
  const { left, width } = g.columns;
  if (width <= 0 || x < left || x >= left + width) return null;
  const i = Math.min(g.dates.length - 1, Math.floor(((x - left) / width) * g.dates.length));
  const date = g.dates[i]!;
  if (y >= g.allDay.top && y < g.allDay.bottom) return { kind: 'allday', date };
  if (y < g.columns.top) return null;
  const minute = Math.max(0, Math.min(24 * 60 - 15, ((y - g.columns.top) / HOUR_PX) * 60));
  return { kind: 'timed', date, minute };
}

const changed = (o: CalendarOccurrence, t: MoveTarget) =>
  t.allDay !== o.allDay || t.start !== o.start || t.end !== o.end;

/**
 * The new times of `o` dropped on `zone`. `grabMinutes` keeps the point where a timed event was
 * held under the pointer; `grabDate` is the column the drag started in (all-day bars span days).
 * Board cards stay day items, meetings timed. Null when nothing changes.
 */
export function dropTarget(
  o: CalendarOccurrence,
  zone: DropZone,
  grab: { minutes: number; date: string },
  tz: string,
): MoveTarget | null {
  let t: MoveTarget;
  // A meeting has a time: it does not go into the all-day row.
  if (zone.kind === 'allday' && o.source === 'meeting') return null;
  if (zone.kind === 'allday') {
    if (o.allDay) {
      t = {
        allDay: true,
        ...moveDates(o.start, o.end, dateToDay(zone.date) - dateToDay(grab.date)),
      };
    } else {
      t = { allDay: true, start: zone.date, end: addDaysToDate(zone.date, 1) };
    }
  } else if (o.source === 'card') {
    // A due date is a day: dropped in the grid it moves to that day.
    t = { allDay: true, start: zone.date, end: addDaysToDate(zone.date, 1) };
  } else if (o.allDay) {
    const start = instantAt(zone.date, snap(zone.minute), tz);
    t = {
      allDay: false,
      start: start.toISOString(),
      end: new Date(start.getTime() + DROPPED_TIMED_MINUTES * 60_000).toISOString(),
    };
  } else {
    const length = Date.parse(o.end) - Date.parse(o.start);
    const minute = snap(zone.minute - grab.minutes);
    const day = addDaysToDate(zone.date, Math.floor(minute / 1440));
    const start = instantAt(day, ((minute % 1440) + 1440) % 1440, tz);
    t = {
      allDay: false,
      start: start.toISOString(),
      end: new Date(start.getTime() + length).toISOString(),
    };
  }
  return changed(o, t) ? t : null;
}

/** Bottom edge dragged by `deltaMinutes` (15-minute steps, at least 15 minutes long). */
export function resizeTarget(o: CalendarOccurrence, deltaMinutes: number): MoveTarget | null {
  const end = Math.max(
    Date.parse(o.start) + 15 * 60_000,
    Date.parse(o.end) + snap(deltaMinutes) * 60_000,
  );
  const t = { allDay: false, start: o.start, end: new Date(end).toISOString() };
  return changed(o, t) ? t : null;
}

/** Month view and keyboard: whole days, keeping the wall-clock time of timed events. */
export function shiftDays(o: CalendarOccurrence, days: number, tz: string): MoveTarget | null {
  if (!days) return null;
  if (o.allDay) return { allDay: true, ...moveDates(o.start, o.end, days) };
  const length = Date.parse(o.end) - Date.parse(o.start);
  const start = instantAt(addDaysToDate(dateOf(o.start, tz), days), minuteOf(o.start, tz), tz);
  return {
    allDay: false,
    start: start.toISOString(),
    end: new Date(start.getTime() + length).toISOString(),
  };
}

/** Keyboard (Alt + arrows): minutes for timed events (whole days for day items) and days. */
export function shiftBy(
  o: CalendarOccurrence,
  step: { minutes: number; days: number },
  tz: string,
): MoveTarget | null {
  if (o.allDay || !step.minutes) return shiftDays(o, step.days, tz);
  const length = Date.parse(o.end) - Date.parse(o.start);
  const total = minuteOf(o.start, tz) + step.minutes;
  const day = addDaysToDate(dateOf(o.start, tz), step.days + Math.floor(total / 1440));
  const start = instantAt(day, ((total % 1440) + 1440) % 1440, tz);
  return {
    allDay: false,
    start: start.toISOString(),
    end: new Date(start.getTime() + length).toISOString(),
  };
}

/** The occurrence as it would be drawn after the move (previews, optimistic updates). */
export const movedOccurrence = (o: CalendarOccurrence, t: MoveTarget): CalendarOccurrence => ({
  ...o,
  allDay: t.allDay,
  start: t.start,
  end: t.end,
});

/** Screen point of a pointer, mouse or touch event (dnd-kit's activator event). */
export function eventPoint(e: Event | null): { x: number; y: number } | null {
  if (!e) return null;
  const touch = (e as TouchEvent).touches?.[0] ?? (e as TouchEvent).changedTouches?.[0];
  if (touch) return { x: touch.clientX, y: touch.clientY };
  const m = e as MouseEvent;
  return typeof m.clientX === 'number' ? { x: m.clientX, y: m.clientY } : null;
}
