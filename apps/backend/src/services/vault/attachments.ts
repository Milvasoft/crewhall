import { and, eq, inArray } from 'drizzle-orm';
import { blobs, newId, spaces, vaultAttachments, type DbOrTx } from '@crewhall/db';
import {
  UPLOAD_PART_SIZE,
  VAULT_ATTACHMENT_MAX_BYTES,
  type VaultAttachment,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { requireStorage } from '../drive/files';
import { assertQuota } from '../drive/quota';
import { adjustSpaceBytes, releaseBlob, retainBlob } from '../drive/tree';
import { personalSpaceId } from '../spaces';
import { bumpVault, iso, logEvent, requireVault, type VaultActor, type VaultRow } from './common';
import { itemAccess } from './items';

/**
 * Encrypted attachments (design 8.8 "Cihazda şifrelenip yüklenir · en çok 100 MB", doc 17 §8):
 * the device encrypts, then PUTs the ciphertext straight to the store through presigned
 * multipart URLs. The blob is marked encrypted and never deduplicated or previewed; its name
 * and key exist only inside the encrypted item.
 */

type AttachmentRow = typeof vaultAttachments.$inferSelect;

const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** The space whose quota a vault's attachments use: its space, or the owner's personal space. */
async function quotaSpaceId(db: DbOrTx, vault: VaultRow) {
  if (vault.spaceId) return vault.spaceId;
  return vault.ownerUserId ? personalSpaceId(db, vault.orgId, vault.ownerUserId) : null;
}

export async function createAttachment(
  deps: Deps,
  a: VaultActor,
  itemId: string,
  input: { id: string; size: number },
) {
  const storage = requireStorage(deps);
  const { db } = deps;
  const { item, access } = await itemAccess(db, a, itemId);
  requireVault(access, 'vault.edit');
  if (item.deletedAt) throw new AppError('conflict', { reason: 'trashed' });
  if (input.size > VAULT_ATTACHMENT_MAX_BYTES) throw new AppError('vault_attachment_too_large');
  const spaceId = await quotaSpaceId(db, access.vault);
  if (spaceId) {
    const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId));
    if (space) await assertQuota(db, a.org, space, input.size);
  }
  const storageKey = `orgs/${a.org.id}/vault/${newId()}`;
  const s3UploadId = await storage.createMultipart(storageKey, 'application/octet-stream');
  const [blob] = await db
    .insert(blobs)
    .values({
      orgId: a.org.id,
      size: input.size,
      mime: 'application/octet-stream',
      storageKey,
      encrypted: true,
      status: 'pending',
    })
    .returning();
  try {
    await db.insert(vaultAttachments).values({
      id: input.id,
      orgId: a.org.id,
      vaultId: item.vaultId,
      itemId,
      blobId: blob!.id,
      spaceId,
      size: input.size,
      s3UploadId,
      createdBy: a.userId,
    });
  } catch (err) {
    await storage.abortMultipart(storageKey, s3UploadId).catch(() => undefined);
    await db.delete(blobs).where(eq(blobs.id, blob!.id));
    if (
      (err as { code?: string }).code === '23505' ||
      (err as { cause?: { code?: string } }).cause?.code === '23505'
    ) {
      throw new AppError('conflict', { reason: 'id_taken' });
    }
    throw err;
  }
  const partCount = Math.max(1, Math.ceil(input.size / UPLOAD_PART_SIZE));
  const parts = await Promise.all(
    Array.from({ length: partCount }, async (_, i) => ({
      partNumber: i + 1,
      url: await storage.presignPart(storageKey, s3UploadId, i + 1),
    })),
  );
  return {
    id: input.id,
    partSize: UPLOAD_PART_SIZE,
    parts,
    expiresAt: iso(new Date(Date.now() + UPLOAD_TTL_MS)),
  };
}

async function attachmentOf(db: DbOrTx, itemId: string, attachmentId: string) {
  const [row] = await db
    .select({ att: vaultAttachments, storageKey: blobs.storageKey })
    .from(vaultAttachments)
    .innerJoin(blobs, eq(blobs.id, vaultAttachments.blobId))
    .where(and(eq(vaultAttachments.id, attachmentId), eq(vaultAttachments.itemId, itemId)));
  if (!row) throw new AppError('not_found');
  return row;
}

