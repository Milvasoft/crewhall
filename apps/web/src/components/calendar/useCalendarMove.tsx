import { occurrenceKey, type CalendarOccurrence, type SeriesScope } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Radio,
  RadioGroup,
  toast,
} from '@crewhall/ui';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { calendarKeys } from '@/lib/calendar/queries';
import { meetKeys } from '@/lib/meet/queries';
import { movedOccurrence, shiftBy, type MoveTarget } from '@/lib/calendar/drag';
import { dateOf, formatDateOnly, formatTimeIn, instantAt } from '@/lib/calendar/time';
import { SwitchRow, useFail } from './bits';
import { settleOccurrence } from './motion';
import { type KeyStep } from './TimeGrid';

interface MoveRequest {
  o: CalendarOccurrence;
  to: MoveTarget;
  scope: SeriesScope;
  notify: boolean;
}

/** Keyboard moves wait this long after the last key before they are saved. */
export const KEY_MOVE_SETTLE_MS = 700;

/** Board cards are due at the end of the day, like the board's date picker sets them. */
const CARD_DUE_MINUTE = 18 * 60;

/**
 * Moving occurrences (roadmap 14, drag and drop): one path for drops, resizes and Alt + arrows.
 * A series asks which occurrences move, an event with guests whether to tell them; the view
 * changes at once (rolled back with the error if the server refuses), and a toast offers undo.
 */
export function useCalendarMove({ tz, occurrencesKey }: { tz: string; occurrencesKey: QueryKey }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const [ask, setAsk] = useState<{ o: CalendarOccurrence; to: MoveTarget } | null>(null);
  const [pending, setPending] = useState<{ o: CalendarOccurrence; to: MoveTarget } | null>(null);
  const [live, setLive] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refocus = useRef<string | null>(null);

  const day = (date: string) =>
    formatDateOnly(date, locale, { weekday: 'short', day: 'numeric', month: 'short' });
  const when = (x: Pick<CalendarOccurrence, 'allDay' | 'start' | 'end'>) =>
    x.allDay
      ? `${day(x.start)} · ${t('calendar.allDay')}`
      : `${day(dateOf(x.start, tz))} ${formatTimeIn(x.start, locale, tz)}–${formatTimeIn(x.end, locale, tz)}`;

  const send = async ({ o, to, scope, notify }: MoveRequest) => {
    if (o.source === 'meeting') {
      // A one-off meeting (series are not movable here); meet sends the updated invitations.
      await api.call('updateMeeting', {
        params: { meetingId: o.sourceId },
        body: {
          startsAt: to.start,
          durationMinutes: Math.round((Date.parse(to.end) - Date.parse(to.start)) / 60_000),
        },
      });
      return;
    }
    if (o.source === 'card') {
      await api.call('updateBoardCard', {
        params: { cardId: o.sourceId },
        body: { dueAt: instantAt(to.start.slice(0, 10), CARD_DUE_MINUTE, tz).toISOString() },
      });
      return;
    }
    await api.call('updateCalendarEvent', {
      params: { eventId: o.seriesId ?? o.sourceId },
      body: {
        allDay: to.allDay,
        start: to.start,
        end: to.end,
        scope,
        recurrenceId: o.recurrenceId ?? undefined,
        notify,
      },
    });
  };

  /** The request that puts the occurrence back, or null when a move cannot be undone. */
  const undoOf = (r: MoveRequest): MoveRequest | null => {
    const back: MoveTarget = { allDay: r.o.allDay, start: r.o.start, end: r.o.end };
    if (!r.o.recurring || r.scope === 'this') {
      return { ...r, o: movedOccurrence(r.o, r.to), to: back };
    }
    // The whole series moved: move it back from the occurrence's new place.
    if (r.scope === 'all' && r.to.allDay === r.o.allDay) {
      const moved = movedOccurrence(r.o, r.to);
      const key = occurrenceKey(r.to.allDay ? r.to.start : new Date(r.to.start), r.to.allDay);
      return { ...r, o: { ...moved, recurrenceId: key }, to: back };
    }
    return null;
  };

  const mutation = useMutation({
    mutationFn: send,
    onMutate: async (r) => {
      await qc.cancelQueries({ queryKey: occurrencesKey });
      const prev = qc.getQueryData(occurrencesKey);
      qc.setQueryData<{ items: CalendarOccurrence[] }>(occurrencesKey, (d) =>
        d ? { items: d.items.map((x) => (x.key === r.o.key ? movedOccurrence(x, r.to) : x)) } : d,
      );
      settleOccurrence(r.o.key);
      return { prev };
    },
    onError: (e, _r, ctx) => {
      qc.setQueryData(occurrencesKey, ctx?.prev);
      fail(e);
    },
    onSettled: (_d, _e, r) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: calendarKeys.all }),
        r.o.source === 'meeting' ? qc.invalidateQueries({ queryKey: meetKeys.all }) : null,
      ]),
  });

  const commit = (r: MoveRequest, opts: { undo?: boolean } = {}) =>
    mutation.mutate(r, {
      onSuccess: () => {
        const title = r.o.hidden ? t('calendar.busy') : r.o.title;
        if (opts.undo) {
          toast(t('calendar.dnd.undone'));
          return;
        }
        const message = t('calendar.dnd.moved', { title, when: when(r.to) });
        setLive(message);
        const back = undoOf(r);
        toast(
          message,
          back
            ? {
                action: {
                  label: t('calendar.dnd.undo'),
                  onClick: () => commit(back, { undo: true }),
                },
              }
            : undefined,
        );
      },
    });

  /** A drop, resize or settled keyboard move. */
  const onMove = (o: CalendarOccurrence, to: MoveTarget) => {
    if (!o.editable) return;
    const guests = o.source === 'event' && o.attendeeCount > 0;
    if (o.recurring || guests) setAsk({ o, to });
    else commit({ o, to, scope: 'all', notify: true });
  };

  /** Alt + arrows: the view follows each key; the move is saved once the keys stop. */
  const onKeyMove = (shown: CalendarOccurrence, step: KeyStep) => {
    const original = pending && pending.o.key === shown.key ? pending.o : shown;
    const next = shiftBy(shown, step, tz);
    if (!next) return;
    setPending({ o: original, to: next });
    refocus.current = shown.key;
    setLive(t('calendar.dnd.announce', { title: shown.title, when: when(next) }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setPending(null);
      onMove(original, next);
    }, KEY_MOVE_SETTLE_MS);
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // A keyboard move re-renders the chip (maybe in another column): keep the focus on it.
  useLayoutEffect(() => {
    const key = refocus.current;
    if (!key) return;
    const el = document.querySelector<HTMLElement>(`[data-occ="${CSS.escape(key)}"]`);
    if (el && document.activeElement !== el) el.focus();
    // Once saved, the chip stays where it is: stop following it.
    if (!pending) refocus.current = null;
  });

  /** The occurrences as the views draw them, with an unsaved keyboard move applied. */
  const withPending = (items: CalendarOccurrence[]) =>
    pending
      ? items.map((x) => (x.key === pending.o.key ? movedOccurrence(x, pending.to) : x))
      : items;

  const dialog = ask ? (
    <MoveDialog
      o={ask.o}
      when={when(ask.to)}
      onCancel={() => setAsk(null)}
      onMove={(scope, notify) => {
        commit({ ...ask, scope, notify });
        setAsk(null);
      }}
    />
  ) : null;

  const liveRegion = (
    <div aria-live="polite" role="status" className="sr-only" data-testid="calendar-live">
      {live}
    </div>
  );

  return { onMove, onKeyMove, withPending, dialog, liveRegion };
}

