import { createHash } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  blobDerivatives,
  blobs,
  drawingFiles,
  drawingLibraries,
  drawings,
  newId,
  nodes,
  type DbOrTx,
} from '@crewhall/db';
import type { AppLocale } from '@crewhall/i18n';
import { resources } from '@crewhall/i18n';
import {
  BOARD_LIMITS,
  LibraryItem,
  type Drawing,
  type DrawingLibrary,
  type DrawingSummary,
  type SpaceRole,
} from '@crewhall/shared';
import { fileTypeFromBuffer } from 'file-type';
import * as Y from 'yjs';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import type { Jobs } from '../../jobs/queue';
import type { Storage } from '../../storage/s3';
import { audit } from '../audit';
import { loadSpace, requireNodeAction, type DriveActor } from '../drive/access';
import { container } from '../drive/nodes';
import { childPath, freeName, nameTakenFrom, positionIn } from '../drive/tree';
import { atLeast, loadDrawing, requireRole, userSummaries, type DrawingRow } from './access';
import { integrations, withBoardEvents } from './integrations';
import type { Bus } from '../../realtime/bus';
import { docFrom, encode, liveCount, mergeElements, sceneElements, type Element } from './ydoc';

type Access = Awaited<ReturnType<typeof loadDrawing>>;

async function toDrawing(db: DbOrTx, access: Access): Promise<Drawing> {
  const { node, space, drawing, role } = access;
  const files = await db
    .select({
      fileId: drawingFiles.fileId,
      mime: drawingFiles.mime,
      size: blobs.size,
      createdAt: drawingFiles.createdAt,
    })
    .from(drawingFiles)
    .innerJoin(blobs, eq(blobs.id, drawingFiles.blobId))
    .where(eq(drawingFiles.nodeId, node.id))
    .orderBy(asc(drawingFiles.createdAt));
  const people = await userSummaries(db, [node.createdBy, node.updatedBy]);
  return {
    id: node.id,
    spaceId: node.spaceId,
    parentId: node.parentId,
    name: node.name,
    myRole: (role ?? 'viewer') as SpaceRole,
    sceneRev: drawing.sceneRev,
    elementCount: drawing.elementCount,
    thumbnail: {
      ready: drawing.thumbnailBlobId !== null,
      rev: drawing.thumbnailRev,
    },
    files: files.map((f) => ({
      fileId: f.fileId,
      mime: f.mime,
      sizeBytes: f.size,
      createdAt: f.createdAt.toISOString(),
    })),
    space: { id: space.id, name: space.name, slug: space.slug, color: space.color },
    createdBy: node.createdBy ? (people.get(node.createdBy) ?? null) : null,
    updatedBy: node.updatedBy ? (people.get(node.updatedBy) ?? null) : null,
    createdAt: node.createdAt.toISOString(),
    updatedAt: node.updatedAt.toISOString(),
  };
}

export async function createDrawing(
  db: DbOrTx,
  a: DriveActor,
  spaceId: string,
  input: { parentId: string | null; name: string },
  locale: AppLocale,
  req: RequestInfo,
): Promise<Drawing> {
  const { space, parent, role } = await container(db, a, spaceId, input.parentId);
  requireNodeAction(a, role, 'space.edit_content');
  if (space.archivedAt) throw new AppError('forbidden', { reason: 'archived' });
  // "Başlıksız çizim", "Başlıksız çizim (2)"…: a new drawing never fails on its name.
  const name = await freeName(
    db,
    space.id,
    parent?.id ?? null,
    input.name || resources[locale].email.boards.untitledDrawing,
  );
  const id = newId();
  await db
    .insert(nodes)
    .values({
      id,
      orgId: a.org.id,
      spaceId: space.id,
      parentId: parent?.id ?? null,
      type: 'drawing',
      name,
      position: await positionIn(db, space.id, parent?.id ?? null),
      path: childPath(parent?.path ?? null, id),
      createdBy: a.userId,
      updatedBy: a.userId,
    })
    .catch(nameTakenFrom);
  await db.insert(drawings).values({ nodeId: id, orgId: a.org.id, ydoc: encode(new Y.Doc()) });
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'drawing.create',
      targetType: 'node',
      targetId: id,
      meta: { spaceId: space.id },
    },
    req,
  );
  return toDrawing(db, await loadDrawing(db, a, id));
}

