import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  calendarAccounts,
  calendarEvents,
  calendars,
  type CalendarExternalData,
  type DbOrTx,
} from '@crewhall/db';
import { addDaysToDate } from '@crewhall/shared';
import { AppError } from '../../../http/errors';
import { calendarEnabled } from '../access';
import { syncContacts } from '../../contacts/external/sync';
import { computeSeriesEnd, timesOf } from '../events';
import { clientFor, type AccountRow, type ExtDeps } from './accounts';
import { revokeOnRefusal } from './ews/connect';
import { ProviderError } from './http';
import { SYNC_WINDOW, type DeltaResult, type ExtEvent, type ProviderClient } from './types';
import { keyOf, wireOf } from './wall';
import { ensurePush } from './push';
import { recordVersion, sameVersion, versionOfRow } from './versions';

/**
 * Mirrors the provider into Crewhall: the account's calendars become `external` calendars and
 * their events ordinary event rows (series + overrides for Google, single occurrences for
 * Microsoft). The provider is the source of truth; Crewhall never edits these rows locally.
 */

type CalendarRow = typeof calendars.$inferSelect;
const DAY_MS = 86_400_000;
const COLORS = ['s2', 's3', 's4', 's5', 's6', 's1'] as const;

/** Background sync interval per account. */
export const SYNC_EVERY_MS = 5 * 60_000;

function errorCode(err: unknown): string {
  if (err instanceof AppError) return err.code;
  if (err instanceof ProviderError) return `provider:${err.status}:${err.reason}`.slice(0, 200);
  return 'calendar_external_failed';
}

