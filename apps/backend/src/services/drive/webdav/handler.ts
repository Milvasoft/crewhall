import { Readable } from 'node:stream';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { blobs, davLocks, newId, nodeVersions } from '@crewhall/db';
import { NodeName, type ErrorCode } from '@crewhall/shared';
import type { Context, Hono } from 'hono';
import type { Deps } from '../../../deps';
import { AppError, localizedMessage } from '../../../http/errors';
import type { AppEnv } from '../../../http/types';
import { requestInfo } from '../../../http/route';
import { publishNodeChanges, type NodeChange } from '../../../realtime/events';
import { putStream, TooLargeError } from '../../../storage/stream';
import { auditVia } from '../../audit';
import { requireNodeAction, type NodeRow } from '../access';
import { commitFile, currentVersionNumber, requireStorage, versionFromFile } from '../files';
import * as tree from '../nodes';
import { assertQuota, orgLimits } from '../quota';
import { findByName, nodesByIds } from '../tree';
import { authenticateDav, type DavSession } from './auth';
import {
  activeLockXml,
  dropExpiredLocks,
  lockById,
  lockTimeout,
  lockToken,
  locksCovering,
  locksSatisfied,
  submittedTokens,
  SUPPORTED_LOCK,
  type LockRow,
} from './locks';
import {
  DAV_PREFIX,
  davChildren,
  davHref,
  davSegments,
  davSpaces,
  resolveDav,
  type DavSpace,
} from './paths';
import {
  child,
  DAV_NS,
  davError,
  davResponse,
  escapeXml,
  multistatus,
  parseXml,
  propName,
  serialize,
  XML_HEAD,
  XmlError,
  type PropStat,
  type XmlElement,
} from './xml';

/**
 * WebDAV (RFC 4918, roadmap 9): Drive mounted in Finder, Windows Explorer and rclone.
 * `/dav/` lists the spaces as folders; below them folders and files. Every operation goes
 * through the Drive services, so `can()`, quotas, versions, trash and audit apply as in the
 * web app. PUT on an existing file adds a version, DELETE moves to the trash.
 */

const READ_METHODS = new Set(['OPTIONS', 'PROPFIND', 'GET', 'HEAD']);
const METHODS = [
  'OPTIONS',
  'PROPFIND',
  'PROPPATCH',
  'GET',
  'HEAD',
  'PUT',
  'MKCOL',
  'DELETE',
  'MOVE',
  'COPY',
  'LOCK',
  'UNLOCK',
];
const ALLOW = METHODS.join(', ');

/** Desktop metadata files: accepted and dropped so Drive does not fill with them. */
const JUNK = /^(\._.*|\.DS_Store|Thumbs\.db|desktop\.ini|\.localized)$/i;

const EXT_MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
};

export function mimeFor(name: string, declared: string | undefined): string | null {
  const clean = declared?.split(';')[0]?.trim().toLowerCase();
  if (clean && clean !== 'application/octet-stream') return clean;
  const ext = name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : '';
  return EXT_MIME[ext] ?? clean ?? null;
}

class DavStatus extends Error {
  constructor(
    readonly status: number,
    readonly body: string | null = null,
    readonly headers: Record<string, string> = {},
  ) {
    super(`dav ${status}`);
  }
}

const fail = (status: number, body: string | null = null): never => {
  throw new DavStatus(status, body);
};

/** AppError → the status WebDAV clients understand (507 when the space is full). */
const DAV_STATUS: Partial<Record<ErrorCode, number>> = {
  quota_exceeded: 507,
  file_too_large: 413,
  node_name_taken: 409,
  invalid_target: 409,
  validation_failed: 400,
  token_scope: 403,
  // If-Match lost the race to another save.
  version_conflict: 412,
};

interface Ctx {
  c: Context<AppEnv>;
  deps: Deps;
  s: DavSession;
  segments: string[];
  spaces: DavSpace[];
}

function xmlResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', ...headers },
  });
}

async function readText(c: Context<AppEnv>): Promise<string> {
  const text = await c.req.text();
  return text.trim();
}

async function readXml(c: Context<AppEnv>): Promise<XmlElement | null> {
  const text = await readText(c);
  if (!text) return null;
  try {
    return parseXml(text);
  } catch (err) {
    if (err instanceof XmlError) return fail(400);
    throw err;
  }
}

function validName(name: string) {
  const parsed = NodeName.safeParse(name);
  if (!parsed.success || parsed.data !== name) fail(400);
}

