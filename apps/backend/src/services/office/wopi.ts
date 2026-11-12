import { Readable } from 'node:stream';
import { and, eq, sql } from 'drizzle-orm';
import {
  blobs,
  newId,
  nodeVersions,
  orgMembers,
  organizations,
  users,
  wopiLocks,
} from '@crewhall/db';
import { can } from '@crewhall/shared';
import type { Context, Hono } from 'hono';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { AppEnv } from '../../http/types';
import { publishNodeChanges } from '../../realtime/events';
import { putStream, TooLargeError } from '../../storage/stream';
import {
  loadNode,
  nodeResource,
  type DriveActor,
  type NodeRow,
  type SpaceRow,
} from '../drive/access';
import { commitFile, requireStorage } from '../drive/files';
import { assertQuota, orgLimits } from '../drive/quota';
import { nodesByIds } from '../drive/tree';
import { needsTwoFactorEnrolment, toActor } from '../membership';
import { moduleOn } from '../mcp/policy';
import { loadOfficeSettings } from './settings';
import { readWopiToken, type WopiGrant } from './token';

/**
 * WOPI host endpoints (MS-WOPI; Collabora Online and Office Online style servers). The document
 * server calls them with the access token from openOfficeSession:
 *
 *   GET  /wopi/files/:id            CheckFileInfo
 *   GET  /wopi/files/:id/contents   GetFile
 *   POST /wopi/files/:id/contents   PutFile (X-WOPI-Override: PUT) → a new Drive version
 *   POST /wopi/files/:id            LOCK, GET_LOCK, REFRESH_LOCK, UNLOCK (X-WOPI-Override)
 *
 * Every call checks the token, the org's office switch and the person's current rights with
 * `can()`. The calls come from the document server, not the person's browser, so the org's IP
 * allow list does not apply here.
 */

export const WOPI_PREFIX = '/wopi/files';
/** WOPI lock lifetime (MS-WOPI: 30 minutes unless refreshed). */
export const WOPI_LOCK_MS = 30 * 60 * 1000;

interface WopiCtx {
  deps: Deps;
  c: Context<AppEnv>;
  grant: WopiGrant;
  a: DriveActor;
  user: typeof users.$inferSelect;
  node: NodeRow;
  space: SpaceRow;
  canWrite: boolean;
}

class WopiStatus extends Error {
  constructor(
    readonly status: number,
    readonly headers: Record<string, string> = {},
    readonly body: string | null = null,
  ) {
    super(`wopi ${status}`);
  }
}

/** Version identity and time the editor compares saves against. */
async function currentState(deps: Deps, node: NodeRow) {
  if (!node.currentVersionId) return { versionId: node.id, modified: node.updatedAt, number: 0 };
  const [v] = await deps.db
    .select({ id: nodeVersions.id, at: nodeVersions.createdAt, n: nodeVersions.version })
    .from(nodeVersions)
    .where(eq(nodeVersions.id, node.currentVersionId));
  return { versionId: v?.id ?? node.id, modified: v?.at ?? node.updatedAt, number: v?.n ?? 0 };
}

async function authenticate(deps: Deps, c: Context<AppEnv>, nodeId: string): Promise<WopiCtx> {
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  const token = c.req.query('access_token') ?? bearer ?? '';
  const grant = readWopiToken(deps.env.AUTH_SECRET, token);
  if (!grant || grant.n !== nodeId || grant.p !== 'wopi') throw new WopiStatus(401);
  const [row] = await deps.db
    .select({ member: orgMembers, org: organizations, user: users })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.organizationId))
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(
      and(
        eq(orgMembers.organizationId, grant.o),
        eq(orgMembers.userId, grant.u),
        eq(orgMembers.status, 'active'),
      ),
    );
  if (!row) throw new WopiStatus(401);
  const settings = await loadOfficeSettings(deps.db, row.org.id);
  if (!moduleOn(row.org, 'office') || !settings?.enabled || settings.serverType !== 'wopi') {
    throw new WopiStatus(401);
  }
  if (await needsTwoFactorEnrolment(deps.db, row.org, row.member, row.user)) {
    throw new WopiStatus(401);
  }
  const a: DriveActor = { org: row.org, actor: toActor(row.member), userId: row.user.id };
  let access;
  try {
    access = await loadNode(deps.db, a, nodeId);
  } catch {
    throw new WopiStatus(404);
  }
  if (access.node.type !== 'file') throw new WopiStatus(404);
  const canWrite =
    grant.w &&
    !access.space.archivedAt &&
    can(a.actor, 'space.edit_content', nodeResource(a, access.role));
  return { deps, c, grant, a, user: row.user, node: access.node, space: access.space, canWrite };
}

function absolute(deps: Deps, url: string | null) {
  if (!url) return undefined;
  try {
    return new URL(url, deps.env.API_URL).toString();
  } catch {
    return undefined;
  }
}

