import { and, desc, eq, sql } from 'drizzle-orm';
import { nodes, organizations, orgMembers, uploadRequests, users } from '@crewhall/db';
import {
  MICROSOFT_WEB_PATHS,
  UPLOAD_REQUEST_LIMITS,
  type CreateUploadRequest,
  type OrgSettings,
  type PublicUploadRequest,
  type UploadRequest,
  type UploadToRequest,
} from '@crewhall/shared';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { OrgRow, RequestInfo } from '../../http/types';
import type { DriveActor } from '../drive/access';
import { identityAudit } from '../identity/audit';
import { randomBase62, sha256 } from '../identity/crypto';
import { take } from '../mcp/rate-limit';
import { toActor } from '../membership';
import { ensureFolder } from '../portal/nodes';
import { ensurePersonalSpace } from '../spaces';
import { integrationOn, requireIntegration } from './app';
import { storeBytes, writableTarget } from './drive-store';

/**
 * "Bana dosya yükle" (Outlook add-in): a public link that lets anyone upload files into one
 * folder until it expires. Uploads are stored as the person who made the link, in their
 * rights and quota; the link never lists or hands out what is in the folder.
 */

type Row = typeof uploadRequests.$inferSelect;
const DAY = 24 * 60 * 60 * 1000;

function view(row: Row, folderName: string, url?: string): UploadRequest {
  return {
    id: row.id,
    folderId: row.folderId,
    folderName,
    spaceId: row.spaceId,
    ...(url ? { url } : {}),
    expiresAt: row.expiresAt.toISOString(),
    passwordProtected: row.passwordHash !== null,
    uploads: row.uploads,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export async function createUploadRequest(
  deps: Pick<Deps, 'db' | 'env'>,
  a: DriveActor & { userName: string },
  input: CreateUploadRequest,
  req: RequestInfo,
): Promise<UploadRequest> {
  requireIntegration(a.org, 'outlook');
  const expiresAt = input.expiresAt
    ? new Date(input.expiresAt)
    : new Date(Date.now() + UPLOAD_REQUEST_LIMITS.defaultDays * DAY);
  if (
    expiresAt.getTime() <= Date.now() ||
    expiresAt.getTime() > Date.now() + UPLOAD_REQUEST_LIMITS.maxDays * DAY + 60_000
  ) {
    throw new AppError('validation_failed', {
      in: 'body',
      issues: [{ path: ['expiresAt'], code: 'out_of_range', message: 'expiresAt' }],
    });
  }
  const spaceId =
    input.spaceId ??
    (await ensurePersonalSpace(deps.db, a.org.id, { id: a.userId, name: a.userName })).id;
  await writableTarget(deps, a, spaceId, input.parentId ?? null);
  const folderId = await ensureFolder(deps.db, {
    orgId: a.org.id,
    spaceId,
    parentId: input.parentId ?? null,
    name: input.folderName,
    userId: a.userId,
  });
  const token = randomBase62(32);
  const [row] = await deps.db
    .insert(uploadRequests)
    .values({
      orgId: a.org.id,
      spaceId,
      folderId,
      createdBy: a.userId,
      tokenHash: sha256(token),
      passwordHash: input.password ? await hashPassword(input.password) : null,
      expiresAt,
    })
    .returning();
  await identityAudit(
    deps.db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'microsoft.upload_request.create',
      targetType: 'node',
      targetId: folderId,
      meta: { request: row!.id, expiresAt, password: Boolean(input.password) },
    },
    req,
  );
  const url = `${deps.env.HUB_URL.replace(/\/+$/, '')}${MICROSOFT_WEB_PATHS.uploadRequest(token)}`;
  return view(row!, input.folderName, url);
}

export async function listUploadRequests(deps: Pick<Deps, 'db'>, a: DriveActor) {
  const rows = await deps.db
    .select({ row: uploadRequests, folderName: nodes.name })
    .from(uploadRequests)
    .innerJoin(nodes, eq(nodes.id, uploadRequests.folderId))
    .where(and(eq(uploadRequests.orgId, a.org.id), eq(uploadRequests.createdBy, a.userId)))
    .orderBy(desc(uploadRequests.createdAt))
    .limit(50);
  return rows.map((r) => view(r.row, r.folderName));
}

export async function revokeUploadRequest(
  deps: Pick<Deps, 'db'>,
  a: DriveActor,
  id: string,
  req: RequestInfo,
) {
  const [row] = await deps.db
    .update(uploadRequests)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(uploadRequests.id, id),
        eq(uploadRequests.orgId, a.org.id),
        eq(uploadRequests.createdBy, a.userId),
      ),
    )
    .returning();
  if (!row) throw new AppError('not_found');
  await identityAudit(
    deps.db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'microsoft.upload_request.revoke',
      targetType: 'node',
      targetId: row.folderId,
      meta: { request: row.id },
    },
    req,
  );
}