async function emit(
  ctx: Ctx,
  rows: Pick<NodeRow, 'id' | 'spaceId' | 'parentId'>[],
  change: NodeChange,
) {
  await publishNodeChanges(ctx.deps, rows, change);
}

/* -------------------------------- locks -------------------------------- */

async function assertUnlocked(ctx: Ctx, path: string, subtree = false) {
  const locks = await locksCovering(ctx.deps.db, path, subtree);
  if (!locksSatisfied(locks, ctx.s.a.userId, submittedTokens(ctx.c.req.header('if')))) {
    fail(423, davError('lock-token-submitted'));
  }
}

/** Writes into a container: a lock on the folder (or above it, depth infinity) needs its token. */
async function assertContainerUnlocked(ctx: Ctx, parent: NodeRow | null) {
  if (parent) await assertUnlocked(ctx, parent.path);
}

/* ------------------------------- PROPFIND ------------------------------- */

interface Entry {
  href: string;
  collection: boolean;
  name: string;
  size: number;
  mime: string | null;
  etag: string;
  created: Date;
  modified: Date;
  nodeId: string | null;
  quota: { used: number; available: number } | null;
}

type PropMode =
  { kind: 'all' } | { kind: 'names' } | { kind: 'props'; list: { ns: string; name: string }[] };

function propMode(body: XmlElement | null): PropMode {
  if (!body) return { kind: 'all' };
  if (body.ns !== DAV_NS || body.name !== 'propfind') return fail(400);
  if (child(body, 'propname')) return { kind: 'names' };
  const prop = child(body, 'prop');
  if (prop) return { kind: 'props', list: prop.children.map((p) => ({ ns: p.ns, name: p.name })) };
  return { kind: 'all' };
}

const ALL_PROPS = [
  'creationdate',
  'displayname',
  'getcontentlength',
  'getcontenttype',
  'getetag',
  'getlastmodified',
  'lockdiscovery',
  'resourcetype',
  'supportedlock',
];

function liveProps(e: Entry, locks: LockRow[]): Map<string, string> {
  const m = new Map<string, string>();
  m.set('creationdate', `<D:creationdate>${e.created.toISOString()}</D:creationdate>`);
  m.set('displayname', `<D:displayname>${escapeXml(e.name)}</D:displayname>`);
  if (!e.collection) {
    m.set('getcontentlength', `<D:getcontentlength>${e.size}</D:getcontentlength>`);
    m.set(
      'getcontenttype',
      `<D:getcontenttype>${escapeXml(e.mime ?? 'application/octet-stream')}</D:getcontenttype>`,
    );
  }
  m.set('getetag', `<D:getetag>${escapeXml(e.etag)}</D:getetag>`);
  m.set('getlastmodified', `<D:getlastmodified>${e.modified.toUTCString()}</D:getlastmodified>`);
  m.set(
    'lockdiscovery',
    `<D:lockdiscovery>${locks.map((l) => activeLockXml(l, e.href)).join('')}</D:lockdiscovery>`,
  );
  m.set(
    'resourcetype',
    e.collection ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>',
  );
  m.set('supportedlock', SUPPORTED_LOCK);
  if (e.quota) {
    m.set(
      'quota-available-bytes',
      `<D:quota-available-bytes>${e.quota.available}</D:quota-available-bytes>`,
    );
    m.set('quota-used-bytes', `<D:quota-used-bytes>${e.quota.used}</D:quota-used-bytes>`);
  }
  return m;
}

