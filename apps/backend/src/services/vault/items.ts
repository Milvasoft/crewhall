import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import {
  vaultAttachments,
  vaultItemRevisions,
  vaultItems,
  vaultVaults,
  type DbOrTx,
} from '@crewhall/db';
import type {
  CreateVaultItem,
  UpdateVaultItem,
  VaultItem,
  VaultItemRevision,
} from '@crewhall/shared';
import type { z } from 'zod';
import type { VaultImport } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { moveAttachments, releaseAttachments } from './attachments';
import { pastTrashRetention } from '../trash/retention';
import { notHeld } from '../compliance/holds';
import {
  auditVault,
  bumpVault,
  iso,
  isoOrNull,
  logEvent,
  logEvents,
  requireVault,
  toB64,
  toBytes,
  userSummaries,
  vaultAccess,
  type VaultAccess,
  type VaultActor,
} from './common';
import { isUniqueViolation } from './keys';

/**
 * Items (doc 17 §4 vault_items, §7 threat table): ciphertext in, ciphertext out. The server
 * enforces that revisions only grow by one, keeps the previous 10, and checks the key version
 * so nothing is written under a rotated-away key.
 */

export const KEPT_REVISIONS = 10;

type ItemRow = typeof vaultItems.$inferSelect;

export async function toItems(db: DbOrTx, rows: ItemRow[]): Promise<VaultItem[]> {
  if (!rows.length) return [];
  const people = await userSummaries(
    db,
    rows.flatMap((r) => [r.createdBy, r.updatedBy, r.deletedBy]),
  );
  const atts = await db
    .select({
      id: vaultAttachments.id,
      itemId: vaultAttachments.itemId,
      size: vaultAttachments.size,
      createdAt: vaultAttachments.createdAt,
    })
    .from(vaultAttachments)
    .where(
      and(
        inArray(
          vaultAttachments.itemId,
          rows.map((r) => r.id),
        ),
        eq(vaultAttachments.status, 'ready'),
      ),
    )
    .orderBy(asc(vaultAttachments.createdAt));
  const who = (id: string | null) => (id && people.get(id)) || null;
  return rows.map((r) => ({
    id: r.id,
    vaultId: r.vaultId,
    type: r.type,
    revision: r.revision,
    keyVersion: r.keyVersion,
    ciphertext: toB64(r.ciphertext),
    nonce: toB64(r.nonce),
    itemKeyWrapped: toB64(r.itemKeyWrapped),
    attachments: atts
      .filter((a) => a.itemId === r.id)
      .map((a) => ({ id: a.id, size: a.size, createdAt: iso(a.createdAt) })),
    createdBy: who(r.createdBy),
    updatedBy: who(r.updatedBy),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    deletedAt: isoOrNull(r.deletedAt),
    deletedBy: who(r.deletedBy),
  }));
}

async function one(db: DbOrTx, row: ItemRow) {
  return (await toItems(db, [row]))[0]!;
}

/** The item and my access to its vault; 404 when I hold no key for that vault. */
export async function itemAccess(
  db: DbOrTx,
  a: VaultActor,
  itemId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<{ item: ItemRow; access: VaultAccess }> {
  const q = db
    .select()
    .from(vaultItems)
    .where(and(eq(vaultItems.id, itemId), eq(vaultItems.orgId, a.org.id)));
  const [item] = opts.forUpdate ? await q.for('update') : await q;
  if (!item) throw new AppError('not_found');
  const access = await vaultAccess(db, a, item.vaultId);
  return { item, access };
}

function assertKeyVersion(access: VaultAccess, keyVersion: number) {
  if (keyVersion !== access.vault.keyVersion) {
    throw new AppError('vault_key_version_mismatch', { keyVersion: access.vault.keyVersion });
  }
}

export async function listItems(
  db: DbOrTx,
  a: VaultActor,
  vaultId: string,
  query: { cursor?: string; limit: number },
) {
  await vaultAccess(db, a, vaultId);
  const rows = await db
    .select()
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.vaultId, vaultId),
        query.cursor ? gt(vaultItems.id, query.cursor) : undefined,
      ),
    )
    .orderBy(asc(vaultItems.id))
    .limit(query.limit + 1);
  const pageRows = rows.slice(0, query.limit);
  return {
    items: await toItems(db, pageRows),
    nextCursor: rows.length > query.limit ? pageRows[pageRows.length - 1]!.id : null,
  };
}

