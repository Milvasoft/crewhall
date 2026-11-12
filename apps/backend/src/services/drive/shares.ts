import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import {
  nodes,
  organizations,
  shareAttempts,
  shares,
  spaceMembers,
  users,
  type DbOrTx,
} from '@crewhall/db';
import {
  canGrantSpaceRole,
  type CreateShare,
  type PublicNode,
  type PublicShare,
  type Share,
  paths,
} from '@crewhall/shared';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import { activeOrgMember } from '../spaces';
import { loadNode, nodeResource, type DriveActor, type NodeAccess } from './access';
import { decryptShareToken, encryptShareToken } from './share-token';
import { hiddenNodeTypes, visibleNodeTypes } from '../identity/node-types';
import { fileDownload, filePreview } from './files';
import { can } from '@crewhall/shared';

type ShareRow = typeof shares.$inferSelect;

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const GRANT_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PASSWORD_TRIES = 5;
const PASSWORD_LOCK_MS = 15 * 60 * 1000;

export const shareUrl = (hubUrl: string, token: string) => `${hubUrl}${paths.share(token)}`;

async function toShare(
  db: DbOrTx,
  row: ShareRow,
  forNode: { id: string },
  link: { url?: string; urlLost?: boolean } = {},
): Promise<Share> {
  const people = await db
    .select({ id: users.id, name: users.name, email: users.email, image: users.image })
    .from(users)
    .where(
      sql`${users.id} in (${row.granteeUserId ?? row.createdBy ?? null}, ${row.createdBy ?? null})`,
    );
  const person = (id: string | null) => {
    const u = id ? people.find((p) => p.id === id) : undefined;
    return u ? { id: u.id, name: u.name, email: u.email, imageUrl: u.image } : null;
  };
  let inheritedFrom: Share['inheritedFrom'] = null;
  if (row.nodeId !== forNode.id) {
    const [n] = await db
      .select({ id: nodes.id, name: nodes.name })
      .from(nodes)
      .where(eq(nodes.id, row.nodeId));
    inheritedFrom = n ?? null;
  }
  return {
    id: row.id,
    nodeId: row.nodeId,
    kind: row.kind,
    role: row.role,
    grantee: person(row.granteeUserId),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    allowDownload: row.allowDownload,
    hasPassword: row.passwordHash !== null,
    inheritedFrom,
    openCount: row.openCount,
    createdBy: person(row.createdBy),
    createdAt: row.createdAt.toISOString(),
    ...(link.url ? { url: link.url } : {}),
    ...(link.urlLost ? { urlLost: true } : {}),
  };
}

/** May share links on this node (doc 17 §5), without throwing. */
function canShareLink(a: DriveActor, access: NodeAccess) {
  return can(a.actor, 'space.share_link', {
    ...nodeResource(a, access.role),
    editorsCanShareLinks: access.space.settings.editorsCanShareLinks === true,
  });
}

/**
 * The address of a link for this viewer (H16): its maker and people who may share links on
 * the node see it; links from before the stored token only say they can't be shown.
 */
function linkAddress(
  deps: Pick<Deps, 'env'>,
  a: DriveActor,
  access: NodeAccess,
  row: ShareRow,
): { url?: string; urlLost?: boolean } {
  if (row.kind !== 'link') return {};
  if (row.createdBy !== a.userId && !canShareLink(a, access)) return {};
  if (!row.tokenEnc) return { urlLost: true };
  const token = decryptShareToken(deps.env.AUTH_SECRET, row.tokenEnc);
  return token ? { url: shareUrl(deps.env.HUB_URL, token) } : { urlLost: true };
}

/** Who may change a share of this kind: share_user for people, share_link for links (doc 17 §5). */
function requireShareRight(a: DriveActor, access: NodeAccess, kind: 'user' | 'link') {
  if (kind === 'user') {
    if (!can(a.actor, 'space.share_user', nodeResource(a, access.role)))
      throw new AppError('forbidden');
    return;
  }
  const resource = {
    ...nodeResource(a, access.role),
    editorsCanShareLinks: access.space.settings.editorsCanShareLinks === true,
  };
  if (!can(a.actor, 'space.share_link', resource)) throw new AppError('forbidden');
}