function entryXml(e: Entry, mode: PropMode, locks: LockRow[]): string {
  const live = liveProps(e, locks);
  if (mode.kind === 'all') {
    return davResponse(e.href, [
      { status: 200, props: ALL_PROPS.map((n) => live.get(n)).filter((x): x is string => !!x) },
    ]);
  }
  if (mode.kind === 'names') {
    return davResponse(e.href, [
      { status: 200, props: [...live.keys()].map((n) => propName(DAV_NS, n)) },
    ]);
  }
  const found: string[] = [];
  const missing: string[] = [];
  for (const p of mode.list) {
    const v = p.ns === DAV_NS ? live.get(p.name) : undefined;
    if (v) found.push(v);
    else missing.push(propName(p.ns, p.name));
  }
  const stats: PropStat[] = [
    { status: 200, props: found },
    { status: 404, props: missing },
  ];
  return davResponse(e.href, stats);
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function spaceQuota(ctx: Ctx, space: DavSpace['space']) {
  const { quotaBytes } = orgLimits(ctx.s.a.org);
  const limit = space.quotaBytes ?? quotaBytes;
  return {
    used: space.usedBytes,
    available: limit === null ? MAX_SAFE : Math.max(0, limit - space.usedBytes),
  };
}

function nodeEntry(href: string, node: NodeRow, quota: Entry['quota']): Entry {
  const collection = node.type === 'folder';
  return {
    href,
    collection,
    name: node.name,
    size: node.sizeBytes,
    mime: node.mime,
    etag: collection
      ? `"${node.id}-${node.updatedAt.getTime()}"`
      : `"${node.currentVersionId ?? node.id}"`,
    created: node.createdAt,
    modified: node.updatedAt,
    nodeId: node.id,
    quota: collection ? quota : null,
  };
}

async function propfind(ctx: Ctx) {
  const mode = propMode(await readXml(ctx.c));
  const depth = (ctx.c.req.header('depth') ?? 'infinity').toLowerCase();
  const target = await resolveDav(ctx.deps.db, ctx.s, ctx.segments, ctx.spaces);
  if (target.kind === 'missing' || target.kind === 'orphan') return fail(404);
  const collection = target.kind !== 'node' || target.node.type === 'folder';
  if (collection && depth !== '0' && depth !== '1') fail(403, davError('propfind-finite-depth'));
  const withChildren = collection && depth === '1';

  const entries: Entry[] = [];
  const self = davHref(ctx.segments, collection);
  if (target.kind === 'root') {
    const used = ctx.spaces.reduce((n, x) => n + x.space.usedBytes, 0);
    const { quotaBytes } = orgLimits(ctx.s.a.org);
    entries.push({
      href: self,
      collection: true,
      name: ctx.s.a.org.name,
      size: 0,
      mime: null,
      etag: `"root-${ctx.spaces.length}"`,
      created: ctx.s.a.org.createdAt,
      modified: new Date(Math.max(0, ...ctx.spaces.map((x) => x.space.updatedAt.getTime()))),
      nodeId: null,
      quota: { used, available: quotaBytes === null ? MAX_SAFE : Math.max(0, quotaBytes - used) },
    });
    if (withChildren) {
      for (const x of ctx.spaces) {
        entries.push({
          href: davHref([x.label], true),
          collection: true,
          name: x.label,
          size: 0,
          mime: null,
          etag: `"${x.space.id}-${x.space.updatedAt.getTime()}"`,
          created: x.space.createdAt,
          modified: x.space.updatedAt,
          nodeId: null,
          quota: spaceQuota(ctx, x.space),
        });
      }
    }
  } else {
    const space = target.space;
    const quota = spaceQuota(ctx, space.space);
    if (target.kind === 'space') {
      entries.push({
        href: self,
        collection: true,
        name: space.label,
        size: 0,
        mime: null,
        etag: `"${space.space.id}-${space.space.updatedAt.getTime()}"`,
        created: space.space.createdAt,
        modified: space.space.updatedAt,
        nodeId: null,
        quota,
      });
    } else {
      entries.push(nodeEntry(self, target.node, quota));
    }
    if (withChildren) {
      const parentId = target.kind === 'node' ? target.node.id : null;
      for (const row of await davChildren(ctx.deps.db, ctx.s, space, parentId)) {
        entries.push(
          nodeEntry(davHref([...ctx.segments, row.name], row.type === 'folder'), row, quota),
        );
      }
    }
  }

  const nodeIds = entries.map((e) => e.nodeId).filter((x): x is string => !!x);
  const direct = nodeIds.length
    ? await ctx.deps.db
        .select()
        .from(davLocks)
        .where(and(inArray(davLocks.nodeId, nodeIds), sql`${davLocks.expiresAt} > now()`))
    : [];
  const inherited =
    target.kind === 'node' ? await locksCovering(ctx.deps.db, target.node.path) : [];
  const body = entries.map((e, i) => {
    const own = direct.filter((l) => l.nodeId === e.nodeId);
    const locks =
      i === 0 ? [...new Map([...own, ...inherited].map((l) => [l.id, l])).values()] : own;
    return entryXml(e, mode, locks);
  });
  return xmlResponse(207, multistatus(body));
}

/* ------------------------------- PROPPATCH ------------------------------- */

/**
 * Dead properties are not stored (kararlar.md, roadmap 9): Windows sets its Win32 times and
 * Finder its extended attributes with PROPPATCH and gives up the copy when it fails, so
 * every property answers 200.
 */
async function proppatch(ctx: Ctx) {
  const body = await readXml(ctx.c);
  if (!body || body.ns !== DAV_NS || body.name !== 'propertyupdate') return fail(400);
  const target = await resolveDav(ctx.deps.db, ctx.s, ctx.segments, ctx.spaces);
  if (target.kind !== 'node')
    return fail(target.kind === 'missing' || target.kind === 'orphan' ? 404 : 403);
  requireNodeAction(ctx.s.a, target.role, 'space.edit_content');
  await assertUnlocked(ctx, target.node.path);
  const names = body.children
    .filter((x) => x.ns === DAV_NS && (x.name === 'set' || x.name === 'remove'))
    .flatMap((x) => child(x, 'prop')?.children ?? [])
    .map((p) => propName(p.ns, p.name));
  const href = davHref(ctx.segments, target.node.type === 'folder');
  return xmlResponse(207, multistatus([davResponse(href, [{ status: 200, props: names }])]));
}

/* --------------------------------- GET --------------------------------- */

async function get(ctx: Ctx, head: boolean) {
  const target = await resolveDav(ctx.deps.db, ctx.s, ctx.segments, ctx.spaces);
  if (target.kind === 'missing' || target.kind === 'orphan') return fail(404);
  if (target.kind !== 'node' || target.node.type === 'folder') {
    return new Response(null, { status: 405, headers: { Allow: ALLOW } });
  }
  const node = target.node;
  const storage = requireStorage(ctx.deps);
  const empty = {
    'Content-Type': node.mime ?? 'application/octet-stream',
    ETag: `"${node.currentVersionId ?? node.id}"`,
    'Last-Modified': node.updatedAt.toUTCString(),
    'Accept-Ranges': 'bytes',
  };
  if (!node.currentVersionId) {
    return new Response(head ? null : '', {
      status: 200,
      headers: { ...empty, 'Content-Length': '0' },
    });
  }
  const [row] = await ctx.deps.db
    .select({ version: nodeVersions, blob: blobs })
    .from(nodeVersions)
    .innerJoin(blobs, eq(blobs.id, nodeVersions.blobId))
    .where(eq(nodeVersions.id, node.currentVersionId));
  if (!row) return fail(404);
  if (row.blob.status === 'quarantined') return fail(403);
  const size = row.version.sizeBytes;
  const headers: Record<string, string> = {
    ...empty,
    'Content-Type': row.version.mime ?? row.blob.mime ?? 'application/octet-stream',
  };

  if (ctx.c.req.header('if-none-match') === headers.ETag) {
    return new Response(null, { status: 304, headers });
  }
  let range: { start: number; end: number } | null = null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(ctx.c.req.header('range') ?? '');
  if (m && size > 0 && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    range = { start, end };
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
  } else {
    headers['Content-Length'] = String(size);
  }
  if (head || size === 0) {
    return new Response(head ? null : '', { status: range ? 206 : 200, headers });
  }
  const stream = await storage.getStream(
    row.blob.storageKey,
    range ? `bytes=${range.start}-${range.end}` : undefined,
  );
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: range ? 206 : 200,
    headers,
  });
}