export async function completeAttachment(
  deps: Deps,
  a: VaultActor,
  itemId: string,
  attachmentId: string,
  parts: { partNumber: number; etag: string }[],
): Promise<VaultAttachment> {
  const storage = requireStorage(deps);
  const { db } = deps;
  const { access } = await itemAccess(db, a, itemId);
  requireVault(access, 'vault.edit');
  const { att, storageKey } = await attachmentOf(db, itemId, attachmentId);
  if (att.status === 'ready') return { id: att.id, size: att.size, createdAt: iso(att.createdAt) };
  if (!att.s3UploadId) throw new AppError('upload_invalid');
  await storage.completeMultipart(storageKey, att.s3UploadId, parts);
  const head = await storage.head(storageKey);
  if (!head || head.size !== att.size) {
    await storage.delete(storageKey).catch(() => undefined);
    throw new AppError('upload_invalid', { reason: 'size_mismatch' });
  }
  await db.transaction(async (tx) => {
    await tx.update(blobs).set({ status: 'ready' }).where(eq(blobs.id, att.blobId));
    await retainBlob(tx, att.blobId);
    await tx
      .update(vaultAttachments)
      .set({ status: 'ready', s3UploadId: null })
      .where(eq(vaultAttachments.id, att.id));
    if (att.spaceId) await adjustSpaceBytes(tx, att.spaceId, att.size);
    await bumpVault(tx, att.vaultId);
  });
  return { id: att.id, size: att.size, createdAt: iso(att.createdAt) };
}

export async function attachmentUrl(
  deps: Deps,
  a: VaultActor,
  itemId: string,
  attachmentId: string,
) {
  const storage = requireStorage(deps);
  const { item } = await itemAccess(deps.db, a, itemId);
  const { att, storageKey } = await attachmentOf(deps.db, itemId, attachmentId);
  if (att.status !== 'ready') throw new AppError('not_found');
  const signed = await storage.presignGet(storageKey, {
    fileName: `${att.id}.bin`,
    contentType: 'application/octet-stream',
  });
  await logEvent(deps.db, a, {
    action: 'item.download',
    vaultId: item.vaultId,
    itemId,
    field: 'attachment',
    meta: { attachmentId },
  });
  return { url: signed.url, expiresAt: iso(signed.expiresAt) };
}

export async function deleteAttachment(
  deps: Deps,
  a: VaultActor,
  itemId: string,
  attachmentId: string,
) {
  const { db } = deps;
  const { access } = await itemAccess(db, a, itemId);
  requireVault(access, 'vault.edit');
  const { att, storageKey } = await attachmentOf(db, itemId, attachmentId);
  if (att.status === 'uploading' && att.s3UploadId && deps.storage) {
    await deps.storage.abortMultipart(storageKey, att.s3UploadId).catch(() => undefined);
  }
  await db.transaction(async (tx) => {
    await releaseAttachments(tx, [att]);
    await tx.delete(vaultAttachments).where(eq(vaultAttachments.id, att.id));
    await bumpVault(tx, att.vaultId);
  });
}

/**
 * Lets go of attachment blobs before their rows are deleted: ready blobs lose their reference
 * (the nightly purge removes orphaned objects), unfinished ones are orphaned right away.
 */
export async function releaseAttachments(db: DbOrTx, rows: AttachmentRow[]) {
  for (const att of rows) {
    if (att.status === 'ready') {
      await releaseBlob(db, att.blobId);
      if (att.spaceId) await adjustSpaceBytes(db, att.spaceId, -att.size);
    } else {
      await db.update(blobs).set({ orphanedAt: new Date() }).where(eq(blobs.id, att.blobId));
    }
  }
}

/** Attachments follow a moved item; quota moves to the target vault's space. */
export async function moveAttachments(
  db: DbOrTx,
  _a: VaultActor,
  fromItemId: string,
  _fromVaultId: string,
  toItemId: string,
  target: VaultRow,
) {
  const rows = await db
    .select()
    .from(vaultAttachments)
    .where(eq(vaultAttachments.itemId, fromItemId));
  if (!rows.length) return;
  const spaceId = await quotaSpaceId(db, target);
  for (const att of rows) {
    if (att.status === 'ready' && att.spaceId !== spaceId) {
      if (att.spaceId) await adjustSpaceBytes(db, att.spaceId, -att.size);
      if (spaceId) await adjustSpaceBytes(db, spaceId, att.size);
    }
  }
  await db
    .update(vaultAttachments)
    .set({ itemId: toItemId, vaultId: target.id, spaceId })
    .where(
      inArray(
        vaultAttachments.id,
        rows.map((r) => r.id),
      ),
    );
}
