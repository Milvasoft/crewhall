import { eq } from 'drizzle-orm';
import { vaultAttachments, vaultVaults, type Db, type DbOrTx } from '@crewhall/db';
import { releaseAttachments } from './attachments';
import { purgeOldEvents } from './events';
import { purgeExpiredTrash } from './items';
import { purgeShares } from './shares';

/**
 * vault.purge (nightly): trashed items past the org's trash retention (default 30 days), their encrypted blobs with them
 * (design 8.18), access-log rows past one year (design 8.11) and expired or used-up share links
 * with their ciphertext (roadmap 20).
 */
export async function purgeVault(db: Db, now = new Date()): Promise<void> {
  await db.transaction((tx) => purgeExpiredTrash(tx, now));
  await purgeOldEvents(db, now);
  await purgeShares(db, now);
}

/**
 * Called by the space purge (trash.purge) before a deleted space's row goes: its vaults
 * cascade away with it, so their encrypted attachment blobs are released first.
 */
export async function releaseSpaceVaults(db: DbOrTx, spaceId: string) {
  const atts = await db
    .select({ att: vaultAttachments })
    .from(vaultAttachments)
    .innerJoin(vaultVaults, eq(vaultVaults.id, vaultAttachments.vaultId))
    .where(eq(vaultVaults.spaceId, spaceId));
  await releaseAttachments(
    db,
    atts.map((r) => ({ ...r.att, spaceId: null })),
  );
}