export async function getItem(db: DbOrTx, a: VaultActor, itemId: string) {
  const { item } = await itemAccess(db, a, itemId);
  return one(db, item);
}

export async function createItem(
  db: DbOrTx,
  a: VaultActor,
  vaultId: string,
  input: CreateVaultItem,
  dates?: { createdAt?: string; updatedAt?: string },
) {
  const access = await vaultAccess(db, a, vaultId);
  requireVault(access, 'vault.edit');
  assertKeyVersion(access, input.keyVersion);
  const row = await insertItem(db, a, vaultId, input, dates);
  await bumpVault(db, vaultId);
  await logEvent(db, a, { action: 'item.create', vaultId, itemId: input.id, field: input.type });
  return one(db, row);
}

async function insertItem(
  db: DbOrTx,
  a: VaultActor,
  vaultId: string,
  input: CreateVaultItem,
  dates?: { createdAt?: string; updatedAt?: string },
) {
  try {
    const [row] = await db
      .insert(vaultItems)
      .values({
        id: input.id,
        orgId: a.org.id,
        vaultId,
        type: input.type,
        ciphertext: toBytes(input.ciphertext),
        nonce: toBytes(input.nonce),
        itemKeyWrapped: toBytes(input.itemKeyWrapped),
        keyVersion: input.keyVersion,
        revision: 1,
        createdBy: a.userId,
        updatedBy: a.userId,
        ...(dates?.createdAt ? { createdAt: new Date(dates.createdAt) } : {}),
        ...(dates?.updatedAt ? { updatedAt: new Date(dates.updatedAt) } : {}),
      })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err))
      throw new AppError('conflict', { reason: 'id_taken', id: input.id });
    throw err;
  }
}

/**
 * Save (design 8.8). The client encrypts revision current + 1; anything else is a conflict
 * (someone saved in between) or a rollback attempt, both refused.
 */
export async function updateItem(
  db: DbOrTx,
  a: VaultActor,
  itemId: string,
  input: UpdateVaultItem,
) {
  const { item, access } = await itemAccess(db, a, itemId, { forUpdate: true });
  requireVault(access, 'vault.edit');
  if (item.deletedAt) throw new AppError('conflict', { reason: 'trashed' });
  if (input.revision !== item.revision + 1) {
    const by = (await userSummaries(db, [item.updatedBy])).get(item.updatedBy ?? '') ?? null;
    throw new AppError('vault_revision_conflict', {
      currentRevision: item.revision,
      updatedBy: by,
      updatedAt: iso(item.updatedAt),
    });
  }
  assertKeyVersion(access, input.keyVersion);
  await db.insert(vaultItemRevisions).values({
    itemId,
    revision: item.revision,
    orgId: item.orgId,
    vaultId: item.vaultId,
    type: item.type,
    ciphertext: item.ciphertext,
    nonce: item.nonce,
    itemKeyWrapped: item.itemKeyWrapped,
    keyVersion: item.keyVersion,
    createdBy: item.updatedBy ?? item.createdBy,
    createdAt: item.updatedAt,
  });
  await db
    .delete(vaultItemRevisions)
    .where(
      and(
        eq(vaultItemRevisions.itemId, itemId),
        lte(vaultItemRevisions.revision, item.revision - KEPT_REVISIONS),
      ),
    );
  const [row] = await db
    .update(vaultItems)
    .set({
      type: input.type,
      ciphertext: toBytes(input.ciphertext),
      nonce: toBytes(input.nonce),
      itemKeyWrapped: toBytes(input.itemKeyWrapped),
      keyVersion: input.keyVersion,
      revision: input.revision,
      updatedBy: a.userId,
      updatedAt: new Date(),
    })
    .where(eq(vaultItems.id, itemId))
    .returning();
  await bumpVault(db, item.vaultId);
  await logEvent(db, a, { action: 'item.update', vaultId: item.vaultId, itemId });
  return one(db, row!);
}

export async function trashItem(db: DbOrTx, a: VaultActor, itemId: string) {
  const { item, access } = await itemAccess(db, a, itemId, { forUpdate: true });
  requireVault(access, 'vault.edit');
  if (item.deletedAt) return one(db, item);
  const [row] = await db
    .update(vaultItems)
    .set({ deletedAt: new Date(), deletedBy: a.userId })
    .where(eq(vaultItems.id, itemId))
    .returning();
  await bumpVault(db, item.vaultId);
  await logEvent(db, a, { action: 'item.trash', vaultId: item.vaultId, itemId });
  return one(db, row!);
}

