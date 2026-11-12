import { and, asc, eq, inArray, isNull, max, ne, sql, type SQL } from 'drizzle-orm';
import { blobs, nodeLabel, nodes, nodeVersions, spaces, type DbOrTx } from '@crewhall/db';
import { AppError } from '../../http/errors';
import { keyBetween } from '../../util/position';
import type { NodeRow } from './access';

/** Postgres unique violation of the per-folder name index → node_name_taken. */
export function nameTakenFrom(err: unknown): never {
  const e = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  const code = e.code ?? e.cause?.code;
  const constraint = e.constraint ?? e.cause?.constraint;
  if (code === '23505' && constraint === 'nodes_live_name_uq')
    throw new AppError('node_name_taken');
  throw err;
}

export async function findByName(
  db: DbOrTx,
  spaceId: string,
  parentId: string | null,
  name: string,
  excludeId?: string,
) {
  const [row] = await db
    .select({ id: nodes.id, type: nodes.type })
    .from(nodes)
    .where(
      and(
        eq(nodes.spaceId, spaceId),
        parentId ? eq(nodes.parentId, parentId) : isNull(nodes.parentId),
        eq(nodes.name, name),
        isNull(nodes.deletedAt),
        // The app's own folders hold no name: nobody sees them (nodes_live_name_uq agrees).
        isNull(nodes.systemRole),
        excludeId ? ne(nodes.id, excludeId) : undefined,
      ),
    );
  return row ?? null;
}

/** The live app folder of `role` in this place (`system_role`), if one was made. */
export async function findSystemFolder(
  db: DbOrTx,
  spaceId: string,
  parentId: string | null,
  role: string,
) {
  const [row] = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.spaceId, spaceId),
        parentId ? eq(nodes.parentId, parentId) : isNull(nodes.parentId),
        eq(nodes.systemRole, role),
        isNull(nodes.deletedAt),
      ),
    );
  return row ?? null;
}

/** Postgres unique violation of the per-role system folder index (two first uses at once). */
export function isSystemRoleTaken(err: unknown): boolean {
  const e = err as {
    code?: string;
    constraint?: string;
    cause?: { code?: string; constraint?: string };
  };
  return (
    (e.code ?? e.cause?.code) === '23505' &&
    (e.constraint ?? e.cause?.constraint) === 'nodes_system_role_uq'
  );
}

export async function assertNameFree(
  db: DbOrTx,
  spaceId: string,
  parentId: string | null,
  name: string,
  excludeId?: string,
) {
  const clash = await findByName(db, spaceId, parentId, name, excludeId);
  if (clash) throw new AppError('node_name_taken', { nodeId: clash.id });
}

/** "rapor.pdf" → "rapor (2).pdf", "rapor (3).pdf"… until the folder has no such name. */
export async function freeName(db: DbOrTx, spaceId: string, parentId: string | null, name: string) {
  if (!(await findByName(db, spaceId, parentId, name))) return name;
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot > name.length - 10;
  const base = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!(await findByName(db, spaceId, parentId, candidate))) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

export const childPath = (parentPath: string | null, id: string) =>
  parentPath ? `${parentPath}.${nodeLabel(id)}` : nodeLabel(id);

/** Next position at the end of a folder, or between two siblings. */
export async function positionIn(
  db: DbOrTx,
  spaceId: string,
  parentId: string | null,
  hint?: { afterId?: string | null; beforeId?: string | null },
) {
  const siblingPos = async (id: string | null | undefined) => {
    if (!id) return null;
    const [row] = await db.select({ p: nodes.position }).from(nodes).where(eq(nodes.id, id));
    return row?.p ?? null;
  };
  if (hint && (hint.afterId || hint.beforeId)) {
    const after = await siblingPos(hint.afterId);
    const before = await siblingPos(hint.beforeId);
    if (after === null || before === null || after < before) return keyBetween(after, before);
  }
  const [last] = await db
    .select({ p: max(nodes.position) })
    .from(nodes)
    .where(
      and(
        eq(nodes.spaceId, spaceId),
        parentId ? eq(nodes.parentId, parentId) : isNull(nodes.parentId),
      ),
    );
  return keyBetween(last?.p ?? null, null);
}

