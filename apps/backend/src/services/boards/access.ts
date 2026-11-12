import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  boardCards,
  boards,
  drawings,
  nodes,
  shares,
  spaceMembers,
  users,
  type DbOrTx,
} from '@crewhall/db';
import { can, type SpaceRole, type UserSummary } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import {
  isAncestorOrSelf,
  loadNode,
  nodeResource,
  type DriveActor,
  type NodeAccess,
} from '../drive/access';

export type BoardRow = typeof boards.$inferSelect;
export type CardRow = typeof boardCards.$inferSelect;
export type DrawingRow = typeof drawings.$inferSelect;

export interface BoardAccess extends NodeAccess {
  board: BoardRow;
}

const RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export const atLeast = (role: SpaceRole | null, min: SpaceRole) =>
  role !== null && RANK[role] >= RANK[min];

/** A live board node the caller can see; 404 otherwise (also for other node types). */
export async function loadBoard(
  db: DbOrTx,
  a: DriveActor,
  boardId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<BoardAccess> {
  const access = await loadNode(db, a, boardId);
  if (access.node.type !== 'board') throw new AppError('not_found');
  const q = db.select().from(boards).where(eq(boards.nodeId, boardId));
  const [board] = opts.forUpdate ? await q.for('update') : await q;
  if (!board) throw new AppError('not_found');
  return { ...access, board };
}

export async function loadDrawing(db: DbOrTx, a: DriveActor, nodeId: string) {
  const access = await loadNode(db, a, nodeId);
  if (access.node.type !== 'drawing') throw new AppError('not_found');
  const [drawing] = await db.select().from(drawings).where(eq(drawings.nodeId, nodeId));
  if (!drawing) throw new AppError('not_found');
  return { ...access, drawing };
}

/** A live card of a board the caller can see. */
export async function loadCard(
  db: DbOrTx,
  a: DriveActor,
  cardId: string,
  opts: { includeDeleted?: boolean } = {},
) {
  const [card] = await db
    .select()
    .from(boardCards)
    .where(and(eq(boardCards.id, cardId), eq(boardCards.orgId, a.org.id)));
  if (!card) throw new AppError('not_found');
  if (card.deletedAt && !opts.includeDeleted) throw new AppError('not_found');
  const access = await loadBoard(db, a, card.boardNodeId);
  return { ...access, card };
}

export function requireRole(
  a: DriveActor,
  role: SpaceRole | null,
  action: 'view' | 'comment' | 'edit',
) {
  const map = { view: 'space.view', comment: 'space.comment', edit: 'space.edit_content' } as const;
  if (!can(a.actor, map[action], nodeResource(a, role))) {
    throw new AppError(role === null ? 'not_found' : 'forbidden');
  }
}

/** Columns, labels and WIP limits: space admins and owners, or whoever created the board. */
export function canManage(a: DriveActor, access: Pick<NodeAccess, 'role' | 'node'>) {
  return (
    atLeast(access.role, 'admin') ||
    (access.node.createdBy === a.userId && atLeast(access.role, 'editor'))
  );
}

export function requireManage(a: DriveActor, access: Pick<NodeAccess, 'role' | 'node'>) {
  if (!canManage(a, access)) throw new AppError('forbidden', { reason: 'board_settings' });
}

/**
 * People who can see a node: space members plus person shares on it or an ancestor.
 * They are the ones a card can be assigned to.
 */
export async function nodeAudience(
  db: DbOrTx,
  node: { spaceId: string; path: string },
): Promise<UserSummary[]> {
  const members = await db
    .select({ id: spaceMembers.userId })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, node.spaceId));
  const shareRows = await db
    .select({ id: shares.granteeUserId, path: nodes.path })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .where(
      and(
        eq(nodes.spaceId, node.spaceId),
        eq(shares.kind, 'user'),
        isNull(nodes.deletedAt),
        or(isNull(shares.expiresAt), sql`${shares.expiresAt} > now()`),
      ),
    );
  const ids = new Set(members.map((m) => m.id));
  for (const s of shareRows) if (s.id && isAncestorOrSelf(s.path, node.path)) ids.add(s.id);
  if (ids.size === 0) return [];
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, image: users.image })
    .from(users)
    .where(inArray(users.id, [...ids]));
  return rows
    .map((u) => ({ id: u.id, name: u.name, email: u.email, imageUrl: u.image }))
    .sort((x, y) => x.name.localeCompare(y.name, 'tr'));
}

export async function userSummaries(db: DbOrTx, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return new Map<string, UserSummary>();
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, image: users.image })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(
    rows.map((u) => [u.id, { id: u.id, name: u.name, email: u.email, imageUrl: u.image }]),
  );
}

/** Marks the board changed: rev++ and the node's updated_at/by (Drive sorts by it). */
export async function touchBoard(db: DbOrTx, boardId: string, userId: string) {
  const [row] = await db
    .update(boards)
    .set({ rev: sql`${boards.rev} + 1`, updatedAt: new Date() })
    .where(eq(boards.nodeId, boardId))
    .returning({ rev: boards.rev });
  await db
    .update(nodes)
    .set({ updatedAt: new Date(), updatedBy: userId })
    .where(eq(nodes.id, boardId));
  return row?.rev ?? 0;
}