export async function listShares(deps: Pick<Deps, 'db' | 'env'>, a: DriveActor, nodeId: string) {
  const { db } = deps;
  const access = await loadNode(db, a, nodeId);
  const rows = await db
    .select({ share: shares })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .where(sql`${nodes.path} @> ${access.node.path}::ltree`)
    .orderBy(asc(shares.createdAt));
  const [members] = await db
    .select({ n: count() })
    .from(spaceMembers)
    .where(eq(spaceMembers.spaceId, access.space.id));
  const items: Share[] = [];
  for (const r of rows) {
    items.push(await toShare(db, r.share, access.node, linkAddress(deps, a, access, r.share)));
  }
  return {
    items,
    space: { id: access.space.id, name: access.space.name, memberCount: members?.n ?? 0 },
  };
}

export async function createShare(
  deps: Deps,
  a: DriveActor,
  nodeId: string,
  input: CreateShare,
  req: RequestInfo,
): Promise<Share> {
  const { db } = deps;
  const access = await loadNode(db, a, nodeId);
  requireShareRight(a, access, input.kind);
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (input.kind === 'user') {
    // Nobody grants more than they have (doc 17 §5).
    if (!canGrantSpaceRole(access.role, input.role))
      throw new AppError('forbidden', { reason: 'role_too_high' });
    if (!(await activeOrgMember(db, a.org.id, input.userId)))
      throw new AppError('member_not_found');
    const [row] = await db
      .insert(shares)
      .values({
        orgId: a.org.id,
        nodeId,
        kind: 'user',
        granteeUserId: input.userId,
        role: input.role,
        expiresAt,
        createdBy: a.userId,
      })
      .onConflictDoUpdate({
        target: [shares.nodeId, shares.granteeUserId],
        targetWhere: sql`${shares.kind} = 'user'`,
        set: { role: input.role, expiresAt },
      })
      .returning();
    await audit(
      db,
      {
        orgId: a.org.id,
        actorId: a.userId,
        action: 'share.user.create',
        targetType: 'node',
        targetId: nodeId,
        meta: { shareId: row!.id, userId: input.userId, role: input.role },
      },
      req,
    );
    return toShare(db, row!, access.node);
  }
  const token = randomBytes(24).toString('base64url');
  const [row] = await db
    .insert(shares)
    .values({
      orgId: a.org.id,
      nodeId,
      kind: 'link',
      role: 'viewer',
      tokenHash: sha256(token),
      tokenEnc: encryptShareToken(deps.env.AUTH_SECRET, token),
      passwordHash: input.password ? await hashPassword(input.password) : null,
      expiresAt,
      allowDownload: input.allowDownload,
      createdBy: a.userId,
    })
    .returning();
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'share.link.create',
      targetType: 'node',
      targetId: nodeId,
      meta: {
        shareId: row!.id,
        password: Boolean(input.password),
        expiresAt,
        allowDownload: input.allowDownload,
      },
    },
    req,
  );
  return toShare(db, row!, access.node, { url: shareUrl(deps.env.HUB_URL, token) });
}

