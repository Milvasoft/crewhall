import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { newId, nodes, nodeVersions, shares, users, type DbOrTx } from '@crewhall/db';
import {
  CONTAINER_NODE_TYPES,
  type DriveNode,
  type DriveNodeDetail,
  type NodeType,
  type SpaceRole,
  type TrashItem,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import {
  loadNode,
  loadSpace,
  mapVisible,
  requireNodeAction,
  roleForPath,
  spaceRoleOf,
  toDriveNodes,
  userSharePaths,
  type DriveActor,
  type NodeRow,
} from './access';
import { hiddenNodeTypes, requireNodeModule, visibleNodeTypes } from '../identity/node-types';
import { purgeDate } from '../trash/retention';
import { heldNodeRoots } from '../compliance/holds';
import { assertQuota } from './quota';
import {
  adjustSpaceBytes,
  assertNameFree,
  childPath,
  findSystemFolder,
  freeName,
  isSystemRoleTaken,
  nameTakenFrom,
  nodesByIds,
  positionIn,
  purgeSubtrees,
  retainBlob,
  rewriteSubtree,
  subtree,
  subtreeBytes,
} from './tree';

const isContainer = (t: NodeType) => (CONTAINER_NODE_TYPES as readonly string[]).includes(t);

/* --------------------------------- listing --------------------------------- */

interface ListQuery {
  parentId?: string | undefined;
  type?: NodeType | undefined;
  sort: 'name' | 'updatedAt' | 'size' | 'type';
  order: 'asc' | 'desc';
  cursor?: string | undefined;
  limit: number;
}

const SORT_SQL = {
  name: { col: sql`${nodes.name}`, cast: 'text' },
  updatedAt: { col: sql`${nodes.updatedAt}`, cast: 'timestamptz' },
  size: { col: sql`${nodes.sizeBytes}`, cast: 'bigint' },
  type: { col: sql`${nodes.type}::text`, cast: 'text' },
} as const;

type Cursor = [boolean, string, string];

function decodeCursor(cursor: string): Cursor {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(v) &&
      typeof v[0] === 'boolean' &&
      typeof v[1] === 'string' &&
      typeof v[2] === 'string'
    ) {
      return [v[0], v[1], v[2]];
    }
  } catch {
    // fall through
  }
  throw new AppError('bad_request', { reason: 'invalid_cursor' });
}

/** Children of a folder or the space root: folders first, then the chosen sort; cursor paged. */
export async function listNodes(db: DbOrTx, a: DriveActor, spaceId: string, q: ListQuery) {
  let parent: NodeRow | null = null;
  if (q.parentId) {
    const access = await loadNode(db, a, q.parentId);
    if (access.space.id !== spaceId) throw new AppError('not_found');
    parent = access.node;
  } else {
    const { role } = await loadSpace(db, a, spaceId);
    requireNodeAction(a, role, 'space.view');
  }

  const { col, cast } = SORT_SQL[q.sort];
  const notFolder = sql`(${nodes.type} <> 'folder')`;
  const conds: SQL[] = [
    eq(nodes.spaceId, spaceId),
    parent ? eq(nodes.parentId, parent.id) : isNull(nodes.parentId),
    isNull(nodes.deletedAt),
  ];
  const typeFilter = visibleNodeTypes(await hiddenNodeTypes(db, a.org.id));
  if (typeFilter) conds.push(typeFilter);
  if (q.type) conds.push(eq(nodes.type, q.type));
  if (q.cursor) {
    const [f, v, id] = decodeCursor(q.cursor);
    const cmp = q.order === 'asc' ? sql`>` : sql`<`;
    const value = sql`${v}::${sql.raw(cast)}`;
    conds.push(
      sql`(${notFolder} > ${f} or (${notFolder} = ${f} and (${col} ${cmp} ${value} or (${col} = ${value} and ${nodes.id} ${cmp} ${id}::uuid))))`,
    );
  }
  const dir = q.order === 'asc' ? asc : desc;
  const rows = await db
    .select({ node: nodes, sortText: sql<string>`${col}::text` })
    .from(nodes)
    .where(and(...conds))
    .orderBy(asc(notFolder), dir(col), dir(nodes.id))
    .limit(q.limit + 1);

  const pageRows = rows.slice(0, q.limit);
  const last = pageRows.at(-1);
  const items = await mapVisible(
    db,
    a,
    pageRows.map((r) => r.node),
  );
  return {
    items,
    nextCursor:
      rows.length > q.limit && last
        ? Buffer.from(
            JSON.stringify([last.node.type !== 'folder', last.sortText, last.node.id]),
          ).toString('base64url')
        : null,
  };
}

