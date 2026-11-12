import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { jwtVerify, SignJWT } from 'jose';
import {
  blobs,
  newId,
  nodeVersions,
  officeDocKeys,
  orgMembers,
  organizations,
  users,
} from '@crewhall/db';
import { can, type OfficeExtension, type OfficeMode } from '@crewhall/shared';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { AppEnv } from '../../http/types';
import { publishNodeChanges } from '../../realtime/events';
import { putStream, TooLargeError } from '../../storage/stream';
import { loadNode, nodeResource, type DriveActor, type NodeRow } from '../drive/access';
import { commitFile, requireStorage } from '../drive/files';
import { assertQuota, orgLimits } from '../drive/quota';
import { nodesByIds } from '../drive/tree';
import { needsTwoFactorEnrolment, toActor } from '../membership';
import { requireOffice, type OfficeRow } from './settings';
import { issueWopiToken, readWopiToken, type WopiGrant } from './token';

/**
 * Document Server API (Euro-Office, ONLYOFFICE Docs): the browser loads the server's api.js and
 * starts the editor with a config Crewhall signs with the shared JWT secret. The server
 * downloads the file from `/api/office/files/:id/content` and reports back on
 * `/api/office/callback/:id`; a "ready to save" (status 2) or force-save (6) becomes a new Drive
 * version. Both URLs carry a short-lived Crewhall token (file + person + purpose); the callback
 * must also carry the server's own JWT. Rights are checked again on every call.
 */

export const OO_FILE_PATH = '/api/office/files';
export const OO_CALLBACK_PATH = '/api/office/callback';

const DOCUMENT_TYPE: Record<OfficeExtension, 'word' | 'cell' | 'slide'> = {
  docx: 'word',
  odt: 'word',
  xlsx: 'cell',
  ods: 'cell',
  pptx: 'slide',
  odp: 'slide',
};

const secretKey = (secret: string) => new TextEncoder().encode(secret);

/** Signs a config or payload as the server expects it (HS256 with the shared secret). */
export function signOfficeJwt(secret: string, payload: Record<string, unknown>) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(secretKey(secret));
}

/**
 * Where the document server reaches Crewhall's office endpoints. Defaults to API_URL; inside
 * Docker the server may need another address (e.g. http://backend:3000): OFFICE_HOST_URL. Read
 * by the module itself so the core env schema stays untouched.
 */
export function officeHostUrl(deps: Pick<Deps, 'env'>) {
  const raw = process.env.OFFICE_HOST_URL?.trim();
  return (raw || deps.env.API_URL).replace(/\/+$/, '');
}

/** The key all editors of a file share until the server reports the editing finished. */
async function documentKey(deps: Deps, node: NodeRow) {
  const [row] = await deps.db.select().from(officeDocKeys).where(eq(officeDocKeys.nodeId, node.id));
  if (row && row.baseVersionId === node.currentVersionId) return row.docKey;
  const docKey = `${node.id.replaceAll('-', '')}-${randomBytes(9).toString('base64url')}`;
  await deps.db
    .insert(officeDocKeys)
    .values({ nodeId: node.id, orgId: node.orgId, docKey, baseVersionId: node.currentVersionId })
    .onConflictDoUpdate({
      target: officeDocKeys.nodeId,
      set: { docKey, baseVersionId: node.currentVersionId, updatedAt: new Date() },
    });
  return docKey;
}

export async function onlyofficeSession(
  deps: Deps,
  a: DriveActor,
  input: {
    node: NodeRow;
    ext: OfficeExtension;
    mode: OfficeMode;
    lang: 'tr' | 'en';
    row: OfficeRow;
    jwtSecret: string;
  },
) {
  const { node, ext, mode, lang, row, jwtSecret } = input;
  const [user] = await deps.db.select().from(users).where(eq(users.id, a.userId));
  const host = officeHostUrl(deps);
  const grant = { n: node.id, u: a.userId, o: a.org.id };
  const file = issueWopiToken(deps.env.AUTH_SECRET, { ...grant, w: false, p: 'file' });
  const save = issueWopiToken(deps.env.AUTH_SECRET, { ...grant, w: true, p: 'save' });
  const edit = mode === 'edit';
  // Display fields (type, width, height) stay out of the signed config: the server would take
  // them from the token, and the client picks desktop or mobile.
  const config: Record<string, unknown> = {
    documentType: DOCUMENT_TYPE[ext],
    document: {
      fileType: ext,
      key: await documentKey(deps, node),
      title: node.name,
      url: `${host}${OO_FILE_PATH}/${node.id}/content?token=${encodeURIComponent(file.token)}`,
      permissions: {
        edit,
        comment: edit,
        review: edit,
        download: true,
        print: true,
        copy: true,
      },
    },
    editorConfig: {
      mode,
      lang,
      region: lang === 'en' ? 'en-US' : 'tr-TR',
      ...(edit
        ? {
            callbackUrl: `${host}${OO_CALLBACK_PATH}/${node.id}?token=${encodeURIComponent(save.token)}`,
          }
        : {}),
      user: { id: a.userId, name: user?.name ?? '', ...(user?.image ? { image: user.image } : {}) },
      customization: {
        // Ctrl S saves a Drive version at once; otherwise the server saves when everyone leaves.
        forcesave: true,
        autosave: true,
        compactHeader: true,
        toolbarHideFileName: true,
        feedback: false,
        help: false,
      },
    },
  };
  config.token = await signOfficeJwt(jwtSecret, config);
  const serverUrl = row.serverUrl!;
  return {
    apiUrl: `${serverUrl}/web-apps/apps/api/documents/api.js`,
    config,
    editorOrigin: new URL(serverUrl).origin,
  };
}

