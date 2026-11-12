import { newId } from '@crewhall/db';
import { resources } from '@crewhall/i18n';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { loadNode, loadSpace, requireNodeAction, type DriveActor } from '../drive/access';
import { commitFile, requireStorage } from '../drive/files';
import { assertQuota, orgLimits } from '../drive/quota';
import { ensureFolder } from '../portal/nodes';
import { ensurePersonalSpace } from '../spaces';

/**
 * Bytes the integrations bring in (Outlook attachments, upload requests, mount copies) become
 * Drive files the same way uploads do: quota, store, commit, then blob.process (preview, scan).
 */

export type StoreDeps = Pick<Deps, 'db' | 'storage' | 'jobs'>;

/** Where a write lands; checks the person may add files there. */
export async function writableTarget(
  deps: Pick<Deps, 'db'>,
  a: DriveActor,
  spaceId: string,
  parentId: string | null,
) {
  const { space, role } = await loadSpace(deps.db, a, spaceId);
  if (space.archivedAt) throw new AppError('forbidden', { reason: 'archived' });
  if (parentId) {
    const parent = await loadNode(deps.db, a, parentId);
    if (parent.node.spaceId !== space.id || parent.node.type !== 'folder') {
      throw new AppError('invalid_target');
    }
    requireNodeAction(a, parent.role, 'space.edit_content');
  } else {
    requireNodeAction(a, role, 'space.edit_content');
  }
  return space;
}

export async function storeBytes(
  deps: StoreDeps,
  a: DriveActor,
  input: {
    spaceId: string;
    parentId: string | null;
    name: string;
    content: Buffer;
    mime: string | null;
  },
) {
  const space = await writableTarget(deps, a, input.spaceId, input.parentId);
  const size = input.content.length;
  const { maxFileBytes } = orgLimits(a.org);
  if (size > maxFileBytes) throw new AppError('file_too_large', { maxFileBytes });
  await assertQuota(deps.db, a.org, space, size);
  const storage = requireStorage(deps);
  const storageKey = `orgs/${a.org.id}/blobs/${newId()}`;
  const mime = input.mime || 'application/octet-stream';
  await storage.put(storageKey, input.content, mime);
  const committed = await deps.db
    .transaction((tx) =>
      commitFile(tx, a, {
        spaceId: space.id,
        parentId: input.parentId,
        nodeId: null,
        name: input.name.slice(0, 255),
        storageKey,
        sizeBytes: size,
        mime,
        source: 'api',
        replace: false,
      }),
    )
    .catch(async (err: unknown) => {
      await storage.delete(storageKey).catch(() => undefined);
      throw err;
    });
  await deps.jobs.send('blob.process', { blobId: committed.blobId });
  return { nodeId: committed.nodeId, spaceId: space.id };
}

/** The person's personal space and a folder in it by name (created on first use). */
export async function personalFolder(
  deps: Pick<Deps, 'db'>,
  a: DriveActor & { userName: string },
  name: string,
) {
  const space = await ensurePersonalSpace(deps.db, a.org.id, { id: a.userId, name: a.userName });
  const folderId = await ensureFolder(deps.db, {
    orgId: a.org.id,
    spaceId: space.id,
    parentId: null,
    name,
    userId: a.userId,
  });
  return { spaceId: space.id, folderId };
}

export const attachmentsFolderName = (locale: 'tr' | 'en') =>
  resources[locale].email.microsoft.folders.attachments;