export async function nodeDetail(
  db: DbOrTx,
  a: DriveActor,
  nodeId: string,
): Promise<DriveNodeDetail> {
  const access = await loadNode(db, a, nodeId, { includeTrashed: true });
  await requireNodeModule(db, a.org.id, access.node.type);
  const [node] = await toDriveNodes(
    db,
    a.userId,
    [access.node],
    new Map([[access.node.id, access.role!]]),
  );
  const labels = access.node.path.split('.').slice(0, -1);
  const ancestors = labels.length
    ? await db
        .select({ id: nodes.id, name: nodes.name, path: nodes.path })
        .from(nodes)
        .where(
          sql`${nodes.path} @> ${access.node.path}::ltree and ${nodes.id} <> ${access.node.id}`,
        )
        .orderBy(sql`nlevel(${nodes.path})`)
    : [];
  return {
    ...node!,
    path: ancestors.map((p) => ({ id: p.id, name: p.name })),
    space: { id: access.space.id, name: access.space.name, color: access.space.color },
  };
}

/** Where new children of `parentId` (or the space root) go, with the caller's role there. */
export async function container(
  db: DbOrTx,
  a: DriveActor,
  spaceId: string,
  parentId: string | null,
) {
  if (parentId) {
    const access = await loadNode(db, a, parentId);
    if (access.space.id !== spaceId) throw new AppError('invalid_target');
    if (!isContainer(access.node.type)) throw new AppError('invalid_target');
    return { space: access.space, parent: access.node, role: access.role };
  }
  const { space, role } = await loadSpace(db, a, spaceId);
  return { space, parent: null, role };
}

export async function createFolder(
  db: DbOrTx,
  a: DriveActor,
  spaceId: string,
  /** `system`: the app's own folder of that role (found, or made once), hidden from Drive lists. */
  input: { parentId: string | null; name: string; system?: string | undefined },
): Promise<DriveNode> {
  const { space, parent, role } = await container(db, a, spaceId, input.parentId);
  requireNodeAction(a, role, 'space.edit_content');
  if (space.archivedAt) throw new AppError('forbidden', { reason: 'archived' });
  const parentId = parent?.id ?? null;
  const shown = async (row: NodeRow) =>
    (await toDriveNodes(db, a.userId, [row], new Map([[row.id, role!]])))[0]!;
  if (input.system) {
    const found = await findSystemFolder(db, space.id, parentId, input.system);
    if (found) return shown(found);
  } else {
    await assertNameFree(db, space.id, parentId, input.name);
  }
  const id = newId();
  const [row] = await db
    .insert(nodes)
    .values({
      id,
      orgId: a.org.id,
      spaceId: space.id,
      parentId,
      type: 'folder',
      name: input.name,
      systemRole: input.system ?? null,
      position: await positionIn(db, space.id, parentId),
      path: childPath(parent?.path ?? null, id),
      createdBy: a.userId,
      updatedBy: a.userId,
    })
    .returning()
    .catch(async (e: unknown) => {
      // Two first uses at once: the other one made it.
      if (input.system && isSystemRoleTaken(e)) {
        const other = await findSystemFolder(db, space.id, parentId, input.system);
        if (other) return [other];
      }
      return nameTakenFrom(e);
    });
  return shown(row!);
}

export async function renameNode(db: DbOrTx, a: DriveActor, nodeId: string, name: string) {
  const access = await loadNode(db, a, nodeId);
  requireNodeAction(a, access.role, 'space.edit_content');
  if (name !== access.node.name) {
    await assertNameFree(db, access.space.id, access.node.parentId, name, access.node.id);
    await db
      .update(nodes)
      .set({ name, updatedBy: a.userId })
      .where(eq(nodes.id, nodeId))
      .catch(nameTakenFrom);
  }
  const [row] = await db.select().from(nodes).where(eq(nodes.id, nodeId));
  return (await toDriveNodes(db, a.userId, [row!], new Map([[nodeId, access.role!]])))[0]!;
}

interface Target {
  spaceId: string;
  parentId: string | null;
  afterId?: string | null | undefined;
  beforeId?: string | null | undefined;
}

/**
 * Moves nodes (design 3.13). The subtree path changes in one UPDATE; across spaces the
 * nodes take the target's permissions: person shares are dropped, public links stay.
 */