export async function listDrawings(db: DbOrTx, a: DriveActor, spaceId: string) {
  const { role } = await loadSpace(db, a, spaceId);
  requireNodeAction(a, role, 'space.view');
  const rows = await db
    .select({ node: nodes, drawing: drawings })
    .from(nodes)
    .innerJoin(drawings, eq(drawings.nodeId, nodes.id))
    .where(and(eq(nodes.spaceId, spaceId), eq(nodes.type, 'drawing'), isNull(nodes.deletedAt)))
    .orderBy(sql`${nodes.updatedAt} desc`);
  const items: DrawingSummary[] = rows.map((r) => ({
    id: r.node.id,
    spaceId: r.node.spaceId,
    parentId: r.node.parentId,
    name: r.node.name,
    elementCount: r.drawing.elementCount,
    thumbnailReady: r.drawing.thumbnailBlobId !== null,
    updatedAt: r.node.updatedAt.toISOString(),
  }));
  return { items };
}

export async function getDrawing(db: DbOrTx, a: DriveActor, nodeId: string) {
  return toDrawing(db, await loadDrawing(db, a, nodeId));
}

export async function getScene(db: DbOrTx, a: DriveActor, nodeId: string) {
  const { drawing } = await loadDrawing(db, a, nodeId);
  return {
    elements: sceneElements(docFrom(drawing.ydoc), { includeDeleted: false }),
    sceneRev: drawing.sceneRev,
  };
}

/**
 * Stores a new scene state (collab store or HTTP write): bumps scene_rev, the element
 * count and the node's updated_at, and queues the thumbnail.
 */
export async function storeScene(
  ctx: { db: DbOrTx; jobs: Jobs | null },
  row: DrawingRow,
  doc: Y.Doc,
  userId: string | null,
) {
  const [updated] = await ctx.db
    .update(drawings)
    .set({
      ydoc: encode(doc),
      sceneRev: sql`${drawings.sceneRev} + 1`,
      elementCount: liveCount(doc),
    })
    .where(eq(drawings.nodeId, row.nodeId))
    .returning();
  await ctx.db
    .update(nodes)
    .set({ updatedAt: new Date(), ...(userId ? { updatedBy: userId } : {}) })
    .where(eq(nodes.id, row.nodeId));
  scheduleThumbnail(ctx.jobs, row.nodeId);
  return updated!;
}

/** Throttled thumbnail queueing: at most every 15 s per drawing, the last change always lands. */
const pending = new Map<string, { last: number; timer: NodeJS.Timeout | null }>();
const THUMB_EVERY_MS = 15_000;

export function scheduleThumbnail(jobs: Jobs | null, nodeId: string) {
  if (!jobs) return;
  const now = Date.now();
  const p = pending.get(nodeId) ?? { last: 0, timer: null };
  pending.set(nodeId, p);
  const send = () => {
    p.last = Date.now();
    p.timer = null;
    void jobs.send('drawing.thumbnail', { nodeId }).catch(() => undefined);
  };
  if (now - p.last >= THUMB_EVERY_MS && !p.timer) return send();
  if (!p.timer) {
    p.timer = setTimeout(send, Math.max(0, THUMB_EVERY_MS - (now - p.last)));
    p.timer.unref?.();
  }
}