async function checkFileInfo(w: WopiCtx) {
  const state = await currentState(w.deps, w.node);
  const origin = new URL(w.deps.env.HUB_URL).origin;
  return Response.json(
    {
      BaseFileName: w.node.name,
      Size: w.node.sizeBytes,
      Version: state.versionId,
      LastModifiedTime: state.modified.toISOString(),
      OwnerId: w.node.createdBy ?? w.node.orgId,
      UserId: w.user.id,
      UserFriendlyName: w.user.name,
      UserExtraInfo: { avatar: absolute(w.deps, w.user.image) },
      UserCanWrite: w.canWrite,
      ReadOnly: !w.canWrite,
      UserCanNotWriteRelative: true,
      UserCanRename: false,
      SupportsUpdate: true,
      SupportsLocks: true,
      SupportsGetLock: true,
      SupportsExtendedLockLength: true,
      SupportsRename: false,
      PostMessageOrigin: origin,
      // Collabora: no "Save as" to a new file outside Drive's version flow.
      HideSaveOption: false,
      DisableExport: false,
      EnableOwnerTermination: false,
    },
    { headers: { 'X-WOPI-ItemVersion': state.versionId } },
  );
}

async function getFile(w: WopiCtx) {
  const state = await currentState(w.deps, w.node);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'X-WOPI-ItemVersion': state.versionId,
  };
  if (!w.node.currentVersionId) return new Response(new Uint8Array(0), { headers });
  const [row] = await w.deps.db
    .select({ blob: blobs })
    .from(nodeVersions)
    .innerJoin(blobs, eq(blobs.id, nodeVersions.blobId))
    .where(eq(nodeVersions.id, w.node.currentVersionId));
  if (!row) throw new WopiStatus(404);
  if (row.blob.status === 'quarantined') throw new WopiStatus(403);
  const stream = await requireStorage(w.deps).getStream(row.blob.storageKey);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { ...headers, 'Content-Length': String(row.blob.size) },
  });
}

/* --------------------------------- locks --------------------------------- */

async function liveLock(w: WopiCtx) {
  const [row] = await w.deps.db
    .select()
    .from(wopiLocks)
    .where(and(eq(wopiLocks.nodeId, w.node.id), sql`${wopiLocks.expiresAt} > now()`));
  return row ?? null;
}

const conflict = (current: string, reason: string) =>
  new WopiStatus(409, { 'X-WOPI-Lock': current, 'X-WOPI-LockFailureReason': reason });

async function setLock(w: WopiCtx, lock: string) {
  const expiresAt = new Date(Date.now() + WOPI_LOCK_MS);
  await w.deps.db
    .insert(wopiLocks)
    .values({ nodeId: w.node.id, orgId: w.a.org.id, lock, userId: w.user.id, expiresAt })
    .onConflictDoUpdate({
      target: wopiLocks.nodeId,
      set: { lock, userId: w.user.id, expiresAt, updatedAt: new Date() },
    });
}

async function lockOps(w: WopiCtx, override: string) {
  const requested = w.c.req.header('x-wopi-lock') ?? '';
  const current = await liveLock(w);
  const state = await currentState(w.deps, w.node);
  const ok = (extra: Record<string, string> = {}) =>
    new Response(null, {
      status: 200,
      headers: { 'X-WOPI-ItemVersion': state.versionId, ...extra },
    });
  switch (override) {
    case 'GET_LOCK':
      return ok({ 'X-WOPI-Lock': current?.lock ?? '' });
    case 'LOCK': {
      if (!w.canWrite) throw conflict(current?.lock ?? '', 'read-only');
      if (!requested || requested.length > 1024) throw new WopiStatus(400);
      const old = w.c.req.header('x-wopi-oldlock');
      if (old !== undefined) {
        // UnlockAndRelock
        if (!current || current.lock !== old) throw conflict(current?.lock ?? '', 'lock mismatch');
      } else if (current && current.lock !== requested) {
        throw conflict(current.lock, 'locked by another session');
      }
      await setLock(w, requested);
      return ok();
    }
    case 'REFRESH_LOCK':
      if (!current || current.lock !== requested)
        throw conflict(current?.lock ?? '', 'lock mismatch');
      await setLock(w, requested);
      return ok();
    case 'UNLOCK':
      if (!current || current.lock !== requested)
        throw conflict(current?.lock ?? '', 'lock mismatch');
      await w.deps.db.delete(wopiLocks).where(eq(wopiLocks.nodeId, w.node.id));
      return ok();
    case 'PUT_USER_INFO':
      await w.c.req.arrayBuffer().catch(() => undefined);
      return ok();
    default:
      // PUT_RELATIVE, RENAME_FILE, DELETE: Drive owns names and the trash.
      throw new WopiStatus(501);
  }
}

/* --------------------------------- PutFile --------------------------------- */