export async function moveNodes(
  db: DbOrTx,
  a: DriveActor,
  nodeIds: string[],
  target: Target,
  req: RequestInfo,
) {
  const dest = await container(db, a, target.spaceId, target.parentId);
  requireNodeAction(a, dest.role, 'space.edit_content');
  if (dest.space.archivedAt) throw new AppError('forbidden', { reason: 'archived' });
  const moved: string[] = [];
  for (const id of nodeIds) {
    const access = await loadNode(db, a, id);
    requireNodeAction(a, access.role, 'space.edit_content');
    const node = access.node;
    if (
      dest.parent &&
      (dest.parent.path === node.path || dest.parent.path.startsWith(`${node.path}.`))
    ) {
      throw new AppError('invalid_target', { reason: 'into_itself', nodeId: id });
    }
    const sameParent =
      node.spaceId === dest.space.id && node.parentId === (dest.parent?.id ?? null);
    if (!sameParent)
      await assertNameFree(db, dest.space.id, dest.parent?.id ?? null, node.name, node.id);

    const crossSpace = node.spaceId !== dest.space.id;
    const bytes = crossSpace ? await subtreeBytes(db, node.path) : 0;
    if (crossSpace) {
      await assertQuota(db, a.org, dest.space, bytes);
      // Person shares belong to the old space's sharing (3.13); links keep working.
      await db.execute(sql`delete from ${shares} where ${shares.kind} = 'user' and ${shares.nodeId} in
        (select id from ${nodes} where ${nodes.path} <@ ${node.path}::ltree)`);
    }
    const newPath = childPath(dest.parent?.path ?? null, node.id);
    if (newPath !== node.path || crossSpace) {
      await rewriteSubtree(db, node.path, newPath, crossSpace ? { spaceId: dest.space.id } : {});
    }
    await db
      .update(nodes)
      .set({
        parentId: dest.parent?.id ?? null,
        position: await positionIn(db, dest.space.id, dest.parent?.id ?? null, target),
        updatedBy: a.userId,
      })
      .where(eq(nodes.id, node.id))
      .catch(nameTakenFrom);
    if (crossSpace) {
      await adjustSpaceBytes(db, node.spaceId, -bytes);
      await adjustSpaceBytes(db, dest.space.id, bytes);
      await audit(
        db,
        {
          orgId: a.org.id,
          actorId: a.userId,
          action: 'node.move',
          targetType: 'node',
          targetId: node.id,
          meta: { fromSpaceId: node.spaceId, toSpaceId: dest.space.id },
        },
        req,
      );
    }
    moved.push(node.id);
  }
  return mapVisible(db, a, await nodesByIds(db, a.org.id, moved));
}

/** Copies subtrees; files point at the same blobs (3.13), so nothing is re-uploaded. */
export async function copyNodes(db: DbOrTx, a: DriveActor, nodeIds: string[], target: Target) {
  const dest = await container(db, a, target.spaceId, target.parentId);
  requireNodeAction(a, dest.role, 'space.edit_content');
  if (dest.space.archivedAt) throw new AppError('forbidden', { reason: 'archived' });
  const created: string[] = [];
  for (const id of nodeIds) {
    const access = await loadNode(db, a, id);
    if (
      dest.parent &&
      (dest.parent.path === access.node.path || dest.parent.path.startsWith(`${access.node.path}.`))
    ) {
      throw new AppError('invalid_target', { reason: 'into_itself', nodeId: id });
    }
    const rows = await subtree(db, access.node.path, isNull(nodes.deletedAt));
    const currentVersions = await db
      .select()
      .from(nodeVersions)
      .where(
        sql`${nodeVersions.id} in (select current_version_id from ${nodes} where ${nodes.path} <@ ${access.node.path}::ltree and deleted_at is null)`,
      );
    const byId = new Map(currentVersions.map((v) => [v.id, v]));
    const bytes = currentVersions.reduce((s, v) => s + v.sizeBytes, 0);
    await assertQuota(db, a.org, dest.space, bytes);

    const idMap = new Map<string, { id: string; path: string }>();
    for (const r of rows) {
      const isRoot = r.id === access.node.id;
      const parentNew = isRoot ? null : idMap.get(r.parentId ?? '');
      const parentId = isRoot ? (dest.parent?.id ?? null) : (parentNew?.id ?? null);
      const parentPath = isRoot ? (dest.parent?.path ?? null) : (parentNew?.path ?? null);
      const nid = newId();
      const path = childPath(parentPath, nid);
      idMap.set(r.id, { id: nid, path });
      const name = isRoot ? await freeName(db, dest.space.id, parentId, r.name) : r.name;
      const version = r.currentVersionId ? byId.get(r.currentVersionId) : undefined;
      const versionId = version ? newId() : null;
      await db.insert(nodes).values({
        id: nid,
        orgId: a.org.id,
        spaceId: dest.space.id,
        parentId,
        type: r.type,
        name,
        mime: r.mime,
        sizeBytes: r.sizeBytes,
        position: isRoot ? await positionIn(db, dest.space.id, parentId, target) : r.position,
        path,
        currentVersionId: versionId,
        createdBy: a.userId,
        updatedBy: a.userId,
      });
      if (version && versionId) {
        await db.insert(nodeVersions).values({
          id: versionId,
          orgId: a.org.id,
          nodeId: nid,
          version: 1,
          blobId: version.blobId,
          sizeBytes: version.sizeBytes,
          mime: version.mime,
          source: version.source,
          createdBy: a.userId,
        });
        if (version.blobId) await retainBlob(db, version.blobId);
      }
      if (isRoot) created.push(nid);
    }
    await adjustSpaceBytes(db, dest.space.id, bytes);
  }
  return mapVisible(db, a, await nodesByIds(db, a.org.id, created));
}

