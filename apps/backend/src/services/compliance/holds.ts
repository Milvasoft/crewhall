import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  conversations,
  heldMessages,
  legalHolds,
  nodes,
  spaces,
  users,
  type DbOrTx,
} from '@crewhall/db';
import type { CreateLegalHold, LegalHold } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { identityAudit } from '../identity/audit';

/**
 * Legal hold (roadmap 25): while a hold is active, what its custodians created and
 * everything in its spaces is exempt from every purge (trash, retention rules, "Herkes için
 * sil" of a whole conversation), and held chat messages keep their original text when they
 * are edited or deleted. Releasing the hold returns the content to the normal rules.
 */

const ACTIVE = sql`h.released_at is null`;

/** Active hold of the row's org covering `spaceId` or `authorId` (raw SQL column refs). */
function covered(orgId: SQL, spaceId: SQL | null, authorId: SQL | null): SQL {
  const parts: SQL[] = [];
  if (spaceId) parts.push(sql`${spaceId} = any(h.space_ids)`);
  if (authorId) parts.push(sql`${authorId} = any(h.user_ids)`);
  return sql`exists (select 1 from legal_holds h where h.org_id = ${orgId} and ${ACTIVE}
    and (${sql.join(parts, sql` or `)}))`;
}

/** Purge filters per table; table names are written out, so they work in DELETE and UPDATE. */
export const notHeld = {
  boardCard: (): SQL =>
    sql`not ${covered(
      sql.raw('"board_cards"."org_id"'),
      sql.raw('(select b.space_id from nodes b where b.id = "board_cards"."board_node_id")'),
      sql.raw('"board_cards"."created_by"'),
    )}`,
  vaultItem: (): SQL =>
    sql`not ${covered(
      sql.raw('"vault_items"."org_id"'),
      sql.raw('(select v.space_id from vault_vaults v where v.id = "vault_items"."vault_id")'),
      sql.raw('"vault_items"."created_by"'),
    )}`,
  surfaceCard: (): SQL =>
    sql`not ${covered(sql.raw('"surface_cards"."org_id"'), null, sql.raw('"surface_cards"."created_by"'))}`,
  message: (): SQL =>
    sql`not ${covered(
      sql.raw('"messages"."org_id"'),
      sql.raw('(select c.space_id from conversations c where c.id = "messages"."conversation_id")'),
      sql.raw('"messages"."author_id"'),
    )}`,
  space: (): SQL =>
    sql`not ${covered(sql.raw('"spaces"."org_id"'), sql.raw('"spaces"."id"'), null)}`,
};

/** Trash roots whose subtree holds anything under an active hold. */
export async function heldNodeRoots(db: DbOrTx, roots: { id: string }[]) {
  if (!roots.length) return new Set<string>();
  const ids = roots.map((r) => sql`${r.id}::uuid`);
  const rows = await db.execute<{ id: string }>(sql`
    select r.id from ${nodes} r
    where r.id in (${sql.join(ids, sql`, `)}) and exists (
      select 1 from ${nodes} n join legal_holds h on h.org_id = n.org_id and ${ACTIVE}
      where n.space_id = r.space_id and n.path <@ r.path
        and (n.space_id = any(h.space_ids) or n.created_by = any(h.user_ids)))`);
  return new Set(rows.rows.map((r) => r.id));
}

/** Whether a chat message (its author or its conversation's space) is held. */
export async function messageHeld(
  db: DbOrTx,
  m: { orgId: string; conversationId: string; authorId: string | null },
) {
  const [conv] = await db
    .select({ spaceId: conversations.spaceId })
    .from(conversations)
    .where(eq(conversations.id, m.conversationId));
  const rows = await db.execute<{ held: boolean }>(
    sql`select ${covered(
      sql`${m.orgId}::uuid`,
      conv?.spaceId ? sql`${conv.spaceId}::uuid` : null,
      m.authorId ? sql`${m.authorId}::uuid` : null,
    )} as held`,
  );
  return rows.rows[0]?.held === true;
}

/** Keeps the original of a held message before it changes. */
export async function archiveHeldMessage(
  db: DbOrTx,
  kind: 'edit' | 'delete' | 'conversation_delete',
  m: {
    id: string;
    orgId: string;
    conversationId: string;
    authorId: string | null;
    text: string;
    body: unknown;
    createdAt: Date;
  },
) {
  if (!(await messageHeld(db, m))) return false;
  await db.insert(heldMessages).values({
    orgId: m.orgId,
    messageId: m.id,
    conversationId: m.conversationId,
    authorId: m.authorId,
    kind,
    text: m.text,
    body: m.body as Record<string, unknown>,
    sentAt: m.createdAt,
  });
  return true;
}