export async function restoreItem(db: DbOrTx, a: VaultActor, itemId: string) {
  const { item, access } = await itemAccess(db, a, itemId, { forUpdate: true });
  requireVault(access, 'vault.restore');
  if (!item.deletedAt) return one(db, item);
  const [row] = await db
    .update(vaultItems)
    .set({ deletedAt: null, deletedBy: null })
    .where(eq(vaultItems.id, itemId))
    .returning();
  await bumpVault(db, item.vaultId);
  await logEvent(db, a, { action: 'item.restore', vaultId: item.vaultId, itemId });
  return one(db, row!);
}

async function purgeRows(db: DbOrTx, rows: ItemRow[]) {
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  const atts = await db
    .select()
    .from(vaultAttachments)
    .where(inArray(vaultAttachments.itemId, ids));
  await releaseAttachments(db, atts);
  await db.delete(vaultItems).where(inArray(vaultItems.id, ids));
}

/** Permanent delete (design 8.18): "Yönet" only; the encrypted blobs go too. */
export async function purgeItem(db: DbOrTx, a: VaultActor, itemId: string) {
  const { item, access } = await itemAccess(db, a, itemId, { forUpdate: true });
  requireVault(access, 'vault.purge');
  await purgeRows(db, [item]);
  await bumpVault(db, item.vaultId);
  await logEvent(db, a, { action: 'item.purge', vaultId: item.vaultId, itemId });
}

/**
 * One kept revision gone for good: what is left to do when it can't be re-wrapped, since a
 * rotation refuses to leave any behind. The item and its other revisions stay.
 */
export async function purgeRevision(db: DbOrTx, a: VaultActor, itemId: string, revision: number) {
  const { item, access } = await itemAccess(db, a, itemId, { forUpdate: true });
  requireVault(access, 'vault.purge');
  if (revision === item.revision) throw new AppError('vault_revision_current');
  const deleted = await db
    .delete(vaultItemRevisions)
    .where(and(eq(vaultItemRevisions.itemId, itemId), eq(vaultItemRevisions.revision, revision)))
    .returning({ revision: vaultItemRevisions.revision });
  if (!deleted.length) throw new AppError('not_found');
  await bumpVault(db, item.vaultId);
  await logEvent(db, a, {
    action: 'item.revision_purge',
    vaultId: item.vaultId,
    itemId,
    meta: { revision },
  });
  await auditVault(
    db,
    a,
    'vault.revision_purge',
    { type: 'vault', id: item.vaultId },
    { itemId, revision },
  );
}

export async function emptyTrash(db: DbOrTx, a: VaultActor, vaultId: string) {
  const access = await vaultAccess(db, a, vaultId, { forUpdate: true });
  requireVault(access, 'vault.purge');
  const rows = await db
    .select()
    .from(vaultItems)
    .where(and(eq(vaultItems.vaultId, vaultId), isNotNull(vaultItems.deletedAt)));
  await purgeRows(db, rows);
  if (rows.length) await bumpVault(db, vaultId);
  await logEvent(db, a, { action: 'trash.empty', vaultId, meta: { count: rows.length } });
  return { purged: rows.length };
}

/** Orgs that switched the vault module off keep their data untouched (module switches). */
export const vaultModuleOn = (orgIdColumn: SQL | AnyColumn) =>
  sql`not exists (select 1 from organizations o where o.id = ${orgIdColumn} and o.settings->'modules'->>'vault' = 'false')`;

/** Trashed items older than 30 days (nightly; design 8.18). */
export async function purgeExpiredTrash(db: DbOrTx, now: Date) {
  const rows = await db
    .select()
    .from(vaultItems)
    .where(
      and(
        isNotNull(vaultItems.deletedAt),
        pastTrashRetention(vaultItems.deletedAt, vaultItems.orgId, now),
        notHeld.vaultItem(),
        vaultModuleOn(vaultItems.orgId),
      ),
    );
  await purgeRows(db, rows);
  for (const vaultId of new Set(rows.map((r) => r.vaultId))) await bumpVault(db, vaultId);
  return rows.length;
}

