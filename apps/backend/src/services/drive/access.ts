import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  blobs,
  drawings,
  nodes,
  nodeUserState,
  nodeVersions,
  shares,
  spaceMembers,
  spaces,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  can,
  effectiveNodeRole,
  type Actor,
  type DriveNode,
  type SpaceAction,
  type SpaceRole,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { OrgRow } from '../../http/types';
import { hiddenNodeTypes, visibleNodeTypes } from '../identity/node-types';
import { orgContext } from '../membership';

export type NodeRow = typeof nodes.$inferSelect;
export type SpaceRow = typeof spaces.$inferSelect;

/** Who is asking, in the active org. */
export interface DriveActor {
  org: OrgRow;
  actor: Actor;
  userId: string;
}

/** ltree: is `ancestor` the node itself or one of its ancestors? */
export const isAncestorOrSelf = (ancestor: string, path: string) =>
  path === ancestor || path.startsWith(`${ancestor}.`);

export async function spaceRoleOf(db: DbOrTx, spaceId: string, userId: string) {
  const [row] = await db
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)));
  return (row?.role ?? null) as SpaceRole | null;
}

/** Live person shares of `userId` in a space: [ltree path of the shared node, role]. */
export async function userSharePaths(db: DbOrTx, spaceId: string, userId: string) {
  return db
    .select({ path: nodes.path, role: shares.role })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .where(
      and(
        eq(nodes.spaceId, spaceId),
        eq(shares.kind, 'user'),
        eq(shares.granteeUserId, userId),
        isNull(nodes.deletedAt),
        or(isNull(shares.expiresAt), sql`${shares.expiresAt} > now()`),
      ),
    );
}

export function roleForPath(
  spaceRole: SpaceRole | null,
  sharePaths: { path: string; role: 'viewer' | 'editor' }[],
  path: string,
): SpaceRole | null {
  return effectiveNodeRole(
    spaceRole,
    sharePaths.filter((s) => isAncestorOrSelf(s.path, path)).map((s) => s.role),
  );
}

export function nodeResource(a: DriveActor, role: SpaceRole | null) {
  return { type: 'space' as const, org: orgContext(a.org), myRole: role };
}

export function requireNodeAction(a: DriveActor, role: SpaceRole | null, action: SpaceAction) {
  if (!can(a.actor, action, nodeResource(a, role))) {
    // Without view rights the node does not exist for the caller (design 1.18).
    throw new AppError(role === null ? 'not_found' : 'forbidden');
  }
}

export interface NodeAccess {
  node: NodeRow;
  space: SpaceRow;
  spaceRole: SpaceRole | null;
  role: SpaceRole | null;
}

/** Loads a node of the active org with the caller's effective role; 404 when unseen. */
export async function loadNode(
  db: DbOrTx,
  a: DriveActor,
  nodeId: string,
  options: { includeTrashed?: boolean } = {},
): Promise<NodeAccess> {
  const [row] = await db
    .select({ node: nodes, space: spaces })
    .from(nodes)
    .innerJoin(spaces, eq(spaces.id, nodes.spaceId))
    .where(and(eq(nodes.id, nodeId), eq(nodes.orgId, a.org.id)));
  if (!row || row.space.deletedAt) throw new AppError('not_found');
  if (row.node.deletedAt && !options.includeTrashed) throw new AppError('not_found');
  const spaceRole = await spaceRoleOf(db, row.space.id, a.userId);
  const role = roleForPath(
    spaceRole,
    await userSharePaths(db, row.space.id, a.userId),
    row.node.path,
  );
  if (!can(a.actor, 'space.view', nodeResource(a, role))) throw new AppError('not_found');
  return { node: row.node, space: row.space, spaceRole, role };
}

/** A space of the active org and the caller's role there (no shares: the space root). */
export async function loadSpace(db: DbOrTx, a: DriveActor, spaceId: string) {
  const [space] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.orgId, a.org.id)));
  if (!space || space.deletedAt) throw new AppError('not_found');
  const role = await spaceRoleOf(db, space.id, a.userId);
  return { space, role };
}

type UserSummaryRow = { id: string; name: string; email: string; image: string | null };
const summary = (u: UserSummaryRow | undefined) =>
  u ? { id: u.id, name: u.name, email: u.email, imageUrl: u.image } : null;

/**
 * Turns node rows into DriveNode with everything a list needs (children, favorites,
 * shares, preview state, version, people) in a handful of batched queries.
 */