/** Trash (3.16): the node and its subtree share one deleted_at, so they come back together. */
export async function trashNodes(db: DbOrTx, a: DriveActor, nodeIds: string[]) {
  const now = new Date();
  const done: string[] = [];
  for (const id of nodeIds) {
    const access = await loadNode(db, a, id);
    requireNodeAction(a, access.role, 'space.trash');
    await db
      .update(nodes)
      .set({ deletedAt: now, deletedBy: a.userId })
      .where(and(sql`${nodes.path} <@ ${access.node.path}::ltree`, isNull(nodes.deletedAt)));
    done.push(id);
  }
  return mapVisible(db, a, await nodesByIds(db, a.org.id, done));
}

export async function restoreNodes(db: DbOrTx, a: DriveActor, nodeIds: string[]) {
  const done: string[] = [];
  for (const id of nodeIds) {
    const access = await loadNode(db, a, id, { includeTrashed: true });
    requireNodeAction(a, access.role, 'space.trash');
    const node = access.node;
    if (!node.deletedAt) {
      done.push(id);
      continue;
    }
    let parentId = node.parentId;
    let parentPath: string | null = null;
    if (parentId) {
      const [parent] = await db.select().from(nodes).where(eq(nodes.id, parentId));
      if (!parent || parent.deletedAt) parentId = null;
      else parentPath = parent.path;
    }
    // Back in place, or at the root when the folder is gone too (3.16). The free name is
    // set while the node is still trashed, so the live-name index never sees a clash.
    const name = await freeName(db, node.spaceId, parentId, node.name);
    await db.update(nodes).set({ parentId, name }).where(eq(nodes.id, node.id));
    const newPath = childPath(parentPath, node.id);
    if (newPath !== node.path) await rewriteSubtree(db, node.path, newPath);
    await db
      .update(nodes)
      .set({ deletedAt: null, deletedBy: null })
      .where(and(sql`${nodes.path} <@ ${newPath}::ltree`, eq(nodes.deletedAt, node.deletedAt)))
      .catch(nameTakenFrom);
    done.push(id);
  }
  return mapVisible(db, a, await nodesByIds(db, a.org.id, done));
}

/** Permanent delete of trashed nodes (space.purge, admins and owners). */
export async function purgeNodes(db: DbOrTx, a: DriveActor, nodeIds: string[], req: RequestInfo) {
  const roots: NodeRow[] = [];
  for (const id of nodeIds) {
    const access = await loadNode(db, a, id, { includeTrashed: true });
    requireNodeAction(a, access.role, 'space.purge');
    if (!access.node.deletedAt)
      throw new AppError('bad_request', { reason: 'not_in_trash', nodeId: id });
    roots.push(access.node);
  }
  if ((await heldNodeRoots(db, roots)).size) throw new AppError('legal_hold');
  const freed = await purgeSubtrees(db, roots);
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'node.purge',
      targetType: 'node',
      targetId: nodeIds.join(','),
      meta: { count: roots.length, bytes: freed },
    },
    req,
  );
}

