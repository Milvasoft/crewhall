import {
  paths,
  type CalendarEvent,
  type CalendarOccurrence,
  type SeriesScope,
} from '@crewhall/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { ActionContextMenu, type ActionEntry } from '@/components/common/ActionMenu';
import { useOpenMeeting } from '@/components/meet/openMeeting';
import { api } from '@/lib/api';
import { calendarKeys, eventQuery } from '@/lib/calendar/queries';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useFail } from './bits';
import { ScopeDialog } from './ScopeDialog';

/** What an occurrence's right-click menu does; the calendar page provides it to its views. */
export interface OccurrenceMenuActions {
  open: (o: CalendarOccurrence) => void;
  edit: (e: CalendarEvent) => void;
  remove: (o: CalendarOccurrence) => void;
}

const OccurrenceMenuContext = createContext<OccurrenceMenuActions | null>(null);

export const OccurrenceMenuProvider = OccurrenceMenuContext.Provider;

/** The event behind an occurrence (a series' occurrence is read through its series). */
const eventIdOf = (o: CalendarOccurrence) => o.seriesId ?? o.sourceId;

/** The slug of a Crewhall meeting room link (`paths.meetingRoom`), if the url is one. */
function meetingSlugOf(url: string | null): string | null {
  const prefix = paths.meetingRoom('');
  if (!url?.startsWith(prefix)) return null;
  const slug = url.slice(prefix.length).split(/[/?#]/)[0];
  return slug ? decodeURIComponent(slug) : null;
}

/**
 * Right-click menu of an occurrence chip or row: open, edit, join its meeting, open its card
 * and delete. The event is read when the menu opens (for its meeting or external join link);
 * without a provider the chip is left as it is.
 */
export function OccurrenceMenu({ o, children }: { o: CalendarOccurrence; children: ReactNode }) {
  const { t } = useI18n();
  const actions = useContext(OccurrenceMenuContext);
  const navigate = useNavigate();
  const openMeeting = useOpenMeeting();
  const qc = useQueryClient();
  const fail = useFail();
  const [open, setOpen] = useState(false);
  const isEvent = o.source === 'event' && !o.hidden;
  const ev = useQuery({
    ...eventQuery(eventIdOf(o), o.recurrenceId),
    enabled: open && isEvent,
  });
  if (!actions) return <>{children}</>;

  const e = ev.data;
  const slug = meetingSlugOf(o.url) ?? e?.meeting?.slug ?? null;
  const externalJoin = e?.external?.joinUrl ?? null;
  const entries: ActionEntry[] = [
    {
      kind: 'item',
      key: 'open',
      icon: 'eye',
      label: t('calendar.menu.open'),
      onSelect: () => actions.open(o),
    },
  ];
  if (slug || externalJoin) {
    entries.push({
      kind: 'item',
      key: 'join',
      icon: 'video',
      label: t('calendar.menu.join'),
      onSelect: () => {
        if (slug) openMeeting(slug);
        else if (externalJoin) window.open(externalJoin, '_blank', 'noopener,noreferrer');
      },
    });
  }
  if (o.source === 'card' && o.url) {
    const url = o.url;
    entries.push({
      kind: 'item',
      key: 'card',
      icon: 'board',
      label: t('calendar.panel.openCard'),
      onSelect: () => void navigate({ to: url }),
    });
  }
  if (isEvent && o.editable) {
    entries.push(
      {
        kind: 'item',
        key: 'edit',
        icon: 'edit',
        label: t('calendar.actions.edit'),
        onSelect: () =>
          void qc
            .fetchQuery(eventQuery(eventIdOf(o), o.recurrenceId))
            .then(actions.edit)
            .catch(fail),
      },
      { kind: 'sep', key: 'sep' },
      {
        kind: 'item',
        key: 'delete',
        icon: 'trash',
        label: t('common.actions.delete'),
        danger: true,
        onSelect: () => actions.remove(o),
      },
    );
  }
  return (
    <ActionContextMenu entries={entries} onOpenChange={setOpen}>
      {children}
    </ActionContextMenu>
  );
}

/**
 * Deleting from the menu, the same way as the event panel: a single event goes at once, an
 * occurrence of a series asks which ones first.
 */
export function useDeleteOccurrence(onDeleted: (eventId: string) => void) {
  const qc = useQueryClient();
  const fail = useFail();
  const [ask, setAsk] = useState<{ o: CalendarOccurrence; external: boolean } | null>(null);
  const remove = useMutation({
    mutationFn: ({ o, scope }: { o: CalendarOccurrence; scope: SeriesScope }) =>
      api.call('deleteCalendarEvent', {
        params: { eventId: eventIdOf(o) },
        query: { scope, recurrenceId: o.recurrenceId ?? undefined },
      }),
    onSuccess: async (_r, { o }) => {
      await qc.invalidateQueries({ queryKey: calendarKeys.all });
      onDeleted(eventIdOf(o));
    },
    onError: fail,
  });
  const start = (o: CalendarOccurrence) => {
    if (!o.recurring) {
      remove.mutate({ o, scope: 'all' });
      return;
    }
    // Connected calendars' series are not split here: their dialog has no "and following".
    void qc
      .fetchQuery(eventQuery(eventIdOf(o), o.recurrenceId))
      .then((e) => setAsk({ o, external: Boolean(e.external) }))
      .catch(fail);
  };
  const dialog = ask ? (
    <ScopeDialog
      kind="delete"
      withFollowing={!ask.external}
      onCancel={() => setAsk(null)}
      onPick={(scope) => {
        setAsk(null);
        remove.mutate({ o: ask.o, scope });
      }}
    />
  ) : null;
  return { start, dialog };
}

/** Right-click on an empty time slot or day: a new event starting there. */
export function SlotMenu({
  when,
  onCreate,
  onOpenChange,
  children,
}: {
  /** Where the event starts, as shown in the item ("10:30", "22 Eki"). */
  when: string;
  onCreate: () => void;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <ActionContextMenu
      onOpenChange={onOpenChange}
      entries={[
        {
          kind: 'item',
          key: 'new',
          icon: 'plus',
          label: t('calendar.menu.newAt', { when }),
          onSelect: onCreate,
        },
      ]}
    >
      {children}
    </ActionContextMenu>
  );
}
