import { and, desc, eq, gte, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import { vaultEvents, vaultItems, type DbOrTx } from '@crewhall/db';
import type { VaultEvent, VaultEventAction } from '@crewhall/shared';
import type { z } from 'zod';
import type { ReportVaultEvents, VaultEventsQuery } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import {
  iso,
  logEvents,
  requireVault,
  userSummaries,
  vaultAccess,
  type VaultActor,
} from './common';
import { vaultModuleOn } from './items';
import { myVaultIds } from './vaults';

/**
 * Access log (design 8.11). The client reports which field it showed or copied (never the
 * value); the server adds what it saw itself. Managers read their vaults' log, everyone their
 * own unlock events; rows are append-only and kept for a year.
 */

export const EVENT_RETENTION_DAYS = 365;

export async function reportEvents(
  db: DbOrTx,
  a: VaultActor,
  input: z.infer<typeof ReportVaultEvents>,
) {
  const vaultIds = [...new Set(input.events.map((e) => e.vaultId))];
  for (const vaultId of vaultIds) await vaultAccess(db, a, vaultId);
  const itemIds = [...new Set(input.events.map((e) => e.itemId))];
  const items = await db
    .select({ id: vaultItems.id, vaultId: vaultItems.vaultId })
    .from(vaultItems)
    .where(inArray(vaultItems.id, itemIds));
  const vaultOf = new Map(items.map((i) => [i.id, i.vaultId]));
  for (const e of input.events) {
    if (vaultOf.get(e.itemId) !== e.vaultId) throw new AppError('not_found', { itemId: e.itemId });
  }
  await logEvents(
    db,
    a,
    input.events.map((e) => ({
      action: e.action === 'reveal' ? ('item.reveal' as const) : ('item.copy' as const),
      vaultId: e.vaultId,
      itemId: e.itemId,
      field: e.field,
    })),
  );
}

export async function listEvents(db: DbOrTx, a: VaultActor, q: z.infer<typeof VaultEventsQuery>) {
  let scope: SQL | undefined;
  if (q.vaultId) {
    requireVault(await vaultAccess(db, a, q.vaultId), 'vault.view_log');
    scope = eq(vaultEvents.vaultId, q.vaultId);
  } else {
    const managed = await myVaultIds(db, a, ['manage']);
    scope = or(
      managed.length ? inArray(vaultEvents.vaultId, managed) : undefined,
      and(isNull(vaultEvents.vaultId), eq(vaultEvents.actorId, a.userId)),
    );
  }
  const rows = await db
    .select()
    .from(vaultEvents)
    .where(
      and(
        eq(vaultEvents.orgId, a.org.id),
        scope,
        q.userId ? eq(vaultEvents.actorId, q.userId) : undefined,
        q.action ? eq(vaultEvents.action, q.action) : undefined,
        q.since ? gte(vaultEvents.at, new Date(q.since)) : undefined,
        q.cursor && /^\d+$/.test(q.cursor) ? lt(vaultEvents.id, Number(q.cursor)) : undefined,
      ),
    )
    .orderBy(desc(vaultEvents.id))
    .limit(q.limit + 1);
  const pageRows = rows.slice(0, q.limit);
  const people = await userSummaries(
    db,
    pageRows.flatMap((r) => [r.actorId, r.targetUserId]),
  );
  const items: VaultEvent[] = pageRows.map((r) => ({
    id: String(r.id),
    at: iso(r.at),
    actor: (r.actorId && people.get(r.actorId)) || null,
    action: r.action as VaultEventAction,
    vaultId: r.vaultId,
    itemId: r.itemId,
    field: r.field,
    targetUser: (r.targetUserId && people.get(r.targetUserId)) || null,
    meta: r.meta,
    ip: r.ip,
    userAgent: r.userAgent,
  }));
  return {
    items,
    nextCursor: rows.length > q.limit ? String(pageRows[pageRows.length - 1]!.id) : null,
  };
}

/** Nightly: drop log rows past the one-year retention. */
export async function purgeOldEvents(db: DbOrTx, now = new Date()) {
  const cutoff = new Date(now.getTime() - EVENT_RETENTION_DAYS * 86_400_000);
  await db
    .delete(vaultEvents)
    .where(and(lt(vaultEvents.at, cutoff), vaultModuleOn(vaultEvents.orgId)));
}
