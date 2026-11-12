import { and, eq, isNull, sql } from 'drizzle-orm';
import { newId, nodes, portalSites, spaces, type DbOrTx } from '@crewhall/db';
import { childPath, freeName, positionIn, rewriteSubtree } from '../drive/tree';
import { createSharedSpace } from '../spaces';

/**
 * Drafts live in the system "Portal" space (doc 17 §4, §9 step 1): one folder per site, then
 * version / locale folders, category folders and one page node per doc; blog posts under
 * blog / locale. The node tree mirrors the portal tree so the wiki module can take over the
 * page content (Yjs) later without moving anything.
 */

type NodeType = 'folder' | 'page';

/** The org's Portal space: the one existing sites use, or a new shared space. */
export async function portalSpaceId(db: DbOrTx, orgId: string, creatorId: string) {
  const [existing] = await db
    .select({ id: portalSites.contentSpaceId })
    .from(portalSites)
    .innerJoin(spaces, eq(spaces.id, portalSites.contentSpaceId))
    .where(and(eq(portalSites.orgId, orgId), isNull(spaces.archivedAt)))
    .limit(1);
  if (existing) return existing.id;
  const space = await createSharedSpace(db, orgId, creatorId, {
    name: 'Portal',
    color: 's3',
    icon: 'portal',
  });
  return space.id;
}

/** Node names cannot contain slashes (Drive rule). */
const nodeName = (name: string) =>
  name.split('\u0000').join('-').replace(/[/\\]/g, '-').trim().slice(0, 255) || '-';

export async function createNode(
  db: DbOrTx,
  input: {
    orgId: string;
    spaceId: string;
    parentId: string | null;
    type: NodeType;
    name: string;
    userId: string | null;
  },
) {
  let parentPath: string | null = null;
  if (input.parentId) {
    const [parent] = await db
      .select({ path: nodes.path })
      .from(nodes)
      .where(eq(nodes.id, input.parentId));
    parentPath = parent?.path ?? null;
  }
  const id = newId();
  const name = await freeName(db, input.spaceId, input.parentId, nodeName(input.name));
  await db.insert(nodes).values({
    id,
    orgId: input.orgId,
    spaceId: input.spaceId,
    parentId: input.parentId,
    type: input.type,
    name,
    position: await positionIn(db, input.spaceId, input.parentId),
    path: childPath(parentPath, id),
    createdBy: input.userId,
    updatedBy: input.userId,
  });
  return id;
}

/** A live child folder by name, created when missing. */
export async function ensureFolder(
  db: DbOrTx,
  input: {
    orgId: string;
    spaceId: string;
    parentId: string | null;
    name: string;
    userId: string | null;
  },
) {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.spaceId, input.spaceId),
        input.parentId ? eq(nodes.parentId, input.parentId) : isNull(nodes.parentId),
        eq(nodes.name, nodeName(input.name)),
        eq(nodes.type, 'folder'),
        isNull(nodes.deletedAt),
      ),
    );
  if (row) return row.id;
  return createNode(db, { ...input, type: 'folder' });
}

export async function renameNode(db: DbOrTx, nodeId: string | null, name: string, userId: string) {
  if (!nodeId) return;
  const [node] = await db
    .select({ name: nodes.name, spaceId: nodes.spaceId, parentId: nodes.parentId })
    .from(nodes)
    .where(eq(nodes.id, nodeId));
  if (!node || node.name === nodeName(name)) return;
  const free = await freeName(db, node.spaceId, node.parentId, nodeName(name));
  await db.update(nodes).set({ name: free, updatedBy: userId }).where(eq(nodes.id, nodeId));
}

/** Moves a node (and its subtree paths) under another parent. */
export async function moveNode(
  db: DbOrTx,
  nodeId: string | null,
  parentId: string,
  userId: string,
) {
  if (!nodeId) return;
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId));
  const [parent] = await db.select().from(nodes).where(eq(nodes.id, parentId));
  if (!node || !parent || node.parentId === parentId) return;
  const name = await freeName(db, node.spaceId, parentId, node.name);
  const newPath = childPath(parent.path, node.id);
  await db
    .update(nodes)
    .set({
      parentId,
      name,
      updatedBy: userId,
      position: await positionIn(db, node.spaceId, parentId),
    })
    .where(eq(nodes.id, node.id));
  await rewriteSubtree(db, node.path, newPath);
}

/** Trash or restore a node with its subtree (Drive's trash rules apply). */
export async function trashNode(db: DbOrTx, nodeId: string | null, userId: string | null) {
  if (!nodeId) return;
  const [node] = await db.select({ path: nodes.path }).from(nodes).where(eq(nodes.id, nodeId));
  if (!node) return;
  await db.execute(sql`update ${nodes} set deleted_at = now(), deleted_by = ${userId}
    where path <@ ${node.path}::ltree and deleted_at is null`);
}

export async function restoreNode(db: DbOrTx, nodeId: string | null) {
  if (!nodeId) return;
  const [node] = await db.select({ path: nodes.path }).from(nodes).where(eq(nodes.id, nodeId));
  if (!node) return;
  await db.execute(sql`update ${nodes} set deleted_at = null, deleted_by = null
    where path <@ ${node.path}::ltree`);
}