/* ------------------------------- server calls ------------------------------- */

class OfficeStatus extends Error {
  constructor(readonly status: number) {
    super(`office ${status}`);
  }
}

/** The person behind a token (or a callback's editor), with their current rights on the file. */
async function actorFor(deps: Deps, orgId: string, userId: string, nodeId: string) {
  const [row] = await deps.db
    .select({ member: orgMembers, org: organizations, user: users })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.organizationId))
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(
      and(
        eq(orgMembers.organizationId, orgId),
        eq(orgMembers.userId, userId),
        eq(orgMembers.status, 'active'),
      ),
    );
  if (!row) return null;
  if (await needsTwoFactorEnrolment(deps.db, row.org, row.member, row.user)) return null;
  const a: DriveActor = { org: row.org, actor: toActor(row.member), userId };
  try {
    const access = await loadNode(deps.db, a, nodeId);
    if (access.node.type !== 'file') return null;
    const canWrite =
      !access.space.archivedAt && can(a.actor, 'space.edit_content', nodeResource(a, access.role));
    return { a, node: access.node, space: access.space, canWrite };
  } catch {
    return null;
  }
}

type Who = NonNullable<Awaited<ReturnType<typeof actorFor>>>;
type ServerCtx = Who & { grant: WopiGrant; row: OfficeRow; jwtSecret: string };

async function authenticate(
  deps: Deps,
  c: Context<AppEnv>,
  purpose: 'file' | 'save',
): Promise<ServerCtx> {
  const nodeId = c.req.param('nodeId') ?? '';
  const grant = readWopiToken(deps.env.AUTH_SECRET, c.req.query('token') ?? '');
  if (!grant || grant.n !== nodeId || grant.p !== purpose) throw new OfficeStatus(401);
  const who = await actorFor(deps, grant.o, grant.u, nodeId);
  if (!who) throw new OfficeStatus(404);
  let cfg;
  try {
    cfg = await requireOffice(deps, who.a.org);
  } catch {
    throw new OfficeStatus(401);
  }
  if (cfg.kind !== 'onlyoffice') throw new OfficeStatus(401);
  return { grant, ...who, row: cfg.row, jwtSecret: cfg.jwtSecret };
}

async function fileContent(deps: Deps, c: Context<AppEnv>) {
  const s = await authenticate(deps, c, 'file');
  if (!s.node.currentVersionId) return new Response(new Uint8Array(0));
  const [row] = await deps.db
    .select({ blob: blobs })
    .from(nodeVersions)
    .innerJoin(blobs, eq(blobs.id, nodeVersions.blobId))
    .where(eq(nodeVersions.id, s.node.currentVersionId));
  if (!row) throw new OfficeStatus(404);
  if (row.blob.status === 'quarantined') throw new OfficeStatus(403);
  const stream = await requireStorage(deps).getStream(row.blob.storageKey);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(row.blob.size),
    },
  });
}

const Callback = z.object({
  key: z.string(),
  status: z.number().int(),
  url: z.string().optional(),
  users: z.array(z.string()).optional(),
  filetype: z.string().optional(),
});

/** The callback body as the server signed it (JWT in the body, or in the Authorization header). */
async function verifiedCallback(c: Context<AppEnv>, jwtSecret: string) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new OfficeStatus(400);
  }
  const inBody = (body as { token?: unknown }).token;
  const header = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  const token = typeof inBody === 'string' ? inBody : header;
  if (!token) throw new OfficeStatus(401);
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, secretKey(jwtSecret), { algorithms: ['HS256'] }));
  } catch {
    throw new OfficeStatus(401);
  }
  // Header tokens wrap the body in `payload`; body tokens are the body itself.
  const signed = typeof inBody === 'string' ? payload : payload.payload;
  const parsed = Callback.safeParse(signed);
  if (!parsed.success) throw new OfficeStatus(400);
  return parsed.data;
}