async function shareForChange(db: DbOrTx, a: DriveActor, shareId: string) {
  const [row] = await db
    .select()
    .from(shares)
    .where(and(eq(shares.id, shareId), eq(shares.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  const access = await loadNode(db, a, row.nodeId);
  requireShareRight(a, access, row.kind);
  return { row, access };
}

export async function updateShare(
  db: DbOrTx,
  a: DriveActor,
  shareId: string,
  input: {
    role?: 'viewer' | 'editor' | undefined;
    expiresAt?: string | null | undefined;
    allowDownload?: boolean | undefined;
    password?: string | null | undefined;
  },
  req: RequestInfo,
) {
  const { row, access } = await shareForChange(db, a, shareId);
  const patch: Partial<ShareRow> = {};
  if (input.role !== undefined) {
    if (row.kind === 'link' && input.role !== 'viewer') {
      throw new AppError('validation_failed', {
        in: 'body',
        issues: [{ path: ['role'], code: 'links_read_only', message: 'links are read-only' }],
      });
    }
    if (!canGrantSpaceRole(access.role, input.role))
      throw new AppError('forbidden', { reason: 'role_too_high' });
    patch.role = input.role;
  }
  if (input.expiresAt !== undefined)
    patch.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (input.allowDownload !== undefined) patch.allowDownload = input.allowDownload;
  if (input.password !== undefined && row.kind === 'link') {
    patch.passwordHash = input.password ? await hashPassword(input.password) : null;
  }
  const [updated] = await db.update(shares).set(patch).where(eq(shares.id, row.id)).returning();
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'share.update',
      targetType: 'node',
      targetId: row.nodeId,
      meta: { shareId: row.id, fields: Object.keys(patch) },
    },
    req,
  );
  return toShare(db, updated!, access.node);
}

export async function deleteShare(db: DbOrTx, a: DriveActor, shareId: string, req: RequestInfo) {
  const { row } = await shareForChange(db, a, shareId);
  await db.delete(shares).where(eq(shares.id, row.id));
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'share.delete',
      targetType: 'node',
      targetId: row.nodeId,
      meta: { shareId: row.id, kind: row.kind },
    },
    req,
  );
}

export async function regenerateLink(deps: Deps, a: DriveActor, shareId: string, req: RequestInfo) {
  const { db } = deps;
  const { row, access } = await shareForChange(db, a, shareId);
  if (row.kind !== 'link') throw new AppError('bad_request', { reason: 'not_a_link' });
  const token = randomBytes(24).toString('base64url');
  const [updated] = await db
    .update(shares)
    .set({ tokenHash: sha256(token), tokenEnc: encryptShareToken(deps.env.AUTH_SECRET, token) })
    .where(eq(shares.id, row.id))
    .returning();
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'share.link.regenerate',
      targetType: 'node',
      targetId: row.nodeId,
      meta: { shareId: row.id },
    },
    req,
  );
  return toShare(db, updated!, access.node, { url: shareUrl(deps.env.HUB_URL, token) });
}

/* --------------------------- public links (/s/:token) --------------------------- */

function signGrant(secret: string, shareId: string, exp: number) {
  const sig = createHmac('sha256', secret)
    .update(`share-grant:${shareId}:${exp}`)
    .digest('base64url');
  return `${exp}.${sig}`;
}

