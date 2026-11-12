import { and, eq } from 'drizzle-orm';
import { orgMembers, organizations, pages, type DbOrTx } from '@crewhall/db';
import { liveMember } from '../guests';
import { can, type SpaceRole } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { toActor } from '../membership';
import { loadNode, nodeResource, type DriveActor, type NodeAccess } from '../drive/access';
import { stateFromJson, emptyPageDoc } from './doc';

export type PageRow = typeof pages.$inferSelect;

export interface PageAccess extends NodeAccess {
  page: PageRow;
}

/**
 * A page node of the active org with the caller's role (404 when unseen or not a page).
 * Pages made outside the wiki (e.g. an older Drive copy) get their row on first open.
 */
export async function loadPage(
  db: DbOrTx,
  a: DriveActor,
  nodeId: string,
  options: { includeTrashed?: boolean } = {},
): Promise<PageAccess> {
  const access = await loadNode(db, a, nodeId, options);
  if (access.node.type !== 'page') throw new AppError('not_found');
  return { ...access, page: await ensurePageRow(db, access.node.id, access.node.orgId) };
}

export async function ensurePageRow(db: DbOrTx, nodeId: string, orgId: string): Promise<PageRow> {
  const [row] = await db.select().from(pages).where(eq(pages.nodeId, nodeId));
  if (row) return row;
  await db
    .insert(pages)
    .values({ nodeId, orgId, ydoc: stateFromJson(emptyPageDoc()) })
    .onConflictDoNothing();
  const [created] = await db.select().from(pages).where(eq(pages.nodeId, nodeId));
  return created!;
}

export const canDo = (a: DriveActor, role: SpaceRole | null, action: Parameters<typeof can>[1]) =>
  can(a.actor, action, nodeResource(a, role));

/** Body edits: editor role and an unlocked page. */
export const canEditBody = (a: DriveActor, access: PageAccess) =>
  canDo(a, access.role, 'space.edit_content') && !access.page.locked;

export function requirePage(a: DriveActor, access: PageAccess, action: Parameters<typeof can>[1]) {
  if (!canDo(a, access.role, action)) {
    throw new AppError(access.role === null ? 'not_found' : 'forbidden');
  }
}

/** The DriveActor of a person in an org, outside an HTTP request (collab, worker). */
export async function actorFor(
  db: DbOrTx,
  orgId: string,
  userId: string,
): Promise<DriveActor | null> {
  const [row] = await db
    .select({ org: organizations, member: orgMembers })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.organizationId))
    .where(and(eq(orgMembers.organizationId, orgId), eq(orgMembers.userId, userId), liveMember()));
  if (!row) return null;
  return { org: row.org, actor: toActor(row.member), userId };
}