/* --------------------------------- PUT --------------------------------- */

/** Stores the request body; returns the stored size. Deletes the object on failure. */
async function storeBody(ctx: Ctx, key: string, mime: string, max: number) {
  const storage = requireStorage(ctx.deps);
  const body = ctx.c.req.raw.body as AsyncIterable<Uint8Array> | null;
  try {
    return await putStream(storage, key, body, mime, max);
  } catch (err) {
    await storage.delete(key).catch(() => undefined);
    if (err instanceof TooLargeError) throw new AppError('file_too_large', { maxFileBytes: max });
    throw err;
  }
}

async function put(ctx: Ctx) {
  const db = ctx.deps.db;
  const a = ctx.s.a;
  const target = await resolveDav(db, ctx.s, ctx.segments, ctx.spaces);
  if (target.kind === 'orphan') return fail(409);
  if (target.kind === 'root' || target.kind === 'space') return fail(405);
  if (target.kind === 'node' && target.node.type !== 'file') return fail(405);
  if (target.kind === 'node' && ctx.c.req.header('if-none-match') === '*') return fail(412);
  // If-Match (RFC 9110 §13.1.1): write only over the version the client last saw. The check
  // is repeated under the row lock (baseVersion), so a save in between fails the same way.
  const ifMatch = ctx.c.req.header('if-match')?.trim();
  let baseVersion: number | null = null;
  if (ifMatch && ifMatch !== '*') {
    if (target.kind !== 'node') return fail(412);
    const etag = `"${target.node.currentVersionId ?? target.node.id}"`;
    const tags = ifMatch.split(',').map((x) => x.trim().replace(/^W\//, ''));
    if (!tags.includes(etag)) return fail(412);
    baseVersion = await currentVersionNumber(db, target.node);
  }

  const name = target.kind === 'node' ? target.node.name : target.name;
  if (target.kind === 'missing') {
    validName(name);
    if (JUNK.test(name)) {
      await ctx.c.req.arrayBuffer().catch(() => undefined);
      return new Response(null, { status: 201 });
    }
    const dest = await tree.container(db, a, target.space.space.id, target.parent?.id ?? null);
    requireNodeAction(a, dest.role, 'space.edit_content');
    await assertContainerUnlocked(ctx, target.parent);
  } else {
    requireNodeAction(a, target.role, 'space.edit_content');
    await assertUnlocked(ctx, target.node.path);
  }
  const space = target.space.space;
  if (space.archivedAt) throw new AppError('forbidden', { reason: 'archived' });

  const { maxFileBytes } = orgLimits(a.org);
  const declared = ctx.c.req.header('content-length');
  const length = declared !== undefined && /^\d+$/.test(declared) ? Number(declared) : null;
  if (length !== null && length > maxFileBytes) {
    throw new AppError('file_too_large', { maxFileBytes });
  }
  if (length !== null) await assertQuota(db, a.org, space, length);

  const mime = mimeFor(name, ctx.c.req.header('content-type'));
  const storageKey = `orgs/${a.org.id}/blobs/${newId()}`;
  const size = await storeBody(ctx, storageKey, mime ?? 'application/octet-stream', maxFileBytes);
  const storage = requireStorage(ctx.deps);
  if (length === null) {
    await assertQuota(db, a.org, space, size).catch(async (err: unknown) => {
      await storage.delete(storageKey).catch(() => undefined);
      throw err;
    });
  }

  // Windows creates a file with an empty PUT, then writes it: the empty first version goes.
  let replace = false;
  if (target.kind === 'node') {
    const versions = await db
      .select({ size: nodeVersions.sizeBytes })
      .from(nodeVersions)
      .where(eq(nodeVersions.nodeId, target.node.id));
    replace = versions.length === 1 && versions[0]!.size === 0;
  }
  const committed = await db
    .transaction((tx) =>
      commitFile(tx, a, {
        spaceId: space.id,
        parentId: target.kind === 'node' ? target.node.parentId : (target.parent?.id ?? null),
        nodeId: target.kind === 'node' ? target.node.id : null,
        name,
        storageKey,
        sizeBytes: size,
        mime,
        source: 'api',
        replace,
        baseVersion,
      }),
    )
    .catch(async (err: unknown) => {
      await storage.delete(storageKey).catch(() => undefined);
      throw err;
    });
  await ctx.deps.jobs.send('blob.process', { blobId: committed.blobId });
  const [row] = await nodesByIds(db, a.org.id, [committed.nodeId]);
  if (row) await emit(ctx, [row], target.kind === 'node' ? 'updated' : 'created');
  return new Response(null, {
    status: target.kind === 'node' ? 204 : 201,
    headers: { ETag: `"${committed.version.id}"` },
  });
}

/* -------------------------------- MKCOL -------------------------------- */

async function mkcol(ctx: Ctx) {
  if (await readText(ctx.c)) return fail(415);
  const target = await resolveDav(ctx.deps.db, ctx.s, ctx.segments, ctx.spaces);
  if (target.kind === 'orphan') return fail(409);
  if (target.kind !== 'missing') return fail(405);
  validName(target.name);
  await assertContainerUnlocked(ctx, target.parent);
  const node = await tree.createFolder(ctx.deps.db, ctx.s.a, target.space.space.id, {
    parentId: target.parent?.id ?? null,
    name: target.name,
  });
  await emit(ctx, [node], 'created');
  return new Response(null, { status: 201 });
}

/* -------------------------------- DELETE -------------------------------- */

async function del(ctx: Ctx) {
  const target = await resolveDav(ctx.deps.db, ctx.s, ctx.segments, ctx.spaces);
  if (target.kind === 'missing' || target.kind === 'orphan') return fail(404);
  if (target.kind !== 'node') return fail(403);
  await assertUnlocked(ctx, target.node.path, true);
  const trashed = await ctx.deps.db.transaction((tx) =>
    tree.trashNodes(tx, ctx.s.a, [target.node.id]),
  );
  await ctx.deps.db.delete(davLocks).where(eq(davLocks.nodeId, target.node.id));
  await emit(ctx, trashed, 'trashed');
  return new Response(null, { status: 204 });
}

/* ------------------------------ MOVE, COPY ------------------------------ */

function destination(ctx: Ctx): string[] {
  const header = ctx.c.req.header('destination');
  if (!header) return fail(400);
  let url: URL;
  try {
    url = new URL(header, ctx.c.req.url);
  } catch {
    return fail(400);
  }
  const segments = davSegments(url.pathname);
  return segments ?? fail(502);
}

async function moveOrCopy(ctx: Ctx, copy: boolean) {
  const db = ctx.deps.db;
  const a = ctx.s.a;
  const destSegments = destination(ctx);
  const src = await resolveDav(db, ctx.s, ctx.segments, ctx.spaces);
  if (src.kind === 'missing' || src.kind === 'orphan') return fail(404);
  if (src.kind !== 'node') return fail(403);
  const dst = await resolveDav(db, ctx.s, destSegments, ctx.spaces);
  if (dst.kind === 'orphan') return fail(409);
  if (dst.kind === 'root' || dst.kind === 'space') return fail(403);
  if (dst.kind === 'node' && dst.node.id === src.node.id) return fail(403);
  const overwrite = (ctx.c.req.header('overwrite') ?? 'T').toUpperCase() !== 'F';
  if (dst.kind === 'node' && !overwrite) return fail(412);
  const name = dst.kind === 'node' ? dst.node.name : dst.name;
  validName(name);
  const parent = dst.kind === 'node' ? null : dst.parent;
  const destSpaceId = dst.space.space.id;
  const destParentId = dst.kind === 'node' ? dst.node.parentId : (dst.parent?.id ?? null);
  if (src.node.type === 'folder') {
    const destParentPath =
      dst.kind === 'node'
        ? dst.node.path.split('.').slice(0, -1).join('.')
        : (dst.parent?.path ?? '');
    if (destParentPath === src.node.path || destParentPath.startsWith(`${src.node.path}.`)) {
      return fail(409);
    }
  }

  if (!copy) await assertUnlocked(ctx, src.node.path, true);
  if (dst.kind === 'node') await assertUnlocked(ctx, dst.node.path, true);
  else await assertContainerUnlocked(ctx, parent);

  const req = requestInfo(ctx.c);
  const changed: { rows: Pick<NodeRow, 'id' | 'spaceId' | 'parentId'>[]; change: NodeChange }[] =
    [];
  const existed = dst.kind === 'node';
  await db.transaction(async (tx) => {
    if (dst.kind === 'node') {
      if (dst.node.type === 'file' && src.node.type === 'file') {
        // A file onto a file (Office's save-by-rename): the target gets a new version and
        // keeps its history and shares; a moved source goes to the trash.
        requireNodeAction(a, dst.role, 'space.edit_content');
        await versionFromFile(tx, a, dst.node, src.node, 'api');
        changed.push({ rows: [dst.node], change: 'updated' });
        if (!copy) {
          changed.push({ rows: await tree.trashNodes(tx, a, [src.node.id]), change: 'trashed' });
        }
        return;
      }
      changed.push({ rows: await tree.trashNodes(tx, a, [dst.node.id]), change: 'trashed' });
    }
    const target = { spaceId: destSpaceId, parentId: destParentId };
    if (copy) {
      const depth = ctx.c.req.header('depth') ?? 'infinity';
      if (src.node.type === 'folder' && depth === '0') {
        const folder = await tree.createFolder(tx, a, destSpaceId, {
          parentId: destParentId,
          name,
        });
        changed.push({ rows: [folder], change: 'created' });
        return;
      }
      const [made] = await tree.copyNodes(tx, a, [src.node.id], target);
      if (!made) throw new AppError('not_found');
      const final = made.name === name ? made : await tree.renameNode(tx, a, made.id, name);
      changed.push({ rows: [final], change: 'created' });
      return;
    }
    const sameParent = src.node.spaceId === destSpaceId && src.node.parentId === destParentId;
    if (sameParent) {
      changed.push({ rows: [await tree.renameNode(tx, a, src.node.id, name)], change: 'updated' });
      return;
    }
    let renamed = name === src.node.name;
    if (
      !renamed &&
      !(await findByName(tx, src.node.spaceId, src.node.parentId, name, src.node.id))
    ) {
      await tree.renameNode(tx, a, src.node.id, name);
      renamed = true;
    }
    const moved = await tree.moveNodes(tx, a, [src.node.id], target, req);
    if (!renamed) await tree.renameNode(tx, a, src.node.id, name);
    changed.push({ rows: moved, change: 'moved' });
  });
  for (const x of changed) await emit(ctx, x.rows, x.change);
  return new Response(null, { status: existed ? 204 : 201 });
}

/* ------------------------------ LOCK, UNLOCK ------------------------------ */

function lockBody(lock: LockRow, href: string) {
  return `${XML_HEAD}<D:prop xmlns:D="DAV:"><D:lockdiscovery>${activeLockXml(lock, href)}</D:lockdiscovery></D:prop>`;
}

async function lock(ctx: Ctx) {
  const db = ctx.deps.db;
  const a = ctx.s.a;
  await dropExpiredLocks(db);
  const body = await readXml(ctx.c);
  const timeout = lockTimeout(ctx.c.req.header('timeout'));
  const expiresAt = () => new Date(Date.now() + timeout * 1000);

  if (!body) {
    // Refresh (RFC 4918 §9.10.2): the token comes in the If header.
    const [id] = submittedTokens(ctx.c.req.header('if'));
    const found = id ? await lockById(db, id) : null;
    if (!found || found.userId !== a.userId)
      return fail(412, davError('lock-token-matches-request-uri'));
    const [fresh] = await db
      .update(davLocks)
      .set({ timeoutSeconds: timeout, expiresAt: expiresAt() })
      .where(eq(davLocks.id, found.id))
      .returning();
    return xmlResponse(200, lockBody(fresh!, davHref(ctx.segments, false)));
  }
  if (body.ns !== DAV_NS || body.name !== 'lockinfo') return fail(400);
  const scope = child(child(body, 'lockscope'), 'shared') ? 'shared' : 'exclusive';
  const ownerEl = child(body, 'owner');
  const owner = ownerEl
    ? ownerEl.children.length
      ? ownerEl.children.map(serialize).join('')
      : escapeXml(ownerEl.text.trim())
    : null;

  let target = await resolveDav(db, ctx.s, ctx.segments, ctx.spaces);
  if (target.kind === 'orphan') return fail(409);
  if (target.kind === 'root' || target.kind === 'space') return fail(403);
  let created = false;
  if (target.kind === 'missing') {
    // A lock on an unmapped URL makes an empty file (RFC 4918 §9.10.4); Office does this.
    validName(target.name);
    const dest = await tree.container(db, a, target.space.space.id, target.parent?.id ?? null);
    requireNodeAction(a, dest.role, 'space.edit_content');
    if (dest.space.archivedAt) throw new AppError('forbidden', { reason: 'archived' });
    await assertContainerUnlocked(ctx, target.parent);
    const storage = requireStorage(ctx.deps);
    const storageKey = `orgs/${a.org.id}/blobs/${newId()}`;
    const mime = mimeFor(target.name, undefined);
    await storage.put(storageKey, Buffer.alloc(0), mime ?? 'application/octet-stream');
    const space = target.space.space;
    const parentId = target.parent?.id ?? null;
    const name = target.name;
    const committed = await db.transaction((tx) =>
      commitFile(tx, a, {
        spaceId: space.id,
        parentId,
        nodeId: null,
        name,
        storageKey,
        sizeBytes: 0,
        mime,
        source: 'api',
        replace: false,
      }),
    );
    await ctx.deps.jobs.send('blob.process', { blobId: committed.blobId });
    created = true;
    target = await resolveDav(db, ctx.s, ctx.segments, ctx.spaces);
    if (target.kind !== 'node') return fail(409);
    await emit(ctx, [target.node], 'created');
  }
  const node = target.node;
  requireNodeAction(a, target.role, 'space.edit_content');
  const depth =
    node.type === 'folder' && (ctx.c.req.header('depth') ?? 'infinity') !== '0' ? 'infinity' : '0';
  const existing = await locksCovering(db, node.path, depth === 'infinity');
  if (existing.some((l) => l.scope === 'exclusive') || (scope === 'exclusive' && existing.length)) {
    return fail(423, davError('no-conflicting-lock'));
  }
  const [row] = await db
    .insert(davLocks)
    .values({
      orgId: a.org.id,
      nodeId: node.id,
      userId: a.userId,
      scope,
      depth,
      owner,
      timeoutSeconds: timeout,
      expiresAt: expiresAt(),
    })
    .returning();
  const href = davHref(ctx.segments, node.type === 'folder');
  return xmlResponse(created ? 201 : 200, lockBody(row!, href), {
    'Lock-Token': `<${lockToken(row!)}>`,
  });
}

async function unlock(ctx: Ctx) {
  const db = ctx.deps.db;
  // RFC 4918 wants the token in angle brackets; some clients leave them out.
  const m = /^\s*<?opaquelocktoken:([0-9a-f-]{36})>?\s*$/i.exec(
    ctx.c.req.header('lock-token') ?? '',
  );
  if (!m) return fail(400);
  const target = await resolveDav(db, ctx.s, ctx.segments, ctx.spaces);
  if (target.kind !== 'node') return fail(404);
  const found = await lockById(db, m[1]!.toLowerCase());
  const covering = await locksCovering(db, target.node.path);
  if (!found || !covering.some((l) => l.id === found.id)) {
    return fail(409, davError('lock-token-matches-request-uri'));
  }
  if (found.userId !== ctx.s.a.userId) return fail(403);
  await db.delete(davLocks).where(eq(davLocks.id, found.id));
  return new Response(null, { status: 204 });
}

/* -------------------------------- routing -------------------------------- */

const challenge = { 'WWW-Authenticate': 'Basic realm="Crewhall WebDAV", charset="UTF-8"' };

function errorResponse(c: Context<AppEnv>, err: unknown, deps: Deps): Response {
  if (err instanceof DavStatus) {
    return err.body
      ? xmlResponse(err.status, err.body, err.headers)
      : new Response(null, { status: err.status, headers: err.headers });
  }
  if (err instanceof AppError) {
    const status = err.code === 'unauthenticated' ? 401 : (DAV_STATUS[err.code] ?? err.status);
    if (status >= 500 && status !== 507) deps.logger.error({ err }, 'webdav request failed');
    const headers: Record<string, string> = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (status === 401) Object.assign(headers, challenge);
    const retry = (err.details as { retryAfter?: unknown } | undefined)?.retryAfter;
    if (typeof retry === 'number') headers['Retry-After'] = String(retry);
    return new Response(localizedMessage(err.code, c.req.header('accept-language')), {
      status,
      headers,
    });
  }
  deps.logger.error({ err }, 'webdav request failed');
  return new Response(null, { status: 500 });
}

async function dispatch(ctx: Ctx, method: string): Promise<Response> {
  switch (method) {
    case 'PROPFIND':
      return propfind(ctx);
    case 'PROPPATCH':
      return proppatch(ctx);
    case 'GET':
      return get(ctx, false);
    case 'HEAD':
      return get(ctx, true);
    case 'PUT':
      return put(ctx);
    case 'MKCOL':
      return mkcol(ctx);
    case 'DELETE':
      return del(ctx);
    case 'MOVE':
      return moveOrCopy(ctx, false);
    case 'COPY':
      return moveOrCopy(ctx, true);
    case 'LOCK':
      return lock(ctx);
    case 'UNLOCK':
      return unlock(ctx);
    default:
      return new Response(null, { status: 405, headers: { Allow: ALLOW } });
  }
}

const optionsHeaders = {
  DAV: '1, 2',
  'MS-Author-Via': 'DAV',
  Allow: ALLOW,
};

export function registerWebdav(app: Hono<AppEnv>, deps: Deps) {
  // Windows' WebClient probes the server root with OPTIONS before it maps a drive.
  app.on('OPTIONS', '/', () => new Response(null, { status: 200, headers: optionsHeaders }));
  app.on(METHODS, [DAV_PREFIX, `${DAV_PREFIX}/*`], async (c) => {
    const method = c.req.method.toUpperCase();
    const segments = davSegments(new URL(c.req.url).pathname);
    if (!segments) return new Response(null, { status: 404 });
    if (method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: optionsHeaders });
    }
    try {
      const s = await authenticateDav(deps, c);
      if (!s) {
        return new Response(null, { status: 401, headers: challenge });
      }
      const needed = READ_METHODS.has(method) ? 'hub:read' : 'drive:write';
      if (!s.scopes.includes(needed)) {
        throw new AppError('token_scope', { scope: needed });
      }
      const ctx: Ctx = { c, deps, s, segments, spaces: await davSpaces(deps.db, s) };
      const res = await auditVia.run(s.via, () => dispatch(ctx, method));
      res.headers.set('DAV', '1, 2');
      return res;
    } catch (err) {
      return errorResponse(c, err, deps);
    }
  });
}
