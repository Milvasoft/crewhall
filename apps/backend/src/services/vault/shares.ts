import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { and, desc, eq, gt, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { organizations, vaultEvents, vaultShares, type DbOrTx } from '@crewhall/db';
import type {
  CreateVaultShare,
  OpenedVaultShare,
  PublicVaultShare,
  VaultShare,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { OrgRow, RequestInfo } from '../../http/types';
import {
  can,
  iso,
  logEvent,
  requireVault,
  toB64,
  toBytes,
  userSummaries,
  vaultAccess,
  type VaultActor,
} from './common';
import { itemAccess } from './items';
import { getPolicy } from './policy';
import { myVaultIds } from './vaults';

/**
 * One-time share links (roadmap 20). The device encrypts the item again under a fresh key and
 * puts that key in the link fragment, which browsers never send; the server keeps ciphertext,
 * the hash of the link token, the limits and the open count. After the last open, a revoke or
 * the expiry the row goes, ciphertext included.
 */

type ShareRow = typeof vaultShares.$inferSelect;

const hashToken = (token: string) => createHash('sha256').update(token).digest();

const live = (now: Date) =>
  and(gt(vaultShares.expiresAt, now), lt(vaultShares.views, vaultShares.maxViews));

async function toShares(db: DbOrTx, rows: ShareRow[]): Promise<VaultShare[]> {
  const people = await userSummaries(
    db,
    rows.map((r) => r.createdBy),
  );
  return rows.map((r) => ({
    id: r.id,
    vaultId: r.vaultId,
    itemId: r.itemId,
    createdBy: (r.createdBy && people.get(r.createdBy)) || null,
    createdAt: iso(r.createdAt),
    expiresAt: iso(r.expiresAt),
    maxViews: r.maxViews,
    views: r.views,
  }));
}

export async function createShare(
  db: DbOrTx,
  a: VaultActor,
  itemId: string,
  input: CreateVaultShare,
  now = new Date(),
): Promise<VaultShare> {
  const { item, access } = await itemAccess(db, a, itemId);
  if (item.deletedAt) throw new AppError('not_found');
  requireVault(access, 'vault.share_link');
  const policy = await getPolicy(db, a.org.id);
  if (!policy.shareLinks) throw new AppError('vault_share_disabled');
  if (input.expiresInHours > policy.shareMaxHours || input.maxViews > policy.shareMaxViews) {
    throw new AppError('vault_share_limit', {
      maxHours: policy.shareMaxHours,
      maxViews: policy.shareMaxViews,
    });
  }
  const token = randomBytes(32).toString('base64url');
  const [row] = await db
    .insert(vaultShares)
    .values({
      orgId: a.org.id,
      vaultId: item.vaultId,
      itemId,
      tokenHash: hashToken(token),
      ciphertext: toBytes(input.ciphertext),
      nonce: toBytes(input.nonce),
      maxViews: input.maxViews,
      expiresAt: new Date(now.getTime() + input.expiresInHours * 3_600_000),
      createdBy: a.userId,
    })
    .returning();
  await logEvent(db, a, {
    action: 'share.create',
    vaultId: item.vaultId,
    itemId,
    meta: { shareId: row!.id, maxViews: input.maxViews, expiresAt: iso(row!.expiresAt) },
  });
  const [out] = await toShares(db, [row!]);
  return { ...out!, token };
}

/** Live links I created, plus those in vaults I manage; optionally of one item. */
export async function listShares(
  db: DbOrTx,
  a: VaultActor,
  q: { itemId?: string | undefined },
  now = new Date(),
): Promise<VaultShare[]> {
  const managed = await myVaultIds(db, a, ['manage']);
  const rows = await db
    .select()
    .from(vaultShares)
    .where(
      and(
        eq(vaultShares.orgId, a.org.id),
        live(now),
        q.itemId ? eq(vaultShares.itemId, q.itemId) : undefined,
        or(
          eq(vaultShares.createdBy, a.userId),
          managed.length ? inArray(vaultShares.vaultId, managed) : undefined,
        ),
      ),
    )
    .orderBy(desc(vaultShares.createdAt))
    .limit(500);
  return toShares(db, rows);
}

export async function revokeShare(db: DbOrTx, a: VaultActor, shareId: string) {
  const [row] = await db
    .select()
    .from(vaultShares)
    .where(and(eq(vaultShares.id, shareId), eq(vaultShares.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  if (row.createdBy !== a.userId) {
    const access = await vaultAccess(db, a, row.vaultId);
    if (!can(access, 'vault.view_log')) throw new AppError('forbidden', { action: 'revoke' });
  }
  await db.delete(vaultShares).where(eq(vaultShares.id, shareId));
  await logEvent(db, a, {
    action: 'share.revoke',
    vaultId: row.vaultId,
    itemId: row.itemId,
    meta: { shareId },
  });
}

/* ---------------------------------- public side ---------------------------------- */

const vaultOff = (org: Pick<OrgRow, 'settings'>) => org.settings.modules?.vault === false;

async function findLive(db: DbOrTx, token: string, now: Date) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError('vault_share_gone');
  const [row] = await db
    .select({ share: vaultShares, settings: organizations.settings })
    .from(vaultShares)
    .innerJoin(organizations, eq(organizations.id, vaultShares.orgId))
    .where(and(eq(vaultShares.tokenHash, hashToken(token)), live(now)));
  if (!row) throw new AppError('vault_share_gone');
  if (vaultOff(row)) throw new AppError('module_disabled', { module: 'vault' });
  if (!(await getPolicy(db, row.share.orgId)).shareLinks) {
    throw new AppError('vault_share_disabled');
  }
  return row.share;
}

export async function publicShare(
  db: DbOrTx,
  token: string,
  now = new Date(),
): Promise<PublicVaultShare> {
  const s = await findLive(db, token, now);
  return { expiresAt: iso(s.expiresAt), viewsLeft: s.maxViews - s.views };
}

/**
 * Counts one open atomically (two people opening a single-use link at once: one wins) and
 * deletes the row with its ciphertext after the last open.
 */
export async function openShare(
  db: DbOrTx,
  token: string,
  req: RequestInfo,
  now = new Date(),
): Promise<OpenedVaultShare> {
  await findLive(db, token, now);
  const [row] = await db
    .update(vaultShares)
    .set({ views: sql`${vaultShares.views} + 1`, updatedAt: now })
    .where(and(eq(vaultShares.tokenHash, hashToken(token)), live(now)))
    .returning();
  if (!row) throw new AppError('vault_share_gone');
  const viewsLeft = row.maxViews - row.views;
  if (viewsLeft <= 0) await db.delete(vaultShares).where(eq(vaultShares.id, row.id));
  await db.insert(vaultEvents).values({
    orgId: row.orgId,
    actorId: null,
    action: 'share.open',
    vaultId: row.vaultId,
    itemId: row.itemId,
    meta: { shareId: row.id, viewsLeft },
    ip: req.ip && isIP(req.ip) ? req.ip : null,
    userAgent: req.userAgent,
  });
  return {
    expiresAt: iso(row.expiresAt),
    viewsLeft,
    ciphertext: toB64(row.ciphertext),
    nonce: toB64(row.nonce),
  };
}

/** vault.purge: expired or used-up links go with their ciphertext. */
export async function purgeShares(db: DbOrTx, now = new Date()) {
  await db
    .delete(vaultShares)
    .where(or(lte(vaultShares.expiresAt, now), sql`${vaultShares.views} >= ${vaultShares.maxViews}`));
}