function grantValid(secret: string, shareId: string, grant: string | undefined) {
  if (!grant) return false;
  const [expRaw, sig] = grant.split('.');
  const exp = Number(expRaw);
  if (!sig || !Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = Buffer.from(signGrant(secret, shareId, exp));
  const given = Buffer.from(grant);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

interface ResolvedLink {
  share: ShareRow;
  node: typeof nodes.$inferSelect;
  orgName: string;
  sharedByName: string;
}

/**
 * Unknown, revoked and deleted links all answer 404 so links cannot be guessed (19.3);
 * an expired link answers 410 with who shared it.
 */
async function resolveLink(db: DbOrTx, token: string): Promise<ResolvedLink> {
  const [row] = await db
    .select({ share: shares, node: nodes, org: organizations, by: users.name })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .innerJoin(organizations, eq(organizations.id, shares.orgId))
    .leftJoin(users, eq(users.id, shares.createdBy))
    .where(and(eq(shares.tokenHash, sha256(token)), eq(shares.kind, 'link')));
  if (!row || row.node.deletedAt) throw new AppError('not_found');
  if (!row.org.settings.publicLinksEnabled) throw new AppError('not_found');
  const sharedByName = row.by ?? row.org.branding.orgName;
  if (row.share.expiresAt && row.share.expiresAt.getTime() <= Date.now()) {
    throw new AppError('share_expired', { sharedByName });
  }
  return { share: row.share, node: row.node, orgName: row.org.branding.orgName, sharedByName };
}

function requireGrant(secret: string, link: ResolvedLink, grant: string | undefined) {
  if (link.share.passwordHash && !grantValid(secret, link.share.id, grant)) {
    throw new AppError('share_password_required');
  }
}

async function childrenFlag(db: DbOrTx, ids: string[]) {
  if (ids.length === 0) return new Set<string>();
  const rows = await db
    .selectDistinct({ id: nodes.parentId })
    .from(nodes)
    .where(
      and(
        sql`${nodes.parentId} in (${sql.join(
          ids.map((i) => sql`${i}::uuid`),
          sql`, `,
        )})`,
        isNull(nodes.deletedAt),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

async function toPublicNodes(
  db: DbOrTx,
  rows: (typeof nodes.$inferSelect)[],
): Promise<PublicNode[]> {
  const kids = await childrenFlag(
    db,
    rows.map((r) => r.id),
  );
  const previews = rows.length
    ? await db.execute<{ node_id: string; preview_status: string }>(sql`
        select n.id as node_id, b.preview_status from ${nodes} n
        join node_versions v on v.id = n.current_version_id
        join blobs b on b.id = v.blob_id
        where n.id in (${sql.join(
          rows.map((r) => sql`${r.id}::uuid`),
          sql`, `,
        )})`)
    : { rows: [] };
  const preview = new Map(previews.rows.map((p) => [p.node_id, p.preview_status]));
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    mime: r.mime,
    sizeBytes: r.sizeBytes,
    hasChildren: kids.has(r.id),
    preview: (preview.get(r.id) ?? 'none') as PublicNode['preview'],
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function publicShare(
  deps: Deps,
  token: string,
  grant: string | undefined,
  req: RequestInfo,
): Promise<PublicShare> {
  const { db } = deps;
  const link = await resolveLink(db, token);
  const base = { orgName: link.orgName, sharedBy: { name: link.sharedByName } };
  if (link.share.passwordHash && !grantValid(deps.env.AUTH_SECRET, link.share.id, grant)) {
    // Name, type and size stay hidden until the password is given (19.2).
    return { status: 'password_required', ...base };
  }
  const [counted] = await db
    .update(shares)
    .set({
      openCount: sql`${shares.openCount} + 1`,
      firstOpenedAt: sql`coalesce(${shares.firstOpenedAt}, now())`,
    })
    .where(eq(shares.id, link.share.id))
    .returning({ first: shares.firstOpenedAt, n: shares.openCount });
  if (counted?.n === 1) {
    await audit(
      db,
      {
        orgId: link.share.orgId,
        actorId: null,
        action: 'share.link.open',
        targetType: 'node',
        targetId: link.node.id,
        meta: { shareId: link.share.id },
      },
      req,
    );
  }
  const [node] = await toPublicNodes(db, [link.node]);
  return {
    status: 'ok',
    ...base,
    node: node!,
    allowDownload: link.share.allowDownload,
    expiresAt: link.share.expiresAt?.toISOString() ?? null,
  };
}

/** Password check, 5 tries per link and IP, then 15 minutes locked (19.2). */
export async function unlockPublicShare(
  deps: Deps,
  token: string,
  password: string,
  req: RequestInfo,
) {
  const { db } = deps;
  const link = await resolveLink(db, token);
  if (!link.share.passwordHash) {
    const exp = Date.now() + GRANT_TTL_MS;
    return {
      grant: signGrant(deps.env.AUTH_SECRET, link.share.id, exp),
      expiresAt: new Date(exp).toISOString(),
    };
  }
  const ip = req.ip ?? 'unknown';
  const [attempt] = await db
    .select()
    .from(shareAttempts)
    .where(and(eq(shareAttempts.shareId, link.share.id), eq(shareAttempts.ip, ip)));
  if (attempt?.lockedUntil && attempt.lockedUntil.getTime() > Date.now()) {
    throw new AppError('share_locked', { lockedUntil: attempt.lockedUntil.toISOString() });
  }
  if (await verifyPassword({ hash: link.share.passwordHash, password })) {
    await db
      .delete(shareAttempts)
      .where(and(eq(shareAttempts.shareId, link.share.id), eq(shareAttempts.ip, ip)));
    const exp = Date.now() + GRANT_TTL_MS;
    return {
      grant: signGrant(deps.env.AUTH_SECRET, link.share.id, exp),
      expiresAt: new Date(exp).toISOString(),
    };
  }
  const failed = (attempt && !attempt.lockedUntil ? attempt.failedCount : 0) + 1;
  const lockedUntil = failed >= MAX_PASSWORD_TRIES ? new Date(Date.now() + PASSWORD_LOCK_MS) : null;
  await db
    .insert(shareAttempts)
    .values({ shareId: link.share.id, ip, failedCount: lockedUntil ? 0 : failed, lockedUntil })
    .onConflictDoUpdate({
      target: [shareAttempts.shareId, shareAttempts.ip],
      set: { failedCount: lockedUntil ? 0 : failed, lockedUntil },
    });
  await audit(
    db,
    {
      orgId: link.share.orgId,
      actorId: null,
      action: lockedUntil ? 'share.link.locked' : 'share.link.password_failed',
      targetType: 'node',
      targetId: link.node.id,
      meta: { shareId: link.share.id, ip },
    },
    req,
  );
  if (lockedUntil) throw new AppError('share_locked', { lockedUntil: lockedUntil.toISOString() });
  throw new AppError('share_password_invalid', { remainingAttempts: MAX_PASSWORD_TRIES - failed });
}

/** A node inside the shared subtree (the shared node itself when `nodeId` is omitted). */
async function nodeInLink(db: DbOrTx, link: ResolvedLink, nodeId: string | undefined) {
  if (!nodeId || nodeId === link.node.id) return link.node;
  const [row] = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.id, nodeId),
        isNull(nodes.deletedAt),
        sql`${nodes.path} <@ ${link.node.path}::ltree`,
      ),
    );
  if (!row) throw new AppError('not_found');
  return row;
}

export async function publicChildren(
  deps: Deps,
  token: string,
  q: {
    grant?: string | undefined;
    parentId?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
) {
  const { db } = deps;
  const link = await resolveLink(db, token);
  requireGrant(deps.env.AUTH_SECRET, link, q.grant);
  const parent = await nodeInLink(db, link, q.parentId);
  if (parent.type !== 'folder') throw new AppError('bad_request', { reason: 'not_a_folder' });
  const typeFilter = visibleNodeTypes(await hiddenNodeTypes(db, parent.orgId));
  const offset = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString('utf8')) || 0 : 0;
  const rows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.parentId, parent.id), isNull(nodes.deletedAt), typeFilter))
    .orderBy(sql`(${nodes.type} <> 'folder')`, asc(nodes.name), asc(nodes.id))
    .limit(q.limit + 1)
    .offset(offset);
  const pageRows = rows.slice(0, q.limit);
  return {
    items: await toPublicNodes(db, pageRows),
    nextCursor:
      rows.length > q.limit ? Buffer.from(String(offset + q.limit)).toString('base64url') : null,
  };
}