/** The saved file's address, reached through the internal address when there is one. */
function downloadUrl(row: OfficeRow, url: string) {
  const u = new URL(url);
  if (row.internalUrl && row.serverUrl && u.origin === new URL(row.serverUrl).origin) {
    const inner = new URL(row.internalUrl);
    u.protocol = inner.protocol;
    u.host = inner.host;
  }
  if (row.serverUrl) {
    // Only ever download from the configured document server.
    const allowed = [row.serverUrl, row.internalUrl]
      .filter((x): x is string => !!x)
      .map((x) => new URL(x).origin);
    if (!allowed.includes(u.origin)) throw new OfficeStatus(400);
  }
  return u.toString();
}

async function saveVersion(deps: Deps, s: ServerCtx, cb: z.infer<typeof Callback>) {
  // The last editor saves, if they still may; otherwise the person who opened it.
  let saver = cb.users?.[0] ? await actorFor(deps, s.a.org.id, cb.users[0], s.node.id) : null;
  if (!saver?.canWrite) saver = s.canWrite ? s : null;
  if (!saver || !cb.url) throw new OfficeStatus(403);
  const res = await fetch(downloadUrl(s.row, cb.url), { signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new Error(`download of the saved file answered ${res.status}`);

  const storage = requireStorage(deps);
  const { maxFileBytes } = orgLimits(saver.a.org);
  const storageKey = `orgs/${saver.a.org.id}/blobs/${newId()}`;
  let size: number;
  try {
    size = await putStream(
      storage,
      storageKey,
      res.body as unknown as AsyncIterable<Uint8Array>,
      s.node.mime ?? 'application/octet-stream',
      maxFileBytes,
    );
    await assertQuota(deps.db, saver.a.org, s.space, size);
  } catch (err) {
    await storage.delete(storageKey).catch(() => undefined);
    if (err instanceof TooLargeError) throw new AppError('file_too_large');
    throw err;
  }
  const committed = await deps.db
    .transaction((tx) =>
      commitFile(tx, saver.a, {
        spaceId: s.node.spaceId,
        parentId: s.node.parentId,
        nodeId: s.node.id,
        name: s.node.name,
        storageKey,
        sizeBytes: size,
        mime: s.node.mime,
        source: 'web',
        replace: false,
      }),
    )
    .catch(async (err: unknown) => {
      await storage.delete(storageKey).catch(() => undefined);
      throw err;
    });
  await deps.jobs.send('blob.process', { blobId: committed.blobId });
  const [row] = await nodesByIds(deps.db, saver.a.org.id, [s.node.id]);
  if (row) await publishNodeChanges(deps, [row], 'updated');
  return committed.version.id;
}

async function callback(deps: Deps, c: Context<AppEnv>) {
  const s = await authenticate(deps, c, 'save');
  const cb = await verifiedCallback(c, s.jwtSecret);
  const sameKey = and(eq(officeDocKeys.nodeId, s.node.id), eq(officeDocKeys.docKey, cb.key));
  switch (cb.status) {
    case 2: // everyone left with changes: save, the next opening starts a new session
    case 6: {
      // force-save (Ctrl S): save, the session goes on with the same key
      const versionId = await saveVersion(deps, s, cb);
      if (cb.status === 2) await deps.db.delete(officeDocKeys).where(sameKey);
      else {
        await deps.db
          .update(officeDocKeys)
          .set({ baseVersionId: versionId, updatedAt: new Date() })
          .where(sameKey);
      }
      break;
    }
    case 4: // closed without changes
      await deps.db.delete(officeDocKeys).where(sameKey);
      break;
    case 3:
    case 7:
      deps.logger.warn({ nodeId: s.node.id, status: cb.status }, 'document server could not save');
      break;
    default: // 1: editing; nothing to do
      break;
  }
  return Response.json({ error: 0 });
}

export function registerOnlyoffice(app: Hono<AppEnv>, deps: Deps) {
  app.get(`${OO_FILE_PATH}/:nodeId/content`, async (c) => {
    try {
      return await fileContent(deps, c);
    } catch (err) {
      if (err instanceof OfficeStatus) return new Response(null, { status: err.status });
      deps.logger.error({ err }, 'office file download failed');
      return new Response(null, { status: 500 });
    }
  });
  app.post(`${OO_CALLBACK_PATH}/:nodeId`, async (c) => {
    try {
      return await callback(deps, c);
    } catch (err) {
      // The server shows "could not save" for anything but error 0 and retries later.
      if (!(err instanceof OfficeStatus)) deps.logger.error({ err }, 'office callback failed');
      const status = err instanceof OfficeStatus ? err.status : 200;
      return Response.json(
        { error: 1 },
        { status: status === 401 || status === 403 ? status : 200 },
      );
    }
  });
}