/**
 * Move to another vault (design 8.8 "Kasa" field): the client re-encrypts for the target at
 * revision 1; history stays behind because it is encrypted under the source vault's key.
 */
export async function moveItem(
  db: DbOrTx,
  a: VaultActor,
  itemId: string,
  input: { targetVaultId: string; item: CreateVaultItem },
) {
  const { item, access } = await itemAccess(db, a, itemId, { forUpdate: true });
  requireVault(access, 'vault.edit');
  if (input.targetVaultId === item.vaultId) throw new AppError('invalid_target');
  const target = await vaultAccess(db, a, input.targetVaultId, { forUpdate: true });
  requireVault(target, 'vault.edit');
  assertKeyVersion(target, input.item.keyVersion);
  const row = await insertItem(db, a, input.targetVaultId, input.item, {
    createdAt: iso(item.createdAt),
  });
  await moveAttachments(db, a, item.id, item.vaultId, row.id, target.vault);
  await db.delete(vaultItems).where(eq(vaultItems.id, item.id));
  await bumpVault(db, item.vaultId);
  await bumpVault(db, input.targetVaultId);
  await logEvents(db, a, [
    {
      action: 'item.move',
      vaultId: item.vaultId,
      itemId: item.id,
      meta: { to: input.targetVaultId, newItemId: row.id },
    },
    {
      action: 'item.move',
      vaultId: input.targetVaultId,
      itemId: row.id,
      meta: { from: item.vaultId },
    },
  ]);
  return one(db, row);
}

export async function listRevisions(
  db: DbOrTx,
  a: VaultActor,
  itemId: string,
): Promise<VaultItemRevision[]> {
  await itemAccess(db, a, itemId);
  const rows = await db
    .select()
    .from(vaultItemRevisions)
    .where(eq(vaultItemRevisions.itemId, itemId))
    .orderBy(desc(vaultItemRevisions.revision))
    .limit(KEPT_REVISIONS);
  const people = await userSummaries(
    db,
    rows.map((r) => r.createdBy),
  );
  return rows.map((r) => ({
    revision: r.revision,
    type: r.type,
    keyVersion: r.keyVersion,
    ciphertext: toB64(r.ciphertext),
    nonce: toB64(r.nonce),
    itemKeyWrapped: toB64(r.itemKeyWrapped),
    createdBy: (r.createdBy && people.get(r.createdBy)) || null,
    createdAt: iso(r.createdAt),
  }));
}

/** Bitwarden import (design 8.14): one transaction, so a failure leaves nothing behind. */
export async function importItems(db: DbOrTx, a: VaultActor, input: z.infer<typeof VaultImport>) {
  const byVault = new Map<string, z.infer<typeof VaultImport>['items']>();
  for (const i of input.items) byVault.set(i.vaultId, [...(byVault.get(i.vaultId) ?? []), i]);
  for (const vaultId of byVault.keys()) {
    const access = await vaultAccess(db, a, vaultId, { forUpdate: true });
    requireVault(access, 'vault.edit');
    for (const i of byVault.get(vaultId)!) assertKeyVersion(access, i.keyVersion);
  }
  for (const [vaultId, list] of byVault) {
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
      try {
        await db.insert(vaultItems).values(
          chunk.map((it) => ({
            id: it.id,
            orgId: a.org.id,
            vaultId,
            type: it.type,
            ciphertext: toBytes(it.ciphertext),
            nonce: toBytes(it.nonce),
            itemKeyWrapped: toBytes(it.itemKeyWrapped),
            keyVersion: it.keyVersion,
            revision: 1,
            createdBy: a.userId,
            updatedBy: a.userId,
            ...(it.createdAt ? { createdAt: new Date(it.createdAt) } : {}),
            ...(it.updatedAt ? { updatedAt: new Date(it.updatedAt) } : {}),
          })),
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError('conflict', { reason: 'id_taken' });
        throw err;
      }
    }
    await db
      .update(vaultVaults)
      .set({ revision: sql`${vaultVaults.revision} + 1` })
      .where(eq(vaultVaults.id, vaultId));
    await logEvent(db, a, {
      action: 'import',
      vaultId,
      meta: { count: list.length, source: 'bitwarden' },
    });
  }
  return {
    imported: input.items.length,
    byVault: [...byVault].map(([vaultId, list]) => ({ vaultId, count: list.length })),
  };
}
