import { and, desc, eq, ne, sql } from 'drizzle-orm';
import {
  blobDerivatives,
  blobs,
  drawings,
  newId,
  nodes,
  nodeUserState,
  nodeVersions,
  uploads,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  isInlineSafe,
  UPLOAD_PART_SIZE,
  type Disposition,
  type CreateUpload,
  type DriveNode,
  type NodeVersion,
  type PreviewKind,
  type Upload,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { Storage } from '../../storage/s3';
import { loadNode, requireNodeAction, toDriveNodes, type DriveActor } from './access';
import { container } from './nodes';
import { assertQuota, orgLimits } from './quota';
import {
  adjustSpaceBytes,
  childPath,
  findByName,
  freeName,
  nameTakenFrom,
  positionIn,
  releaseBlob,
  retainBlob,
} from './tree';

/** Resume window for an unfinished upload. */
const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Versions kept per file (design 3.8); older ones are dropped. */
const MAX_VERSIONS = 50;

export function requireStorage(deps: Pick<Deps, 'storage'>): Storage {
  if (!deps.storage) throw new AppError('internal', { reason: 'storage_not_configured' });
  return deps.storage;
}

type UploadRow = typeof uploads.$inferSelect;

function toUpload(row: UploadRow, parts: Upload['uploadedParts']): Upload {
  return {
    id: row.id,
    spaceId: row.spaceId,
    parentId: row.parentId,
    nodeId: row.nodeId,
    name: row.name,
    sizeBytes: row.sizeBytes,
    partSize: row.partSize,
    partCount: row.partCount,
    status: row.status,
    uploadedParts: parts,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Starts a resumable upload (doc 17 §8 steps 1-2): rights, file size and quota are
 * checked here and the size is reserved until the upload completes or expires.
 */
export async function createUpload(
  deps: Deps,
  a: DriveActor,
  input: CreateUpload,
  source: 'web' | 'mobile' | 'mcp' | 'api' = 'web',
): Promise<Upload> {
  const storage = requireStorage(deps);
  const { db } = deps;
  const { maxFileBytes } = orgLimits(a.org);
  if (input.sizeBytes > maxFileBytes) throw new AppError('file_too_large', { maxFileBytes });

  let name = input.name;
  let targetNodeId: string | null = null;
  let parentId = input.parentId;
  let onConflict = input.onConflict;
  let space;
  if (input.nodeId) {
    const access = await loadNode(db, a, input.nodeId);
    if (access.node.type !== 'file') throw new AppError('invalid_target', { reason: 'not_a_file' });
    requireNodeAction(a, access.role, 'space.edit_content');
    space = access.space;
    targetNodeId = access.node.id;
    parentId = access.node.parentId;
    name = access.node.name;
    if (onConflict === 'ask') onConflict = 'version';
    // Fail early; completeUpload checks again under the row lock.
    await assertBaseVersion(db, access.node, input.baseVersion ?? null);
  } else {
    const dest = await container(db, a, input.spaceId, input.parentId);
    requireNodeAction(a, dest.role, 'space.edit_content');
    space = dest.space;
    const existing = await findByName(db, space.id, parentId, name);
    if (existing) {
      if (onConflict === 'ask' || (existing.type !== 'file' && onConflict !== 'rename')) {
        throw new AppError('node_name_taken', { nodeId: existing.id });
      }
      if (onConflict === 'rename') name = await freeName(db, space.id, parentId, name);
      else targetNodeId = existing.id;
    }
  }
  if (space.archivedAt) throw new AppError('forbidden', { reason: 'archived' });
  await assertQuota(db, a.org, space, input.sizeBytes);

  const storageKey = `orgs/${a.org.id}/blobs/${newId()}`;
  const s3UploadId = await storage.createMultipart(storageKey, input.mime);
  const partCount = Math.max(1, Math.ceil(input.sizeBytes / UPLOAD_PART_SIZE));
  const [row] = await db
    .insert(uploads)
    .values({
      orgId: a.org.id,
      spaceId: space.id,
      parentId,
      nodeId: targetNodeId,
      userId: a.userId,
      name,
      sizeBytes: input.sizeBytes,
      mime: input.mime ?? null,
      onConflict,
      baseVersion: targetNodeId ? (input.baseVersion ?? null) : null,
      source,
      storageKey,
      s3UploadId,
      partSize: UPLOAD_PART_SIZE,
      partCount,
      expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
    })
    .returning();
  return toUpload(row!, []);
}

async function ownUpload(db: DbOrTx, a: DriveActor, uploadId: string) {
  const [row] = await db
    .select()
    .from(uploads)
    .where(
      and(eq(uploads.id, uploadId), eq(uploads.orgId, a.org.id), eq(uploads.userId, a.userId)),
    );
  if (!row) throw new AppError('not_found');
  return row;
}

function liveUpload(row: UploadRow) {
  if (row.status !== 'uploading' || row.expiresAt.getTime() <= Date.now()) {
    throw new AppError('upload_invalid', { reason: 'not_uploading', status: row.status });
  }
}

/** Resume (design 3.7): the parts the store already holds. */
export async function getUpload(deps: Deps, a: DriveActor, uploadId: string) {
  const row = await ownUpload(deps.db, a, uploadId);
  const parts =
    row.status === 'uploading'
      ? (await requireStorage(deps).listParts(row.storageKey, row.s3UploadId)).map((p) => ({
          partNumber: p.partNumber,
          sizeBytes: p.size,
          etag: p.etag,
        }))
      : [];
  return toUpload(row, parts);
}

export async function partUrls(deps: Deps, a: DriveActor, uploadId: string, partNumbers: number[]) {
  const storage = requireStorage(deps);
  const row = await ownUpload(deps.db, a, uploadId);
  liveUpload(row);
  const bad = partNumbers.find((n) => n > row.partCount);
  if (bad) throw new AppError('upload_invalid', { reason: 'part_out_of_range', partNumber: bad });
  const parts = [];
  for (const partNumber of [...new Set(partNumbers)]) {
    parts.push({
      partNumber,
      url: await storage.presignPart(row.storageKey, row.s3UploadId, partNumber),
    });
  }
  return { parts, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
}

export async function abortUpload(deps: Deps, a: DriveActor, uploadId: string) {
  const row = await ownUpload(deps.db, a, uploadId);
  if (row.status !== 'uploading') return;
  await requireStorage(deps)
    .abortMultipart(row.storageKey, row.s3UploadId)
    .catch(() => undefined);
  await deps.db.update(uploads).set({ status: 'aborted' }).where(eq(uploads.id, row.id));
}

async function versionOut(
  db: DbOrTx,
  v: typeof nodeVersions.$inferSelect,
  currentId: string | null,
) {
  const [u] = v.createdBy
    ? await db
        .select({ id: users.id, name: users.name, email: users.email, image: users.image })
        .from(users)
        .where(eq(users.id, v.createdBy))
    : [];
  return toVersion(v, currentId, u ?? null);
}

function toVersion(
  v: typeof nodeVersions.$inferSelect,
  currentId: string | null,
  u: { id: string; name: string; email: string; image: string | null } | null,
): NodeVersion {
  return {
    id: v.id,
    version: v.version,
    sizeBytes: v.sizeBytes,
    mime: v.mime,
    label: v.label,
    source: v.source,
    current: v.id === currentId,
    createdBy: u ? { id: u.id, name: u.name, email: u.email, imageUrl: u.image } : null,
    createdAt: v.createdAt.toISOString(),
  };
}

/** Adds a version on top of a file and makes it current; trims beyond 50 versions. */
async function addVersion(
  db: DbOrTx,
  node: typeof nodes.$inferSelect,
  version: {
    blobId: string;
    sizeBytes: number;
    mime: string | null;
    source: 'web' | 'mobile' | 'mcp' | 'api';
  },
  userId: string,
) {
  const [last] = await db
    .select({ n: sql<number>`coalesce(max(${nodeVersions.version}), 0)::int` })
    .from(nodeVersions)
    .where(eq(nodeVersions.nodeId, node.id));
  const [row] = await db
    .insert(nodeVersions)
    .values({
      orgId: node.orgId,
      nodeId: node.id,
      version: (last?.n ?? 0) + 1,
      blobId: version.blobId,
      sizeBytes: version.sizeBytes,
      mime: version.mime,
      source: version.source,
      createdBy: userId,
    })
    .returning();
  await db
    .update(nodes)
    .set({
      currentVersionId: row!.id,
      sizeBytes: version.sizeBytes,
      mime: version.mime,
      updatedBy: userId,
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, node.id));
  await adjustSpaceBytes(db, node.spaceId, version.sizeBytes);

  const old = await db
    .select()
    .from(nodeVersions)
    .where(eq(nodeVersions.nodeId, node.id))
    .orderBy(desc(nodeVersions.version))
    .offset(MAX_VERSIONS);
  if (old.length) await dropVersions(db, node.spaceId, old);
  return row!;
}

async function dropVersions(
  db: DbOrTx,
  spaceId: string,
  rows: (typeof nodeVersions.$inferSelect)[],
) {
  for (const v of rows) {
    await db.delete(nodeVersions).where(eq(nodeVersions.id, v.id));
    if (v.blobId) await releaseBlob(db, v.blobId);
    await adjustSpaceBytes(db, spaceId, -v.sizeBytes);
  }
}

export type VersionSourceValue = 'web' | 'mobile' | 'mcp' | 'api';

/** Bytes already in the store, to become a file or the file's next version. */
export interface StoredFile {
  spaceId: string;
  parentId: string | null;
  /** Existing file for a new version; null creates a file (free name on a clash). */
  nodeId: string | null;
  name: string;
  storageKey: string;
  sizeBytes: number;
  mime: string | null;
  source: VersionSourceValue;
  /** Drop the older versions (3.14 "Değiştir"); numbering goes on. */
  replace: boolean;
  /** With nodeId: write only while the file is still at this version (version_conflict). */
  baseVersion?: number | null;
}

/** Number of the file's current version; 0 for a file without content. */
export async function currentVersionNumber(
  db: DbOrTx,
  node: Pick<typeof nodes.$inferSelect, 'currentVersionId'>,
) {
  if (!node.currentVersionId) return 0;
  const [v] = await db
    .select({ version: nodeVersions.version })
    .from(nodeVersions)
    .where(eq(nodeVersions.id, node.currentVersionId));
  return v?.version ?? 0;
}

/** Optimistic save: 409 version_conflict when the file moved past `baseVersion`. */
export async function assertBaseVersion(
  db: DbOrTx,
  node: Pick<typeof nodes.$inferSelect, 'currentVersionId'>,
  baseVersion: number | null,
) {
  if (baseVersion === null) return;
  const current = await currentVersionNumber(db, node);
  if (current !== baseVersion) {
    throw new AppError('version_conflict', { baseVersion, currentVersion: current });
  }
}

/**
 * The database half of an upload (doc 17 §8 step 4): a pending blob and the file or its
 * new version, inside the caller's transaction. blob.process takes over afterwards.
 */
export async function commitFile(tx: DbOrTx, a: DriveActor, input: StoredFile) {
  const [blob] = await tx
    .insert(blobs)
    .values({
      orgId: a.org.id,
      size: input.sizeBytes,
      mime: input.mime,
      storageKey: input.storageKey,
      status: 'pending',
      refCount: 1,
    })
    .returning();
  let nodeRow: typeof nodes.$inferSelect;
  if (input.nodeId) {
    const [existing] = await tx
      .select()
      .from(nodes)
      .where(eq(nodes.id, input.nodeId))
      .for('update');
    if (!existing || existing.deletedAt) throw new AppError('not_found');
    await assertBaseVersion(tx, existing, input.baseVersion ?? null);
    nodeRow = existing;
  } else {
    let name = input.name;
    const clash = await findByName(tx, input.spaceId, input.parentId, name);
    if (clash) name = await freeName(tx, input.spaceId, input.parentId, name);
    let parentPath: string | null = null;
    if (input.parentId) {
      const [parent] = await tx.select().from(nodes).where(eq(nodes.id, input.parentId));
      if (!parent || parent.deletedAt)
        throw new AppError('invalid_target', { reason: 'parent_gone' });
      parentPath = parent.path;
    }
    const id = newId();
    const [created] = await tx
      .insert(nodes)
      .values({
        id,
        orgId: a.org.id,
        spaceId: input.spaceId,
        parentId: input.parentId,
        type: 'file',
        name,
        mime: input.mime,
        sizeBytes: 0,
        position: await positionIn(tx, input.spaceId, input.parentId),
        path: childPath(parentPath, id),
        createdBy: a.userId,
        updatedBy: a.userId,
      })
      .returning()
      .catch(nameTakenFrom);
    nodeRow = created!;
  }
  const version = await addVersion(
    tx,
    nodeRow,
    { blobId: blob!.id, sizeBytes: input.sizeBytes, mime: input.mime, source: input.source },
    a.userId,
  );
  if (input.nodeId && input.replace) {
    const old = await tx
      .select()
      .from(nodeVersions)
      .where(and(eq(nodeVersions.nodeId, nodeRow.id), ne(nodeVersions.id, version.id)));
    await dropVersions(tx, nodeRow.spaceId, old);
  }
  return { blobId: blob!.id, nodeId: nodeRow.id, version };
}

/**
 * Puts the current content of `source` on top of `target` as a new version, sharing the
 * blob (WebDAV MOVE/COPY onto an existing file: the target keeps its history and shares).
 */
export async function versionFromFile(
  tx: DbOrTx,
  a: DriveActor,
  target: typeof nodes.$inferSelect,
  source: typeof nodes.$inferSelect,
  origin: VersionSourceValue,
) {
  if (!source.currentVersionId) throw new AppError('not_found');
  const [current] = await tx
    .select()
    .from(nodeVersions)
    .where(eq(nodeVersions.id, source.currentVersionId));
  if (!current?.blobId) throw new AppError('not_found');
  await retainBlob(tx, current.blobId);
  return addVersion(
    tx,
    target,
    { blobId: current.blobId, sizeBytes: current.sizeBytes, mime: current.mime, source: origin },
    a.userId,
  );
}

/**
 * Completes an upload (doc 17 §8 step 4): joins the parts, checks the stored size,
 * then creates the file or its new version and commits the quota. blob.process takes
 * over for hashing, dedup and previews.
 */
export async function completeUpload(
  deps: Deps,
  a: DriveActor,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
): Promise<{ node: DriveNode; version: NodeVersion }> {
  const storage = requireStorage(deps);
  const { db } = deps;
  const row = await ownUpload(db, a, uploadId);
  liveUpload(row);
  const numbers = new Set(parts.map((p) => p.partNumber));
  if (numbers.size !== row.partCount || [...numbers].some((n) => n < 1 || n > row.partCount)) {
    throw new AppError('upload_invalid', { reason: 'parts_mismatch', partCount: row.partCount });
  }
  try {
    await storage.completeMultipart(row.storageKey, row.s3UploadId, parts);
  } catch (err) {
    deps.logger.warn({ err, uploadId }, 'complete multipart failed');
    throw new AppError('upload_invalid', { reason: 'store_rejected_parts' });
  }
  const head = await storage.head(row.storageKey);
  if (!head || head.size !== row.sizeBytes) {
    await storage.delete(row.storageKey).catch(() => undefined);
    await db.update(uploads).set({ status: 'aborted' }).where(eq(uploads.id, row.id));
    throw new AppError('upload_invalid', {
      reason: 'size_mismatch',
      expected: row.sizeBytes,
      got: head?.size ?? null,
    });
  }

  const result = await db
    .transaction(async (tx) => {
      const committed = await commitFile(tx, a, {
        spaceId: row.spaceId,
        parentId: row.parentId,
        nodeId: row.nodeId,
        name: row.name,
        storageKey: row.storageKey,
        sizeBytes: row.sizeBytes,
        mime: row.mime,
        source: row.source,
        replace: row.onConflict === 'replace',
        baseVersion: row.baseVersion,
      });
      await tx
        .update(uploads)
        .set({ status: 'completed', nodeId: committed.nodeId, completedAt: new Date() })
        .where(eq(uploads.id, row.id));
      return committed;
    })
    .catch(async (err: unknown) => {
      // Someone saved in between: the bytes are not kept; the client asks and starts over.
      if (err instanceof AppError && err.code === 'version_conflict') {
        await storage.delete(row.storageKey).catch(() => undefined);
        await db.update(uploads).set({ status: 'aborted' }).where(eq(uploads.id, row.id));
      }
      throw err;
    });

  await deps.jobs.send('blob.process', { blobId: result.blobId });
  const access = await loadNode(db, a, result.nodeId);
  const [node] = await toDriveNodes(
    db,
    a.userId,
    [access.node],
    new Map([[access.node.id, access.role!]]),
  );
  const [fresh] = await db
    .select()
    .from(nodeVersions)
    .where(eq(nodeVersions.id, result.version.id));
  return {
    node: node!,
    version: await versionOut(db, fresh ?? result.version, access.node.currentVersionId),
  };
}

/* ----------------------------- download and preview ----------------------------- */

async function versionBlob(db: DbOrTx, versionId: string) {
  const [row] = await db
    .select({ version: nodeVersions, blob: blobs })
    .from(nodeVersions)
    .innerJoin(blobs, eq(blobs.id, nodeVersions.blobId))
    .where(eq(nodeVersions.id, versionId));
  return row ?? null;
}

/** 5-minute signed URL with the file name as Content-Disposition (doc 17 §8). */
export async function fileDownload(
  deps: Pick<Deps, 'db' | 'storage'>,
  node: typeof nodes.$inferSelect,
  versionId?: string,
  wanted: Disposition = 'attachment',
) {
  const storage = requireStorage(deps);
  if (node.type !== 'file') throw new AppError('bad_request', { reason: 'not_a_file' });
  const id = versionId ?? node.currentVersionId;
  if (!id) throw new AppError('not_found');
  const row = await versionBlob(deps.db, id);
  if (!row || row.version.nodeId !== node.id) throw new AppError('not_found');
  if (row.blob.status === 'quarantined') throw new AppError('forbidden', { reason: 'quarantined' });
  const mime = row.version.mime ?? row.blob.mime;
  // Inline only for types a browser shows without running anything (never HTML or SVG).
  const disposition: Disposition =
    wanted === 'inline' && isInlineSafe(mime) ? 'inline' : 'attachment';
  const signed = await storage.presignGet(row.blob.storageKey, {
    fileName: node.name,
    contentType: mime,
    inline: disposition === 'inline',
  });
  return {
    url: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
    fileName: node.name,
    sizeBytes: row.version.sizeBytes,
    mime,
    disposition,
  };
}

export async function filePreview(
  deps: Pick<Deps, 'db' | 'storage'>,
  node: typeof nodes.$inferSelect,
  kind: PreviewKind,
) {
  const storage = requireStorage(deps);
  let blobId: string | null = null;
  if (node.type === 'drawing') {
    // Drawings have no versions; the boards worker renders their thumbnail blob.
    const [d] = await deps.db
      .select({ blobId: drawings.thumbnailBlobId })
      .from(drawings)
      .where(eq(drawings.nodeId, node.id));
    blobId = d?.blobId ?? null;
  } else if (node.currentVersionId) {
    blobId = (await versionBlob(deps.db, node.currentVersionId))?.blob.id ?? null;
  }
  if (!blobId) throw new AppError('preview_unavailable');
  const [d] = await deps.db
    .select()
    .from(blobDerivatives)
    .where(and(eq(blobDerivatives.blobId, blobId), eq(blobDerivatives.kind, kind)));
  if (!d) throw new AppError('preview_unavailable');
  const signed = await storage.presignGet(d.storageKey, { contentType: d.mime, inline: true });
  return {
    url: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
    kind,
    width: d.width,
    height: d.height,
  };
}

export async function downloadUrl(
  deps: Deps,
  a: DriveActor,
  nodeId: string,
  versionId?: string,
  disposition?: Disposition,
) {
  const access = await loadNode(deps.db, a, nodeId);
  return fileDownload(deps, access.node, versionId, disposition);
}

export async function previewUrl(deps: Deps, a: DriveActor, nodeId: string, kind: PreviewKind) {
  const access = await loadNode(deps.db, a, nodeId);
  return filePreview(deps, access.node, kind);
}

/* ---------------------------------- versions ---------------------------------- */

export async function listVersions(db: DbOrTx, a: DriveActor, nodeId: string) {
  const access = await loadNode(db, a, nodeId);
  const rows = await db
    .select({ v: nodeVersions, u: users })
    .from(nodeVersions)
    .leftJoin(users, eq(users.id, nodeVersions.createdBy))
    .where(eq(nodeVersions.nodeId, nodeId))
    .orderBy(desc(nodeVersions.version));
  return rows.map((r) => toVersion(r.v, access.node.currentVersionId, r.u));
}

/** Copies an old version on top as a new one; history stays (3.8). */
export async function restoreVersion(deps: Deps, a: DriveActor, nodeId: string, versionId: string) {
  const { db } = deps;
  const access = await loadNode(db, a, nodeId);
  requireNodeAction(a, access.role, 'space.edit_content');
  const [old] = await db
    .select()
    .from(nodeVersions)
    .where(and(eq(nodeVersions.id, versionId), eq(nodeVersions.nodeId, nodeId)));
  if (!old || !old.blobId) throw new AppError('not_found');
  await assertQuota(db, a.org, access.space, old.sizeBytes);
  const blobId = old.blobId;
  const created = await db.transaction(async (tx) => {
    await retainBlob(tx, blobId);
    return addVersion(
      tx,
      access.node,
      { blobId, sizeBytes: old.sizeBytes, mime: old.mime, source: 'web' },
      a.userId,
    );
  });
  return versionOut(db, created, created.id);
}

/* ------------------------------- recent and favorites ------------------------------- */

export async function markOpened(db: DbOrTx, a: DriveActor, nodeId: string) {
  const access = await loadNode(db, a, nodeId);
  await db
    .insert(nodeUserState)
    .values({ userId: a.userId, nodeId, orgId: access.node.orgId, lastOpenedAt: new Date() })
    .onConflictDoUpdate({
      target: [nodeUserState.userId, nodeUserState.nodeId],
      set: { lastOpenedAt: new Date() },
    });
}