export async function toDriveNodes(
  db: DbOrTx,
  userId: string,
  rows: NodeRow[],
  roles: Map<string, SpaceRole>,
): Promise<DriveNode[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  // Children of switched-off modules (pages, boards) do not count (identity module switches).
  const typeFilter = visibleNodeTypes(await hiddenNodeTypes(db, rows[0]!.orgId));
  const childRows = await db
    .select({ parentId: nodes.parentId })
    .from(nodes)
    .where(and(inArray(nodes.parentId, ids), isNull(nodes.deletedAt), typeFilter))
    .groupBy(nodes.parentId);
  const withChildren = new Set(childRows.map((r) => r.parentId));

  const favRows = await db
    .select({ nodeId: nodeUserState.nodeId })
    .from(nodeUserState)
    .where(
      and(
        eq(nodeUserState.userId, userId),
        inArray(nodeUserState.nodeId, ids),
        eq(nodeUserState.favorite, true),
      ),
    );
  const favorites = new Set(favRows.map((r) => r.nodeId));

  // Shared: a live share on the node or an ancestor (one query over the spaces involved).
  const spaceIds = [...new Set(rows.map((r) => r.spaceId))];
  const sharePaths = await db
    .select({ path: nodes.path })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .where(
      and(
        inArray(nodes.spaceId, spaceIds),
        or(isNull(shares.expiresAt), sql`${shares.expiresAt} > now()`),
      ),
    );

  const versionIds = rows.map((r) => r.currentVersionId).filter((v): v is string => !!v);
  const versionRows = versionIds.length
    ? await db
        .select({
          id: nodeVersions.id,
          version: nodeVersions.version,
          preview: blobs.previewStatus,
        })
        .from(nodeVersions)
        .leftJoin(blobs, eq(blobs.id, nodeVersions.blobId))
        .where(inArray(nodeVersions.id, versionIds))
    : [];
  const versions = new Map(versionRows.map((v) => [v.id, v]));

  // Drawings: the worker's thumbnail (boards module) is their preview.
  const drawingIds = rows.filter((r) => r.type === 'drawing').map((r) => r.id);
  const drawingThumbs = new Set(
    drawingIds.length
      ? (
          await db
            .select({ id: drawings.nodeId })
            .from(drawings)
            .where(and(inArray(drawings.nodeId, drawingIds), isNotNull(drawings.thumbnailBlobId)))
        ).map((d) => d.id)
      : [],
  );

  const peopleIds = [
    ...new Set(rows.flatMap((r) => [r.createdBy, r.updatedBy]).filter((v): v is string => !!v)),
  ];
  const people = new Map(
    (peopleIds.length
      ? await db
          .select({ id: users.id, name: users.name, email: users.email, image: users.image })
          .from(users)
          .where(inArray(users.id, peopleIds))
      : []
    ).map((u) => [u.id, u]),
  );

  return rows.map((r) => {
    const v = r.currentVersionId ? versions.get(r.currentVersionId) : undefined;
    return {
      id: r.id,
      spaceId: r.spaceId,
      parentId: r.parentId,
      type: r.type,
      name: r.name,
      mime: r.mime,
      sizeBytes: r.sizeBytes,
      hasChildren: withChildren.has(r.id),
      myRole: roles.get(r.id) ?? 'viewer',
      shared: sharePaths.some((s) => isAncestorOrSelf(s.path, r.path)),
      favorite: favorites.has(r.id),
      preview:
        r.type === 'file' ? (v?.preview ?? 'none') : drawingThumbs.has(r.id) ? 'ready' : 'none',
      version: r.type === 'file' ? (v?.version ?? null) : null,
      createdBy: summary(r.createdBy ? people.get(r.createdBy) : undefined),
      updatedBy: summary(r.updatedBy ? people.get(r.updatedBy) : undefined),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
    };
  });
}

/** DriveNode for rows the caller can see; computes effective roles per space. */
export async function mapVisible(db: DbOrTx, a: DriveActor, rows: NodeRow[]) {
  const roles = new Map<string, SpaceRole>();
  const bySpace = new Map<string, NodeRow[]>();
  for (const r of rows) bySpace.set(r.spaceId, [...(bySpace.get(r.spaceId) ?? []), r]);
  const visible: NodeRow[] = [];
  for (const [spaceId, list] of bySpace) {
    const spaceRole = await spaceRoleOf(db, spaceId, a.userId);
    const paths = await userSharePaths(db, spaceId, a.userId);
    for (const r of list) {
      const role = roleForPath(spaceRole, paths, r.path);
      if (role && can(a.actor, 'space.view', nodeResource(a, role))) {
        roles.set(r.id, role);
        visible.push(r);
      }
    }
  }
  const order = new Map(rows.map((r, i) => [r.id, i]));
  visible.sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0));
  return toDriveNodes(db, a.userId, visible, roles);
}

/** Space ids where the caller is a member, plus spaces holding shares to them. */
export async function reachableSpaceIds(db: DbOrTx, a: DriveActor): Promise<string[]> {
  const member = await db
    .select({ id: spaceMembers.spaceId })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(
      and(eq(spaceMembers.userId, a.userId), eq(spaces.orgId, a.org.id), isNull(spaces.deletedAt)),
    );
  const shared = await db
    .selectDistinct({ id: nodes.spaceId })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .where(and(eq(shares.granteeUserId, a.userId), eq(nodes.orgId, a.org.id)));
  return [...new Set([...member, ...shared].map((r) => r.id))];
}

export const notDeleted: SQL = isNull(nodes.deletedAt);