/** An open request with its org, folder and creator; closed ones answer 410. */
async function openRequest(deps: Pick<Deps, 'db'>, token: string) {
  const [row] = await deps.db
    .select({
      request: uploadRequests,
      org: organizations,
      folder: nodes,
      creator: users,
      member: orgMembers,
    })
    .from(uploadRequests)
    .innerJoin(organizations, eq(organizations.id, uploadRequests.orgId))
    .innerJoin(nodes, eq(nodes.id, uploadRequests.folderId))
    .innerJoin(users, eq(users.id, uploadRequests.createdBy))
    .innerJoin(
      orgMembers,
      and(eq(orgMembers.userId, users.id), eq(orgMembers.organizationId, uploadRequests.orgId)),
    )
    .where(eq(uploadRequests.tokenHash, sha256(token)));
  if (!row) throw new AppError('not_found');
  const closed =
    row.request.revokedAt !== null ||
    row.request.expiresAt.getTime() <= Date.now() ||
    row.folder.deletedAt !== null ||
    row.member.status !== 'active' ||
    !integrationOn(row.org.settings as OrgSettings, 'outlook');
  if (closed) throw new AppError('upload_request_closed');
  return row;
}

export async function publicUploadRequest(
  deps: Pick<Deps, 'db'>,
  token: string,
): Promise<PublicUploadRequest> {
  const row = await openRequest(deps, token);
  return {
    requestedBy: row.creator.name,
    orgName: row.org.branding.orgName ?? row.org.name,
    folderName: row.folder.name,
    expiresAt: row.request.expiresAt.toISOString(),
    passwordRequired: row.request.passwordHash !== null,
    maxFileBytes: UPLOAD_REQUEST_LIMITS.fileBytes,
  };
}

export async function uploadToRequest(
  deps: Deps,
  token: string,
  input: UploadToRequest,
  req: RequestInfo,
) {
  const row = await openRequest(deps, token);
  // Per link and per address: a leaked link cannot fill the folder in minutes.
  const perLink = await take(
    deps.db,
    `upload_request:${row.request.id}`,
    { kind: 'upload_request', perMinute: UPLOAD_REQUEST_LIMITS.filesPerMinute },
    row.org.id,
  );
  const perIp = req.ip
    ? await take(
        deps.db,
        `upload_ip:${req.ip}`,
        { kind: 'upload_request_ip', perMinute: 10 },
        row.org.id,
      )
    : { allowed: true, retryAfter: 0 };
  if (!perLink.allowed || !perIp.allowed) {
    throw new AppError('rate_limited', {
      retryAfter: Math.max(perLink.retryAfter, perIp.retryAfter),
    });
  }
  if (row.request.passwordHash) {
    const ok = input.password
      ? await verifyPassword({ hash: row.request.passwordHash, password: input.password })
      : false;
    if (!ok)
      throw new AppError(input.password ? 'share_password_invalid' : 'share_password_required');
  }
  const content = Buffer.from(input.contentBase64, 'base64');
  if (!content.length) throw new AppError('upload_invalid', { reason: 'empty' });
  if (content.length > UPLOAD_REQUEST_LIMITS.fileBytes) {
    throw new AppError('file_too_large', { maxFileBytes: UPLOAD_REQUEST_LIMITS.fileBytes });
  }
  const a: DriveActor = {
    org: row.org as OrgRow,
    actor: toActor(row.member),
    userId: row.creator.id,
  };
  // The uploader cannot pick a name that hides as a folder path or a dotfile.
  const name = input.name.replace(/[\\/]/g, '_').replace(/^\.+/, '') || 'dosya';
  await storeBytes(deps, a, {
    spaceId: row.request.spaceId,
    parentId: row.request.folderId,
    name,
    content,
    mime: input.mime,
  });
  await deps.db
    .update(uploadRequests)
    .set({ uploads: sql`${uploadRequests.uploads} + 1` })
    .where(eq(uploadRequests.id, row.request.id));
  await identityAudit(
    deps.db,
    {
      orgId: row.org.id,
      actorId: null,
      action: 'microsoft.upload_request.upload',
      targetType: 'node',
      targetId: row.request.folderId,
      meta: {
        request: row.request.id,
        name,
        size: content.length,
        uploader: input.uploaderName ?? null,
      },
    },
    req,
  );
  return { name, sizeBytes: content.length };
}
