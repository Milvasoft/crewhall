import { eq } from 'drizzle-orm';
import { blobs, newId, nodes, nodeVersions } from '@crewhall/db';
import { resources } from '@crewhall/i18n';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { loadNode, loadSpace, requireNodeAction, type DriveActor } from '../drive/access';
import { requireStorage } from '../drive/files';
import { assertQuota, orgLimits } from '../drive/quota';
import { adjustSpaceBytes, childPath, freeName, positionIn } from '../drive/tree';
import { ensureFolder } from '../portal/nodes';
import { ensurePersonalSpace } from '../spaces';

/**
 * Mail and Drive: a Drive file can be attached to an outgoing message (the sender must be
 * able to view it), and an incoming attachment can be saved as a Drive file (the user must be
 * able to add files to the target space). Saved files go through blob.process like uploads.
 */

export async function readDriveFile(
  deps: Pick<Deps, 'db' | 'storage'>,
  a: DriveActor,
  nodeId: string,
): Promise<{ filename: string; contentType: string; content: Buffer }> {
  const { node } = await loadNode(deps.db, a, nodeId);
  if (node.type !== 'file' || !node.currentVersionId) throw new AppError('invalid_target');
  const [row] = await deps.db
    .select({ blob: blobs })
    .from(nodeVersions)
    .innerJoin(blobs, eq(blobs.id, nodeVersions.blobId))
    .where(eq(nodeVersions.id, node.currentVersionId));
  // Quarantined files are not handed out; vault-encrypted blobs are useless to the recipient.
  if (!row || row.blob.status === 'quarantined' || row.blob.encrypted) {
    throw new AppError('invalid_target');
  }
  const stream = await requireStorage(deps).getStream(row.blob.storageKey);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return {
    filename: node.name,
    contentType: node.mime ?? row.blob.mime ?? 'application/octet-stream',
    content: Buffer.concat(chunks),
  };
}

const folderName = (locale: 'tr' | 'en') => resources[locale].email.mail.folders.attachments;

export async function saveToDrive(
  deps: Pick<Deps, 'db' | 'storage' | 'jobs'>,
  a: DriveActor & { userName: string },
  file: { filename: string; contentType: string; content: Buffer },
  target: { spaceId?: string | undefined; parentId?: string | null | undefined },
): Promise<{ nodeId: string; spaceId: string; name: string }> {
  const { db } = deps;
  const storage = requireStorage(deps);
  const size = file.content.length;
  if (size > orgLimits(a.org).maxFileBytes) throw new AppError('file_too_large');

  const spaceId =
    target.spaceId ??
    (await ensurePersonalSpace(db, a.org.id, { id: a.userId, name: a.userName })).id;
  const { space, role } = await loadSpace(db, a, spaceId);
  let parentId = target.parentId ?? null;
  if (parentId) {
    const parent = await loadNode(db, a, parentId);
    if (parent.node.spaceId !== space.id || parent.node.type !== 'folder') {
      throw new AppError('invalid_target');
    }
    requireNodeAction(a, parent.role, 'space.edit_content');
  } else {
    requireNodeAction(a, role, 'space.edit_content');
  }
  await assertQuota(db, a.org, space, size);

  const blobId = newId();
  const storageKey = `orgs/${a.org.id}/blobs/${blobId}`;
  await storage.put(storageKey, file.content, file.contentType);

  const saved = await db.transaction(async (tx) => {
    if (!parentId && target.spaceId === undefined) {
      parentId = await ensureFolder(tx, {
        orgId: a.org.id,
        spaceId,
        parentId: null,
        name: folderName(a.org.branding.defaultLocale),
        userId: a.userId,
      });
    }
    const [parent] = parentId
      ? await tx.select({ path: nodes.path }).from(nodes).where(eq(nodes.id, parentId))
      : [];
    await tx.insert(blobs).values({
      id: blobId,
      orgId: a.org.id,
      size,
      mime: file.contentType,
      storageKey,
      status: 'pending',
      refCount: 1,
    });
    const name = await freeName(tx, spaceId, parentId, file.filename.slice(0, 255));
    const nodeId = newId();
    await tx.insert(nodes).values({
      id: nodeId,
      orgId: a.org.id,
      spaceId,
      parentId,
      type: 'file',
      name,
      mime: file.contentType,
      sizeBytes: size,
      position: await positionIn(tx, spaceId, parentId),
      path: childPath(parent?.path ?? null, nodeId),
      createdBy: a.userId,
      updatedBy: a.userId,
    });
    const [version] = await tx
      .insert(nodeVersions)
      .values({
        orgId: a.org.id,
        nodeId,
        version: 1,
        blobId,
        sizeBytes: size,
        mime: file.contentType,
        source: 'api',
        createdBy: a.userId,
      })
      .returning();
    await tx.update(nodes).set({ currentVersionId: version!.id }).where(eq(nodes.id, nodeId));
    await adjustSpaceBytes(tx, spaceId, size);
    return { nodeId, spaceId, name };
  });
  await deps.jobs.send('blob.process', { blobId });
  return saved;
}