export async function saveScene(
  deps: Pick<Deps, 'db' | 'jobs'> & { bus?: Bus | null },
  a: DriveActor,
  nodeId: string,
  elements: Element[],
) {
  return withBoardEvents({ db: deps.db, bus: deps.bus }, async (tx) => {
    const access = await loadDrawing(tx, a, nodeId);
    requireRole(a, access.role, 'edit');
    const [locked] = await tx
      .select()
      .from(drawings)
      .where(eq(drawings.nodeId, nodeId))
      .for('update');
    const doc = docFrom(locked!.ydoc);
    const changed = mergeElements(doc, elements);
    if (changed === 0) return { elements: sceneElements(doc), sceneRev: locked!.sceneRev };
    const row = await storeScene({ db: tx, jobs: deps.jobs }, locked!, doc, a.userId);
    integrations().publish(
      { type: 'drawing.thumbnail', nodeId, rev: row.thumbnailRev },
      { orgId: a.org.id, spaceId: access.space.id, nodeId },
    );
    return { elements: sceneElements(doc), sceneRev: row.sceneRev };
  });
}

/* ----------------------------------- files ----------------------------------- */

const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function requireStorage(storage: Storage | null): Storage {
  if (!storage) throw new AppError('internal', { reason: 'storage_not_configured' });
  return storage;
}

/**
 * Stores an image of the scene. Same bytes in the org reuse one blob (refcounted);
 * the same file id twice is a no-op, as Excalidraw re-sends files freely.
 */
export async function uploadFile(
  deps: Pick<Deps, 'db' | 'storage'>,
  a: DriveActor,
  nodeId: string,
  input: { fileId: string; dataURL: string },
) {
  const { db } = deps;
  const access = await loadDrawing(db, a, nodeId);
  requireRole(a, access.role, 'edit');
  const [existing] = await db
    .select({ f: drawingFiles, size: blobs.size })
    .from(drawingFiles)
    .innerJoin(blobs, eq(blobs.id, drawingFiles.blobId))
    .where(and(eq(drawingFiles.nodeId, nodeId), eq(drawingFiles.fileId, input.fileId)));
  if (existing) {
    return {
      fileId: existing.f.fileId,
      mime: existing.f.mime,
      sizeBytes: existing.size,
      createdAt: existing.f.createdAt.toISOString(),
    };
  }
  const m = /^data:([a-z0-9.+/-]+);base64,(.*)$/i.exec(input.dataURL);
  if (!m) throw new AppError('drawing_file_invalid');
  const declared = m[1]!.toLowerCase();
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length === 0) throw new AppError('drawing_file_invalid');
  if (bytes.length > BOARD_LIMITS.drawingFileBytes) throw new AppError('drawing_file_too_large');
  let mime: string;
  if (declared === 'image/svg+xml') {
    if (!/<svg[\s>]/i.test(bytes.subarray(0, 4096).toString('utf8'))) {
      throw new AppError('drawing_file_invalid');
    }
    mime = declared;
  } else {
    const detected = (await fileTypeFromBuffer(bytes))?.mime;
    if (!detected || !RASTER.has(detected)) throw new AppError('drawing_file_invalid');
    mime = detected;
  }
  const storage = requireStorage(deps.storage);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  return db.transaction(async (tx) => {
    const [same] = await tx
      .select()
      .from(blobs)
      .where(
        and(
          eq(blobs.orgId, a.org.id),
          eq(blobs.sha256, sha256),
          eq(blobs.status, 'ready'),
          eq(blobs.encrypted, false),
        ),
      );
    let blobId: string;
    if (same) {
      blobId = same.id;
      await tx
        .update(blobs)
        .set({ refCount: sql`${blobs.refCount} + 1`, orphanedAt: null })
        .where(eq(blobs.id, same.id));
    } else {
      blobId = newId();
      const storageKey = `orgs/${a.org.id}/blobs/${blobId}`;
      await storage.put(storageKey, bytes, mime);
      await tx.insert(blobs).values({
        id: blobId,
        orgId: a.org.id,
        sha256,
        size: bytes.length,
        mime,
        storageKey,
        status: 'ready',
        refCount: 1,
      });
    }
    const [row] = await tx
      .insert(drawingFiles)
      .values({ nodeId, fileId: input.fileId, orgId: a.org.id, blobId, mime, createdBy: a.userId })
      .returning();
    return {
      fileId: row!.fileId,
      mime: row!.mime,
      sizeBytes: bytes.length,
      createdAt: row!.createdAt.toISOString(),
    };
  });
}