/** Items the person put in the trash, top level only (their subtree goes with them). */
export async function listTrash(
  db: DbOrTx,
  a: DriveActor,
  spaceId: string,
  q: { cursor?: string | undefined; limit: number },
) {
  const { space, role } = await loadSpace(db, a, spaceId);
  requireNodeAction(a, role, 'space.trash');
  // Correlated on the outer row by name: Drizzle does not qualify single-table columns.
  const parent = sql`(select p.deleted_at from ${nodes} p where p.id = "nodes"."parent_id")`;
  const conds: SQL[] = [
    eq(nodes.spaceId, space.id),
    isNotNull(nodes.deletedAt),
    or(isNull(nodes.parentId), sql`${parent} is null`, sql`${parent} <> ${nodes.deletedAt}`)!,
  ];
  const typeFilter = visibleNodeTypes(await hiddenNodeTypes(db, a.org.id));
  if (typeFilter) conds.push(typeFilter);
  if (q.cursor) {
    const [, at, id] = decodeCursor(q.cursor);
    conds.push(sql`(${nodes.deletedAt}, ${nodes.id}) < (${at}::timestamptz, ${id}::uuid)`);
  }
  const rows = await db
    .select({ node: nodes, at: sql<string>`${nodes.deletedAt}::text` })
    .from(nodes)
    .where(and(...conds))
    .orderBy(desc(nodes.deletedAt), desc(nodes.id))
    .limit(q.limit + 1);
  const pageRows = rows.slice(0, q.limit);
  const roles = new Map(pageRows.map((r) => [r.node.id, role as SpaceRole]));
  const mapped = await toDriveNodes(
    db,
    a.userId,
    pageRows.map((r) => r.node),
    roles,
  );
  const deleterIds = [
    ...new Set(pageRows.map((r) => r.node.deletedBy).filter((v): v is string => !!v)),
  ];
  const deleters = deleterIds.length
    ? await db
        .select({ id: users.id, name: users.name, email: users.email, image: users.image })
        .from(users)
        .where(inArray(users.id, deleterIds))
    : [];
  const items: TrashItem[] = [];
  for (const [i, r] of pageRows.entries()) {
    const labels = r.node.path.split('.').slice(0, -1);
    const names = labels.length
      ? await db
          .select({ name: nodes.name })
          .from(nodes)
          .where(sql`${nodes.path} @> ${r.node.path}::ltree and ${nodes.id} <> ${r.node.id}`)
          .orderBy(sql`nlevel(${nodes.path})`)
      : [];
    const by = deleters.find((u) => u.id === r.node.deletedBy);
    items.push({
      ...mapped[i]!,
      deletedAt: r.node.deletedAt!.toISOString(),
      deletedBy: by ? { id: by.id, name: by.name, email: by.email, imageUrl: by.image } : null,
      purgeAt: purgeDate(r.node.deletedAt!, a.org.settings).toISOString(),
      originalPath: [space.name, ...names.map((n) => n.name)].join(' / '),
    });
  }
  const last = pageRows.at(-1);
  return {
    items,
    nextCursor:
      rows.length > q.limit && last
        ? Buffer.from(JSON.stringify([false, last.at, last.node.id])).toString('base64url')
        : null,
  };
}

export async function emptyTrash(db: DbOrTx, a: DriveActor, spaceId: string, req: RequestInfo) {
  const { space, role } = await loadSpace(db, a, spaceId);
  requireNodeAction(a, role, 'space.purge');
  const roots = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.spaceId, space.id),
        isNotNull(nodes.deletedAt),
        or(
          isNull(nodes.parentId),
          sql`(select p.deleted_at from ${nodes} p where p.id = "nodes"."parent_id") is distinct from "nodes"."deleted_at"`,
        ),
      ),
    );
  // Held subtrees stay in the trash (legal hold).
  const held = await heldNodeRoots(db, roots);
  const freed = await purgeSubtrees(
    db,
    roots.filter((r) => !held.has(r.id)),
  );
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'node.purge',
      targetType: 'space',
      targetId: space.id,
      meta: { count: roots.length, bytes: freed, emptyTrash: true },
    },
    req,
  );
}

/** Effective role of the caller on many nodes of one space (for search and favorites). */
export async function rolesFor(db: DbOrTx, a: DriveActor, spaceId: string, rows: NodeRow[]) {
  const spaceRole = await spaceRoleOf(db, spaceId, a.userId);
  const paths = await userSharePaths(db, spaceId, a.userId);
  return new Map(rows.map((r) => [r.id, roleForPath(spaceRole, paths, r.path)]));
}