export async function publicDownload(
  deps: Deps,
  token: string,
  q: {
    grant?: string | undefined;
    nodeId?: string | undefined;
    disposition?: 'attachment' | 'inline' | undefined;
  },
) {
  const link = await resolveLink(deps.db, token);
  requireGrant(deps.env.AUTH_SECRET, link, q.grant);
  if (!link.share.allowDownload) throw new AppError('forbidden', { reason: 'download_disabled' });
  return fileDownload(deps, await nodeInLink(deps.db, link, q.nodeId), undefined, q.disposition);
}

export async function publicPreview(
  deps: Deps,
  token: string,
  q: {
    grant?: string | undefined;
    nodeId?: string | undefined;
    kind: 'thumb_256' | 'thumb_1024' | 'pdf_p1' | 'poster';
  },
) {
  const link = await resolveLink(deps.db, token);
  requireGrant(deps.env.AUTH_SECRET, link, q.grant);
  return filePreview(deps, await nodeInLink(deps.db, link, q.nodeId), q.kind);
}

/**
 * For the public views of other modules (a page, a board): the node a link opens, after the
 * same checks as the Drive endpoints (link alive, password grant, node inside the share).
 */
export async function publicNodeOf(
  deps: Deps,
  token: string,
  q: { grant?: string | undefined; nodeId?: string | undefined },
) {
  const link = await resolveLink(deps.db, token);
  requireGrant(deps.env.AUTH_SECRET, link, q.grant);
  return {
    node: await nodeInLink(deps.db, link, q.nodeId),
    root: link.node,
    allowDownload: link.share.allowDownload,
  };
}