/** Lists the account's calendars and pulls their changes. Never throws; errors land on the row. */
export async function syncAccount(deps: ExtDeps, accountId: string): Promise<AccountRow | null> {
  const { db } = deps;
  const [account] = await db
    .select()
    .from(calendarAccounts)
    .where(eq(calendarAccounts.id, accountId));
  if (!account || account.status === 'revoked') return account ?? null;
  if (!(await calendarEnabled(db, account.orgId))) return account;
  try {
    const client = clientFor(deps, account);
    await revokeOnRefusal(deps, account, async () => {
      await syncCalendarList(db, client, account);
      const cals = await db
        .select()
        .from(calendars)
        .where(and(eq(calendars.accountId, account.id), isNull(calendars.deletedAt)));
      for (const cal of cals) {
        await syncCalendar(db, client, account, cal);
        await ensurePush(deps, client, account, cal);
      }
    });
    await db
      .update(calendarAccounts)
      .set({ status: 'active', lastError: null, lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(calendarAccounts.id, account.id));
  } catch (err) {
    const code = errorCode(err);
    deps.logger.warn({ err, accountId, code }, 'calendar sync failed');
    await db
      .update(calendarAccounts)
      .set({
        status: code === 'calendar_account_revoked' ? 'revoked' : 'error',
        lastError: code,
        updatedAt: new Date(),
      })
      .where(eq(calendarAccounts.id, account.id));
  }
  // On the same schedule; its own state, so a refused address book leaves the calendar alone.
  await syncContacts(deps, account);
  const [fresh] = await db
    .select()
    .from(calendarAccounts)
    .where(eq(calendarAccounts.id, accountId));
  return fresh ?? null;
}

/** Background job: accounts not synced for a while, oldest first. */
export async function syncDueAccounts(deps: ExtDeps, limit = 50) {
  const due = await deps.db
    .select({ id: calendarAccounts.id })
    .from(calendarAccounts)
    .where(
      and(
        inArray(calendarAccounts.status, ['active', 'error']),
        or(
          isNull(calendarAccounts.lastSyncedAt),
          lt(calendarAccounts.lastSyncedAt, new Date(Date.now() - SYNC_EVERY_MS + 30_000)),
        ),
      ),
    )
    .orderBy(asc(calendarAccounts.lastSyncedAt))
    .limit(limit);
  for (const a of due) await syncAccount(deps, a.id);
  return due.length;
}

async function syncCalendarList(db: DbOrTx, client: ProviderClient, account: AccountRow) {
  const remote = await client.listCalendars();
  const local = await db.select().from(calendars).where(eq(calendars.accountId, account.id));
  const seen = new Set<string>();
  let fresh = 0;
  for (const rc of remote) {
    seen.add(rc.externalId);
    const row = local.find((l) => l.externalId === rc.externalId);
    // Busy-only accounts write nothing back.
    const writable = rc.writable && !account.busyOnly;
    if (row) {
      if (row.name !== rc.name || row.externalWritable !== writable || row.deletedAt) {
        await db
          .update(calendars)
          .set({
            name: rc.name,
            externalWritable: writable,
            deletedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(calendars.id, row.id));
      }
      continue;
    }
    await db.insert(calendars).values({
      orgId: account.orgId,
      kind: 'external',
      ownerId: account.userId,
      accountId: account.id,
      externalId: rc.externalId,
      name: rc.name,
      color: COLORS[(local.length + fresh++) % COLORS.length]!,
      externalWritable: writable,
    });
  }
  const gone = local.filter((l) => l.externalId && !seen.has(l.externalId)).map((l) => l.id);
  // Removed (or unshared) at the provider: the mirror goes with its events.
  if (gone.length) await db.delete(calendars).where(inArray(calendars.id, gone));
}

/** Pulls one calendar's changes (a full listing when the cursor is missing or expired). */
export async function syncCalendar(
  db: DbOrTx,
  client: ProviderClient,
  account: AccountRow,
  cal: CalendarRow,
) {
  let res: DeltaResult;
  try {
    res = await client.delta(cal.externalId!, cal.syncState ?? null);
  } catch (err) {
    if (!(err instanceof ProviderError) || !err.gone) throw err;
    res = await client.delta(cal.externalId!, null);
  }
  await applyDelta(db, client, account, cal, res);
  await db
    .update(calendars)
    .set({
      // The notification channel outlives sync cursors.
      syncState: cal.syncState?.push ? { ...res.state, push: cal.syncState.push } : res.state,
      changeSeq: sql`${calendars.changeSeq} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(calendars.id, cal.id));
}

type Existing = Pick<
  typeof calendarEvents.$inferSelect,
  | 'id'
  | 'externalId'
  | 'externalEtag'
  | 'parentId'
  | 'recurrenceId'
  | 'uid'
  | 'allDay'
  | 'rrule'
  | 'exdates'
  | 'external'
  | 'title'
  | 'description'
  | 'location'
  | 'startsAt'
  | 'endsAt'
  | 'startDate'
  | 'endDate'
>;

export async function applyDelta(
  db: DbOrTx,
  client: ProviderClient,
  account: AccountRow,
  cal: CalendarRow,
  res: DeltaResult,
) {
  const rows: Existing[] = await db
    .select({
      id: calendarEvents.id,
      externalId: calendarEvents.externalId,
      externalEtag: calendarEvents.externalEtag,
      parentId: calendarEvents.parentId,
      recurrenceId: calendarEvents.recurrenceId,
      uid: calendarEvents.uid,
      allDay: calendarEvents.allDay,
      rrule: calendarEvents.rrule,
      exdates: calendarEvents.exdates,
      external: calendarEvents.external,
      title: calendarEvents.title,
      description: calendarEvents.description,
      location: calendarEvents.location,
      startsAt: calendarEvents.startsAt,
      endsAt: calendarEvents.endsAt,
      startDate: calendarEvents.startDate,
      endDate: calendarEvents.endDate,
    })
    .from(calendarEvents)
    .where(eq(calendarEvents.calendarId, cal.id));
  const byExt = new Map(rows.filter((r) => r.externalId).map((r) => [r.externalId!, r]));
  const seen = new Set<string>();
  const doomed = new Set<string>();

  const remove = (externalId: string) => {
    const r = byExt.get(externalId);
    if (r) {
      doomed.add(r.id);
      for (const o of rows) if (o.parentId === r.id) doomed.add(o.id);
    }
    for (const o of rows) if (o.external?.seriesMasterId === externalId) doomed.add(o.id);
  };

  const valuesOf = (
    ev: ExtEvent,
    opts: {
      parentId?: string;
      recurrenceId?: string;
      uid?: string;
      readOnly?: boolean;
      seriesMasterId?: string;
      exdates?: string[];
    },
  ) => {
    let end = ev.end;
    if (ev.start.allDay && end.allDay && end.date <= ev.start.date)
      end = { allDay: true, date: addDaysToDate(ev.start.date, 1) };
    if (!ev.start.allDay && !end.allDay && end.at < ev.start.at) end = ev.start;
    const times = timesOf(ev.start.allDay, wireOf(ev.start), wireOf(end));
    const external: CalendarExternalData = {
      ...ev.data,
      readOnly: opts.readOnly ?? ev.data.readOnly,
      seriesMasterId: opts.seriesMasterId ?? ev.data.seriesMasterId,
    };
    // "Yalnız meşgul/boş": only the times stay (an empty title shows as "Meşgul").
    const quiet = account.busyOnly;
    if (quiet) {
      Object.assign(external, { joinUrl: null, organizer: null, attendees: [], readOnly: true });
    }
    const base = {
      orgId: cal.orgId,
      calendarId: cal.id,
      uid: opts.uid ?? `ext-${account.provider}-${ev.externalId}`.slice(0, 900),
      parentId: opts.parentId ?? null,
      recurrenceId: opts.recurrenceId ?? null,
      title: quiet ? '' : ev.title.slice(0, 500),
      description: quiet ? null : (ev.description?.slice(0, 10_000) ?? null),
      location: quiet ? null : (ev.location?.slice(0, 500) ?? null),
      ...times,
      timeZone: ev.timeZone,
      rrule: opts.parentId ? null : ev.rrule,
      exdates: opts.exdates ?? (opts.parentId ? [] : ev.exdates),
      status: ev.status,
      busy: ev.busy,
      visibility: ev.private ? ('private' as const) : ('default' as const),
      reminders: null,
      organizerId: null,
      externalId: ev.externalId,
      externalEtag: ev.etag,
      external,
      deletedAt: null,
    };
    return { ...base, seriesEndsAt: computeSeriesEnd(base) };
  };

  const upsert = async (values: ReturnType<typeof valuesOf>) => {
    seen.add(values.externalId);
    const current = byExt.get(values.externalId);
    if (current) {
      doomed.delete(current.id);
      const sameEtag = current.externalEtag && current.externalEtag === values.externalEtag;
      if (sameEtag && !res.full) return current;
      if (current.external?.writtenHere) {
        if (sameEtag) {
          // A full listing of the version we wrote: it stays ours.
          values.external.writtenHere = true;
        } else {
          // The provider replaced what was written from Crewhall: the last writer wins, the
          // overwritten version stays in the event's history.
          const old = versionOfRow(current);
          const next = versionOfRow({ ...current, ...values });
          if (!sameVersion(old, next)) {
            await recordVersion(db, {
              orgId: cal.orgId,
              eventId: current.id,
              source: 'crewhall',
              data: old,
              etag: current.externalEtag,
            });
          }
        }
      }
      await db
        .update(calendarEvents)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(calendarEvents.id, current.id));
      const next = { ...current, ...values };
      byExt.set(values.externalId, next);
      return next;
    }
    const [created] = await db.insert(calendarEvents).values(values).returning();
    const row: Existing = created!;
    rows.push(row);
    byExt.set(values.externalId, row);
    return row;
  };

  for (const id of res.removedIds) remove(id);

  const masters = res.events.filter((e) => !e.parentExternalId);
  const children = res.events.filter((e) => e.parentExternalId);
  // A full listing rebuilds exdates from the series' own EXDATEs and its cancelled occurrences.
  const cancelledKeys = new Map<string, string[]>();
  for (const ev of children) {
    if (!ev.cancelled || !ev.originalStart) continue;
    const list = cancelledKeys.get(ev.parentExternalId!) ?? [];
    list.push(keyOf(ev.originalStart));
    cancelledKeys.set(ev.parentExternalId!, list);
  }

  for (const ev of masters) {
    if (ev.cancelled) {
      remove(ev.externalId);
      continue;
    }
    if (ev.unsupportedRecurrence) {
      // Store the occurrences one by one (read-only); the series stays editable at the provider.
      remove(ev.externalId);
      const now = Date.now();
      const list = await client.instances(
        cal.externalId!,
        ev.externalId,
        new Date(now - SYNC_WINDOW.pastDays * DAY_MS),
        new Date(now + SYNC_WINDOW.futureDays * DAY_MS),
      );
      for (const inst of list) {
        await upsert(valuesOf(inst, { readOnly: true, seriesMasterId: ev.externalId }));
      }
      continue;
    }
    const current = byExt.get(ev.externalId);
    const extra = cancelledKeys.get(ev.externalId) ?? [];
    const exdates = res.full
      ? [...new Set([...ev.exdates, ...extra])]
      : [
          ...new Set([
            ...ev.exdates,
            ...extra,
            ...(current?.rrule && ev.rrule ? current.exdates : []),
          ]),
        ];
    await upsert(valuesOf(ev, { exdates }));
  }

  for (const ev of children) {
    const parent = byExt.get(ev.parentExternalId!);
    if (!parent || !parent.rrule || !ev.originalStart) continue;
    const key = keyOf(ev.originalStart);
    if (ev.cancelled) {
      if (!res.full && !parent.exdates.includes(key)) {
        const exdates = [...parent.exdates, key];
        await db
          .update(calendarEvents)
          .set({ exdates, updatedAt: new Date() })
          .where(eq(calendarEvents.id, parent.id));
        parent.exdates = exdates;
      }
      for (const o of rows) {
        if (o.parentId === parent.id && (o.externalId === ev.externalId || o.recurrenceId === key))
          doomed.add(o.id);
      }
      const own = byExt.get(ev.externalId);
      if (own) doomed.add(own.id);
      continue;
    }
    await upsert(valuesOf(ev, { parentId: parent.id, recurrenceId: key, uid: parent.uid }));
  }

  if (res.full) {
    for (const r of rows) if (r.externalId && !seen.has(r.externalId)) doomed.add(r.id);
  }
  const ids = [...doomed];
  for (let i = 0; i < ids.length; i += 500) {
    await db.delete(calendarEvents).where(inArray(calendarEvents.id, ids.slice(i, i + 500)));
  }
}

/** Runs one calendar's incremental sync right after Crewhall wrote to the provider. */
export async function refreshCalendar(deps: ExtDeps, account: AccountRow, calendarId: string) {
  const [cal] = await deps.db.select().from(calendars).where(eq(calendars.id, calendarId));
  if (!cal) throw new AppError('not_found');
  await syncCalendar(deps.db, clientFor(deps, account), account, cal);
}