/** Whether a conversation (its space or any member) is held: it cannot be deleted for all. */
export async function conversationHeld(db: DbOrTx, orgId: string, conversationId: string) {
  const rows = await db.execute<{ held: boolean }>(sql`
    select exists (
      select 1 from legal_holds h, conversations c
      where c.id = ${conversationId}::uuid and h.org_id = ${orgId}::uuid and ${ACTIVE}
        and (c.space_id = any(h.space_ids) or exists (
          select 1 from conversation_members cm
          where cm.conversation_id = c.id and cm.user_id = any(h.user_ids)))
    ) as held`);
  return rows.rows[0]?.held === true;
}

export async function requireNotHeld(held: boolean) {
  if (held) throw new AppError('legal_hold');
}

export async function listHolds(db: DbOrTx, orgId: string): Promise<LegalHold[]> {
  const rows = await db
    .select()
    .from(legalHolds)
    .where(eq(legalHolds.orgId, orgId))
    .orderBy(desc(legalHolds.createdAt));
  const userIds = [
    ...new Set(rows.flatMap((r) => [...r.userIds, r.createdBy ?? '']).filter(Boolean)),
  ];
  const spaceIds = [...new Set(rows.flatMap((r) => r.spaceIds))];
  const people = new Map(
    (userIds.length ? await db.select().from(users).where(inArray(users.id, userIds)) : []).map(
      (u) => [u.id, { id: u.id, name: u.name, email: u.email, imageUrl: u.image }],
    ),
  );
  const spaceNames = new Map(
    (spaceIds.length
      ? await db
          .select({ id: spaces.id, name: spaces.name })
          .from(spaces)
          .where(inArray(spaces.id, spaceIds))
      : []
    ).map((s) => [s.id, s]),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    reason: r.reason,
    users: r.userIds.map((id) => people.get(id)).filter((u) => u !== undefined),
    spaces: r.spaceIds.map((id) => spaceNames.get(id)).filter((s) => s !== undefined),
    createdBy: r.createdBy ? (people.get(r.createdBy) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
    releasedAt: r.releasedAt?.toISOString() ?? null,
  }));
}

export async function createHold(
  db: DbOrTx,
  actor: { orgId: string; userId: string },
  input: CreateLegalHold,
  req?: RequestInfo,
) {
  const spaceIds = [...new Set(input.spaceIds)];
  if (spaceIds.length) {
    const found = await db
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.orgId, actor.orgId), inArray(spaces.id, spaceIds)));
    if (found.length !== spaceIds.length) throw new AppError('not_found', { field: 'spaceIds' });
  }
  const [row] = await db
    .insert(legalHolds)
    .values({
      orgId: actor.orgId,
      name: input.name,
      reason: input.reason ?? null,
      userIds: [...new Set(input.userIds)],
      spaceIds,
      createdBy: actor.userId,
    })
    .returning();
  await identityAudit(
    db,
    {
      orgId: actor.orgId,
      actorId: actor.userId,
      action: 'compliance.hold.create',
      targetType: 'legal_hold',
      targetId: row!.id,
      meta: { name: input.name, userIds: row!.userIds, spaceIds },
    },
    req,
  );
  return (await listHolds(db, actor.orgId)).find((h) => h.id === row!.id)!;
}

export async function releaseHold(
  db: DbOrTx,
  actor: { orgId: string; userId: string },
  holdId: string,
  req?: RequestInfo,
) {
  const [row] = await db
    .update(legalHolds)
    .set({ releasedAt: new Date(), releasedBy: actor.userId })
    .where(
      and(
        eq(legalHolds.id, holdId),
        eq(legalHolds.orgId, actor.orgId),
        isNull(legalHolds.releasedAt),
      ),
    )
    .returning();
  if (!row) throw new AppError('not_found');
  await identityAudit(
    db,
    {
      orgId: actor.orgId,
      actorId: actor.userId,
      action: 'compliance.hold.release',
      targetType: 'legal_hold',
      targetId: row.id,
    },
    req,
  );
  return (await listHolds(db, actor.orgId)).find((h) => h.id === row.id)!;
}