/** Collabora's answer when the file changed under the editor ("Document has been changed"). */
const changedOnServer = (modified: string) =>
  new WopiStatus(
    409,
    { 'Content-Type': 'application/json' },
    JSON.stringify({ COOLStatusCode: 1010, LastModifiedTime: modified }),
  );

async function putFile(w: WopiCtx) {
  if (!w.canWrite) throw new WopiStatus(401);
  const current = await liveLock(w);
  const presented = w.c.req.header('x-wopi-lock');
  if (current && current.lock !== presented) throw conflict(current.lock, 'lock mismatch');
  const state = await currentState(w.deps, w.node);
  const seen = w.c.req.header('x-cool-wopi-timestamp') ?? w.c.req.header('x-lool-wopi-timestamp');
  if (seen && new Date(seen).getTime() !== state.modified.getTime()) {
    throw changedOnServer(state.modified.toISOString());
  }

  const { db } = w.deps;
  const storage = requireStorage(w.deps);
  const space = w.space;
  const { maxFileBytes } = orgLimits(w.a.org);
  const declared = w.c.req.header('content-length');
  const length = declared && /^\d+$/.test(declared) ? Number(declared) : null;
  if (length !== null && length > maxFileBytes) throw new WopiStatus(413);
  if (length !== null) await assertQuota(db, w.a.org, space, length);

  const storageKey = `orgs/${w.a.org.id}/blobs/${newId()}`;
  let size: number;
  try {
    size = await putStream(
      storage,
      storageKey,
      w.c.req.raw.body as AsyncIterable<Uint8Array> | null,
      w.node.mime ?? 'application/octet-stream',
      maxFileBytes,
    );
  } catch (err) {
    await storage.delete(storageKey).catch(() => undefined);
    if (err instanceof TooLargeError) throw new WopiStatus(413);
    throw err;
  }
  let committed;
  try {
    if (length === null) await assertQuota(db, w.a.org, space, size);
    committed = await db.transaction((tx) =>
      commitFile(tx, w.a, {
        spaceId: w.node.spaceId,
        parentId: w.node.parentId,
        nodeId: w.node.id,
        name: w.node.name,
        storageKey,
        sizeBytes: size,
        mime: w.node.mime,
        source: 'web',
        replace: false,
        // Someone else saved since the checks above: the editor reloads instead of overwriting.
        baseVersion: state.number,
      }),
    );
  } catch (err) {
    await storage.delete(storageKey).catch(() => undefined);
    if (err instanceof AppError && err.code === 'version_conflict') {
      const fresh = await currentState(
        w.deps,
        (await nodesByIds(db, w.a.org.id, [w.node.id]))[0] ?? w.node,
      );
      throw changedOnServer(fresh.modified.toISOString());
    }
    throw err;
  }
  await w.deps.jobs.send('blob.process', { blobId: committed.blobId });
  const [row] = await nodesByIds(db, w.a.org.id, [w.node.id]);
  if (row) await publishNodeChanges(w.deps, [row], 'updated');
  return Response.json(
    { LastModifiedTime: committed.version.createdAt.toISOString() },
    { headers: { 'X-WOPI-ItemVersion': committed.version.id } },
  );
}

/* -------------------------------- routing -------------------------------- */

function errorResponse(deps: Deps, err: unknown) {
  if (err instanceof WopiStatus) {
    return new Response(err.body, { status: err.status, headers: err.headers });
  }
  if (err instanceof AppError) {
    const status =
      err.code === 'quota_exceeded' || err.code === 'file_too_large'
        ? 413
        : err.code === 'not_found'
          ? 404
          : err.code === 'forbidden' || err.code === 'unauthenticated'
            ? 401
            : 500;
    if (status === 500) deps.logger.error({ err }, 'wopi request failed');
    return new Response(null, { status });
  }
  deps.logger.error({ err }, 'wopi request failed');
  return new Response(null, { status: 500 });
}

export function registerWopi(app: Hono<AppEnv>, deps: Deps) {
  const run =
    (op: (w: WopiCtx) => Promise<Response>) =>
    async (c: Context<AppEnv>): Promise<Response> => {
      try {
        const id = c.req.param('fileId') ?? '';
        if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response(null, { status: 404 });
        return await op(await authenticate(deps, c, id));
      } catch (err) {
        return errorResponse(deps, err);
      }
    };
  app.get(`${WOPI_PREFIX}/:fileId`, run(checkFileInfo));
  app.get(`${WOPI_PREFIX}/:fileId/contents`, run(getFile));
  app.post(
    `${WOPI_PREFIX}/:fileId/contents`,
    run((w) => {
      const override = (w.c.req.header('x-wopi-override') ?? 'PUT').toUpperCase();
      if (override !== 'PUT') throw new WopiStatus(501);
      return putFile(w);
    }),
  );
  app.post(
    `${WOPI_PREFIX}/:fileId`,
    run((w) => lockOps(w, (w.c.req.header('x-wopi-override') ?? '').toUpperCase())),
  );
}