export async function adjustSpaceBytes(db: DbOrTx, spaceId: string, delta: number) {
  if (delta === 0) return;
  await db
    .update(spaces)
    .set({ usedBytes: sql`greatest(0, ${spaces.usedBytes} + ${delta})` })
    .where(eq(spaces.id, spaceId));
}

/** Logical bytes of a subtree: every version of every file (doc 17 §8). */
export async function subtreeBytes(db: DbOrTx, path: string, extra?: SQL) {
  const [row] = await db
    .select({ n: sql<string>`coalesce(sum(${nodeVersions.sizeBytes}), 0)` })
    .from(nodeVersions)
    .innerJoin(nodes, eq(nodes.id, nodeVersions.nodeId))
    .where(and(sql`${nodes.path} <@ ${path}::ltree`, extra));
  return Number(row?.n ?? 0);
}

/** Rewrites the ltree path of a whole subtree in one UPDATE (doc 17 §4). */
export async function rewriteSubtree(
  db: DbOrTx,
  oldPath: string,
  newPath: string,
  set: { spaceId?: string } = {},
) {
  await db
    .update(nodes)
    .set({
      path: sql`case when ${nodes.path} = ${oldPath}::ltree then ${newPath}::ltree
        else ${newPath}::ltree || subpath(${nodes.path}, nlevel(${oldPath}::ltree)) end`,
      ...(set.spaceId ? { spaceId: set.spaceId } : {}),
    })
    .where(sql`${nodes.path} <@ ${oldPath}::ltree`);
}

/** Subtree rows, parents before children. */
export async function subtree(db: DbOrTx, path: string, extra?: SQL) {
  return db
    .select()
    .from(nodes)
    .where(and(sql`${nodes.path} <@ ${path}::ltree`, extra))
    .orderBy(sql`nlevel(${nodes.path})`, asc(nodes.position));
}

/**
 * Permanently deletes subtrees: versions go, blob references drop (an unreferenced blob
 * is removed a day later by trash.purge), space usage shrinks. Returns bytes freed.
 */
export async function purgeSubtrees(db: DbOrTx, roots: NodeRow[]) {
  let freed = 0;
  for (const root of roots) {
    const versionRows = await db
      .select({ blobId: nodeVersions.blobId, size: nodeVersions.sizeBytes })
      .from(nodeVersions)
      .innerJoin(nodes, eq(nodes.id, nodeVersions.nodeId))
      .where(sql`${nodes.path} <@ ${root.path}::ltree`);
    const perBlob = new Map<string, number>();
    let bytes = 0;
    for (const v of versionRows) {
      bytes += v.size;
      if (v.blobId) perBlob.set(v.blobId, (perBlob.get(v.blobId) ?? 0) + 1);
    }
    await db.delete(nodes).where(sql`${nodes.path} <@ ${root.path}::ltree`);
    for (const [blobId, count] of perBlob) await releaseBlob(db, blobId, count);
    await adjustSpaceBytes(db, root.spaceId, -bytes);
    freed += bytes;
  }
  return freed;
}

export async function releaseBlob(db: DbOrTx, blobId: string, count = 1) {
  await db
    .update(blobs)
    .set({
      refCount: sql`greatest(0, ${blobs.refCount} - ${count})`,
      orphanedAt: sql`case when ${blobs.refCount} - ${count} <= 0 then now() else null end`,
    })
    .where(eq(blobs.id, blobId));
}

export async function retainBlob(db: DbOrTx, blobId: string, count = 1) {
  await db
    .update(blobs)
    .set({ refCount: sql`${blobs.refCount} + ${count}`, orphanedAt: null })
    .where(eq(blobs.id, blobId));
}

export async function nodesByIds(db: DbOrTx, orgId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(nodes)
    .where(and(eq(nodes.orgId, orgId), inArray(nodes.id, ids)));
}
