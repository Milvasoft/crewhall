import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { nodes, nodeVersions, spaces, uploads, vaultAttachments, type DbOrTx } from '@crewhall/db';
import { DEFAULT_MAX_FILE_BYTES, type OrgQuota } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { OrgRow } from '../../http/types';
import type { SpaceRow } from './access';

/**
 * Storage accounting (doc 17 §8): logical bytes, every version and the trash included.
 * spaces.used_bytes moves in the same transaction as the nodes; uploads in progress
 * hold a reservation so parallel uploads cannot overshoot.
 */

export const orgLimits = (org: OrgRow) => ({
  quotaBytes: org.settings.storageQuotaBytes ?? null,
  maxFileBytes: org.settings.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
});

async function reserved(db: DbOrTx, where: ReturnType<typeof eq>) {
  const [row] = await db
    .select({ n: sql<string>`coalesce(sum(${uploads.sizeBytes}), 0)` })
    .from(uploads)
    .where(and(eq(uploads.status, 'uploading'), sql`${uploads.expiresAt} > now()`, where));
  return Number(row?.n ?? 0);
}

export async function orgUsedBytes(db: DbOrTx, orgId: string) {
  const [row] = await db
    .select({ n: sql<string>`coalesce(sum(${spaces.usedBytes}), 0)` })
    .from(spaces)
    .where(eq(spaces.orgId, orgId));
  return Number(row?.n ?? 0);
}

/** Refuses `bytes` more when the space or the org quota would overflow. */
export async function assertQuota(db: DbOrTx, org: OrgRow, space: SpaceRow, bytes: number) {
  if (space.quotaBytes !== null) {
    const [fresh] = await db
      .select({ used: spaces.usedBytes })
      .from(spaces)
      .where(eq(spaces.id, space.id));
    const used = (fresh?.used ?? 0) + (await reserved(db, eq(uploads.spaceId, space.id)));
    if (used + bytes > space.quotaBytes) {
      throw new AppError('quota_exceeded', {
        scope: 'space',
        quotaBytes: space.quotaBytes,
        usedBytes: used,
      });
    }
  }
  const { quotaBytes } = orgLimits(org);
  if (quotaBytes !== null) {
    const used = (await orgUsedBytes(db, org.id)) + (await reserved(db, eq(uploads.orgId, org.id)));
    if (used + bytes > quotaBytes) {
      throw new AppError('quota_exceeded', { scope: 'org', quotaBytes, usedBytes: used });
    }
  }
}

export async function getQuota(db: DbOrTx, org: OrgRow): Promise<OrgQuota> {
  const usedBytes = await orgUsedBytes(db, org.id);
  const [trash] = await db
    .select({ n: sql<string>`coalesce(sum(${nodeVersions.sizeBytes}), 0)` })
    .from(nodeVersions)
    .innerJoin(nodes, eq(nodes.id, nodeVersions.nodeId))
    .where(and(eq(nodes.orgId, org.id), isNotNull(nodes.deletedAt)));
  const { quotaBytes, maxFileBytes } = orgLimits(org);
  const ratio = quotaBytes ? usedBytes / quotaBytes : 0;
  return {
    usedBytes,
    quotaBytes,
    trashBytes: Number(trash?.n ?? 0),
    maxFileBytes,
    warning: ratio >= 0.9,
    full: ratio >= 1,
  };
}

/**
 * Recomputes spaces.used_bytes (nightly quota.reconcile job): file versions (trash included)
 * plus finished vault attachments counted against the space.
 */
export async function reconcileSpaceBytes(db: DbOrTx) {
  await db.execute(sql`
    update ${spaces} s set used_bytes = t.bytes
    from (
      select sp.id,
        coalesce((
          select sum(v.size_bytes) from ${nodeVersions} v
          join ${nodes} n on n.id = v.node_id
          where n.space_id = sp.id
        ), 0)
        + coalesce((
          select sum(a.size) from ${vaultAttachments} a
          where a.space_id = sp.id and a.status = 'ready'
        ), 0) as bytes
      from ${spaces} sp
    ) t
    where s.id = t.id and s.used_bytes is distinct from t.bytes`);
}