export async function fileUrl(
  deps: Pick<Deps, 'db' | 'storage'>,
  a: DriveActor,
  nodeId: string,
  fileId: string,
) {
  await loadDrawing(deps.db, a, nodeId);
  const [row] = await deps.db
    .select({ f: drawingFiles, blob: blobs })
    .from(drawingFiles)
    .innerJoin(blobs, eq(blobs.id, drawingFiles.blobId))
    .where(and(eq(drawingFiles.nodeId, nodeId), eq(drawingFiles.fileId, fileId)));
  if (!row) throw new AppError('not_found');
  const signed = await requireStorage(deps.storage).presignGet(row.blob.storageKey, {
    contentType: row.f.mime,
    // SVG never inline: it would run on the storage origin.
    inline: row.f.mime !== 'image/svg+xml',
  });
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString(), mime: row.f.mime };
}

export async function thumbnailUrl(
  deps: Pick<Deps, 'db' | 'storage'>,
  a: DriveActor,
  nodeId: string,
  kind: 'thumb_256' | 'thumb_1024',
) {
  const { drawing } = await loadDrawing(deps.db, a, nodeId);
  if (!drawing.thumbnailBlobId) throw new AppError('preview_unavailable');
  const [d] = await deps.db
    .select()
    .from(blobDerivatives)
    .where(
      and(eq(blobDerivatives.blobId, drawing.thumbnailBlobId), eq(blobDerivatives.kind, kind)),
    );
  if (!d) throw new AppError('preview_unavailable');
  const signed = await requireStorage(deps.storage).presignGet(d.storageKey, {
    contentType: d.mime,
    inline: true,
  });
  return signed.url;
}

/* ---------------------------------- library ---------------------------------- */

async function libraryOf(db: DbOrTx, orgId: string, ownerType: 'user' | 'space', ownerId: string) {
  const [row] = await db
    .select()
    .from(drawingLibraries)
    .where(
      and(
        eq(drawingLibraries.orgId, orgId),
        eq(drawingLibraries.ownerType, ownerType),
        eq(drawingLibraries.ownerId, ownerId),
      ),
    );
  return (row?.items ?? [])
    .map((i) => LibraryItem.safeParse(i))
    .filter((r) => r.success)
    .map((r) => r.data);
}

export async function getLibrary(
  db: DbOrTx,
  a: DriveActor,
  spaceId: string | undefined,
): Promise<DrawingLibrary> {
  const personal = await libraryOf(db, a.org.id, 'user', a.userId);
  if (!spaceId) return { personal, space: null, canEditSpace: false };
  const { role } = await loadSpace(db, a, spaceId);
  requireNodeAction(a, role, 'space.view');
  return {
    personal,
    space: await libraryOf(db, a.org.id, 'space', spaceId),
    canEditSpace: atLeast(role, 'editor'),
  };
}

export async function updateLibrary(
  db: DbOrTx,
  a: DriveActor,
  input: { scope: 'personal' | 'space'; spaceId?: string | undefined; items: LibraryItem[] },
) {
  let ownerId = a.userId;
  if (input.scope === 'space') {
    if (!input.spaceId) throw new AppError('validation_failed', { field: 'spaceId' });
    const { role } = await loadSpace(db, a, input.spaceId);
    requireNodeAction(a, role, 'space.edit_content');
    ownerId = input.spaceId;
  }
  const ownerType = input.scope === 'space' ? 'space' : 'user';
  await db
    .insert(drawingLibraries)
    .values({ orgId: a.org.id, ownerType, ownerId, items: input.items, updatedBy: a.userId })
    .onConflictDoUpdate({
      target: [drawingLibraries.orgId, drawingLibraries.ownerType, drawingLibraries.ownerId],
      set: { items: input.items, updatedBy: a.userId, updatedAt: new Date() },
    });
  return getLibrary(db, a, input.spaceId);
}
