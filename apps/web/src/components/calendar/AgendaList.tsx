import { type CalendarOccurrence } from '@crewhall/shared';
import { cn, EmptyState, Icon } from '@crewhall/ui';
import { useMemo } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { dateOf, datesOf, formatDateOnly, formatTimeIn } from '@/lib/calendar/time';
import { DOT, SourceIcon, useOccurrenceTitle } from './bits';
import { OccurrenceMenu } from './OccurrenceMenu';

/** Agenda view (roadmap 14): the next 30 days as a list grouped by day. */
export function AgendaList({
  dates,
  tz,
  items,
  today,
  onOpen,
}: {
  dates: string[];
  tz: string;
  items: CalendarOccurrence[];
  today: string;
  onOpen: (o: CalendarOccurrence) => void;
}) {
  const { t, locale } = useI18n();
  const title = useOccurrenceTitle();
  const groups = useMemo(() => {
    const map = new Map<string, CalendarOccurrence[]>();
    for (const o of items) {
      for (const d of datesOf(o, tz)) {
        if (dates.includes(d)) map.set(d, [...(map.get(d) ?? []), o]);
      }
    }
    return [...map]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([d, list]) =>
          [
            d,
            list.sort(
              (a, b) => Number(b.allDay) - Number(a.allDay) || (a.start < b.start ? -1 : 1),
            ),
          ] as const,
      );
  }, [items, tz, dates]);

  if (!groups.length) {
    return (
      <EmptyState
        className="m-auto"
        icon="calendar"
        title={t('calendar.agenda.emptyTitle')}
        description={t('calendar.agenda.empty')}
      />
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4 md:px-7"
      data-testid="calendar-agenda"
    >
      {groups.map(([d, list]) => (
        <section key={d} className="flex gap-3 border-b border-line py-3 last:border-b-0 sm:gap-4">
          <div className="flex w-12 shrink-0 flex-col sm:w-24">
            <span className={cn('text-2xl font-bold', d === today && 'text-accent-text')}>
              {Number(d.slice(8, 10))}
            </span>
            <span className="text-xs text-fg3">
              {formatDateOnly(d, locale, { month: 'short', weekday: 'short' })}
            </span>
          </div>
          <ul className="m-0 flex min-w-0 flex-1 list-none flex-col gap-1 p-0">
            {list.map((o) => (
              <li key={`${o.key}:${d}`}>
                <OccurrenceMenu o={o}>
                  <button
                    type="button"
                    onClick={() => onOpen(o)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-bg2 sm:px-2.5',
                      o.myResponse === 'declined' && 'line-through opacity-50',
                    )}
                  >
                    <span className={cn('size-2.5 shrink-0 rounded-full', DOT[o.color])} />
                    {/* Phones: the time sits above the title so the title gets the whole width. */}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
                      <span className="text-xs text-fg2 tabular-nums sm:w-28 sm:shrink-0">
                        {o.allDay
                          ? t('calendar.allDay')
                          : o.start === o.end
                            ? formatTimeIn(o.start, locale, tz)
                            : dateOf(o.start, tz) === d
                              ? `${formatTimeIn(o.start, locale, tz)} – ${formatTimeIn(o.end, locale, tz)}`
                              : t('calendar.continues')}
                      </span>
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        <SourceIcon o={o} />
                        <span className="min-w-0 truncate text-sm font-semibold">{title(o)}</span>
                        {o.location ? (
                          <span className="hidden min-w-0 shrink truncate text-xs text-fg3 sm:inline">
                            · {o.location}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    {o.flag === 'live' ? (
                      <span className="flex items-center gap-1 text-xs font-semibold text-danger">
                        <Icon name="record" size={12} />
                        {t('calendar.live')}
                      </span>
                    ) : null}
                  </button>
                </OccurrenceMenu>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