/** "Yalnız bu / Bu ve sonrakiler / Tümü" for a series and "Katılımcılara bildir" for guests. */
function MoveDialog({
  o,
  when,
  onCancel,
  onMove,
}: {
  o: CalendarOccurrence;
  when: string;
  onCancel: () => void;
  onMove: (scope: SeriesScope, notify: boolean) => void;
}) {
  const { t } = useI18n();
  const [scope, setScope] = useState<SeriesScope>('this');
  const [notify, setNotify] = useState(true);
  const guests = o.source === 'event' && o.attendeeCount > 0;
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent width={420}>
        <DialogHeader
          title={o.recurring ? t('calendar.scope.editTitle') : t('calendar.dnd.title')}
          description={t('calendar.dnd.to', { when })}
        />
        {o.recurring ? (
          <RadioGroup
            value={scope}
            onValueChange={(v) => setScope(v as SeriesScope)}
            className="flex flex-col gap-3"
            aria-label={t('calendar.scope.editTitle')}
          >
            {(['this', 'following', 'all'] as const).map((s) => (
              <label key={s} className="flex items-center gap-2.5 text-sm font-medium">
                <Radio value={s} aria-label={t(`calendar.scope.${s}`)} />
                {t(`calendar.scope.${s}`)}
              </label>
            ))}
          </RadioGroup>
        ) : null}
        {guests ? (
          <SwitchRow
            label={t('calendar.dnd.notify')}
            hint={t('calendar.dnd.notifyHint')}
            checked={notify}
            onChange={setNotify}
          />
        ) : null}
        <DialogFooter>
          <Button variant="gh" onClick={onCancel}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant="pri" onClick={() => onMove(o.recurring ? scope : 'all', notify)}>
            {t('calendar.dnd.move')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
