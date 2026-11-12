import {
  can,
  canGrantSpaceRole,
  CONTAINER_NODE_TYPES,
  DEFAULT_MAX_FILE_BYTES,
  effectiveNodeRole,
  TRASH_RETENTION_DAYS,
  UPLOAD_PART_SIZE,
  type DriveNode,
  type DriveNodeDetail,
  type NodeType,
  type NodeVersion,
  type PreviewKind,
  type PublicNode,
  type Share,
  type SpaceAction,
  type SpaceRole,
  type TrashItem,
} from '@crewhall/shared';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { imageArt, logoArt, pdfPage, videoPoster } from './art';
import {
  actorOf,
  MockApiError,
  myRole,
  orgCtx,
  paginate,
  randomToken,
  requireUser,
  summary,
  type Resolvers,
} from './core';
import { db, newId, save } from './db';
import {
  seedDrive,
  type BlobArt,
  type DriveState,
  type MockBlob,
  type MockNode,
  type MockShare,
  type MockUpload,
  type MockVersion,
} from './driveSeed';
import { buildPdf } from './pdf';
import { type MockState, type MockUser } from './seed';

/**
 * Drive part of the contract mock (design 03, 19.1-19.5): node tree, multipart uploads with a
 * fake S3 (`/__mock/s3`), signed URLs served from `/__mock/blobs`, shares and public links.
 */

const DAY = 86_400_000;
const PREVIEW_DELAY_MS = 1500;

/** Bytes uploaded in this browser session; the persisted state keeps only metadata. */
const memory = new Map<string, Blob>();
const partBytes = new Map<string, Map<number, Blob>>();

export function driveState(s: MockState = db()): DriveState {
  s.drive ??= seedDrive();
  return s.drive;
}

const now = () => new Date().toISOString();
const live = (n: MockNode) => n.deletedAt === null;
/** Live and not one of the app's own folders: what Drive lists, searches and counts. */
const shown = (n: MockNode) => live(n) && !n.systemRole;

function originOf(request: Request): string {
  return new URL(request.url).origin;
}

function userSummary(s: MockState, id: string | null) {
  const u = id ? s.users.find((x) => x.id === id) : undefined;
  return u ? summary(u) : null;
}

function nodeById(d: DriveState, id: string): MockNode {
  const n = d.nodes.find((x) => x.id === id);
  if (!n) throw new MockApiError('not_found');
  return n;
}

function ancestors(d: DriveState, n: MockNode): MockNode[] {
  const out: MockNode[] = [];
  let p = n.parentId ? d.nodes.find((x) => x.id === n.parentId) : undefined;
  while (p) {
    out.unshift(p);
    p = p.parentId ? d.nodes.find((x) => x.id === p!.parentId) : undefined;
  }
  return out;
}

function isActive(sh: MockShare): boolean {
  return !sh.expiresAt || new Date(sh.expiresAt).getTime() > Date.now();
}

/** Effective role: space role widened by person shares on the node or an ancestor (doc 17 §5). */
function roleOn(s: MockState, d: DriveState, n: MockNode, userId: string): SpaceRole | null {
  const chain = new Set([...ancestors(d, n), n].map((x) => x.id));
  const shareRoles = d.shares
    .filter(
      (x) => x.kind === 'user' && x.granteeId === userId && chain.has(x.nodeId) && isActive(x),
    )
    .map((x) => x.role);
  return effectiveNodeRole(myRole(s, n.spaceId, userId), shareRoles);
}

function allowed(s: MockState, u: MockUser, role: SpaceRole | null, action: SpaceAction) {
  return can(actorOf(s, u), action, { type: 'space', org: orgCtx(s), myRole: role });
}

/** The node for this user, or 404 (no leak) / 403 when visible but the action is not allowed. */
function access(s: MockState, u: MockUser, id: string, action: SpaceAction = 'space.view') {
  const d = driveState(s);
  const n = nodeById(d, id);
  const role = roleOn(s, d, n, u.id);
  if (!role) throw new MockApiError('not_found');
  if (!allowed(s, u, role, action)) throw new MockApiError('forbidden');
  return { d, n, role };
}

function spaceAccess(s: MockState, u: MockUser, spaceId: string, action: SpaceAction) {
  const sp = s.spaces.find((x) => x.id === spaceId);
  const role = sp ? myRole(s, sp.id, u.id) : null;
  if (!sp || !role) throw new MockApiError('not_found');
  if (!allowed(s, u, role, action)) throw new MockApiError('forbidden');
  return sp;
}

function currentVersion(d: DriveState, nodeId: string): MockVersion | undefined {
  return d.versions
    .filter((v) => v.nodeId === nodeId)
    .reduce<MockVersion | undefined>((a, v) => (!a || v.version > a.version ? v : a), undefined);
}

function blobOf(d: DriveState, v: MockVersion | undefined): MockBlob | undefined {
  return v ? d.blobs.find((b) => b.id === v.blobId) : undefined;
}

function previewState(b: MockBlob | undefined): DriveNode['preview'] {
  if (!b) return 'none';
  if (b.art.kind === 'failed') return 'failed';
  if (b.art.kind === 'none' || b.art.kind === 'text') return 'none';
  if (b.readyAt && new Date(b.readyAt).getTime() > Date.now()) return 'pending';
  return 'ready';
}

function isShared(d: DriveState, n: MockNode): boolean {
  const chain = new Set([...ancestors(d, n), n].map((x) => x.id));
  return d.shares.some((x) => chain.has(x.nodeId) && isActive(x));
}

function toNode(s: MockState, d: DriveState, n: MockNode, userId: string): DriveNode {
  const v = n.type === 'file' ? currentVersion(d, n.id) : undefined;
  const b = blobOf(d, v);
  const un = d.userNodes.find((x) => x.userId === userId && x.nodeId === n.id);
  return {
    id: n.id,
    spaceId: n.spaceId,
    parentId: n.parentId,
    type: n.type,
    name: n.name,
    mime: b?.mime ?? null,
    sizeBytes: b?.sizeBytes ?? 0,
    hasChildren: d.nodes.some((x) => x.parentId === n.id && shown(x)),
    myRole: roleOn(s, d, n, userId) ?? 'viewer',
    shared: isShared(d, n),
    favorite: Boolean(un?.favorite),
    preview: previewState(b),
    version: v?.version ?? null,
    createdBy: userSummary(s, n.createdBy),
    updatedBy: userSummary(s, n.updatedBy),
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    deletedAt: n.deletedAt,
  };
}

function toDetail(s: MockState, d: DriveState, n: MockNode, userId: string): DriveNodeDetail {
  const sp = s.spaces.find((x) => x.id === n.spaceId)!;
  return {
    ...toNode(s, d, n, userId),
    path: ancestors(d, n).map((x) => ({ id: x.id, name: x.name })),
    space: { id: sp.id, name: sp.name, color: sp.color },
  };
}

function toVersion(s: MockState, d: DriveState, v: MockVersion): NodeVersion {
  const b = d.blobs.find((x) => x.id === v.blobId);
  const cur = currentVersion(d, v.nodeId);
  return {
    id: v.id,
    version: v.version,
    sizeBytes: b?.sizeBytes ?? 0,
    mime: b?.mime ?? null,
    label: v.label,
    source: v.source,
    current: cur?.id === v.id,
    createdBy: userSummary(s, v.createdBy),
    createdAt: v.createdAt,
  };
}

const fold = (t: string) => t.toLocaleLowerCase('tr');

function compareNodes(sort: string, order: 'asc' | 'desc') {
  return (a: DriveNode, b: DriveNode) => {
    // Folders first whatever the order (3.4 "Klasörler önce").
    const fa = a.type === 'folder' ? 0 : 1;
    const fb = b.type === 'folder' ? 0 : 1;
    if (fa !== fb) return fa - fb;
    let r = 0;
    if (sort === 'updatedAt') r = a.updatedAt.localeCompare(b.updatedAt);
    else if (sort === 'size') r = a.sizeBytes - b.sizeBytes;
    else if (sort === 'type') {
      r = a.type.localeCompare(b.type) || (a.mime ?? '').localeCompare(b.mime ?? '');
    }
    if (r === 0) r = a.name.localeCompare(b.name, 'tr', { numeric: true, sensitivity: 'base' });
    return order === 'desc' ? -r : r;
  };
}

function siblings(d: DriveState, spaceId: string, parentId: string | null): MockNode[] {
  return d.nodes.filter((x) => x.spaceId === spaceId && x.parentId === parentId && live(x));
}

function nameTaken(
  d: DriveState,
  spaceId: string,
  parentId: string | null,
  name: string,
  except?: string,
) {
  return siblings(d, spaceId, parentId).find(
    (x) => !x.systemRole && x.id !== except && fold(x.name) === fold(name),
  );
}

/** "a.pdf" → "a (1).pdf", "a (2).pdf"… (3.14 "İkisini de tut"). */
function freeName(
  d: DriveState,
  spaceId: string,
  parentId: string | null,
  name: string,
  except?: string,
): string {
  if (!nameTaken(d, spaceId, parentId, name, except)) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!nameTaken(d, spaceId, parentId, candidate, except)) return candidate;
  }
}

function subtree(d: DriveState, id: string): MockNode[] {
  const out: MockNode[] = [];
  const walk = (pid: string) => {
    for (const c of d.nodes.filter((x) => x.parentId === pid)) {
      out.push(c);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

function checkTarget(
  s: MockState,
  u: MockUser,
  d: DriveState,
  target: { spaceId: string; parentId: string | null },
) {
  spaceAccess(s, u, target.spaceId, 'space.edit_content');
  if (!target.parentId) return;
  const p = nodeById(d, target.parentId);
  if (p.spaceId !== target.spaceId || !live(p)) throw new MockApiError('invalid_target');
  if (!(CONTAINER_NODE_TYPES as readonly NodeType[]).includes(p.type)) {
    throw new MockApiError('invalid_target');
  }
}

function touch(n: MockNode, userId: string) {
  n.updatedAt = now();
  n.updatedBy = userId;
}

// ---- quota ----

function maxFileBytes(s: MockState): number {
  return s.org?.settings.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
}

function quotaBytes(s: MockState): number | null {
  const q = s.org?.settings.storageQuotaBytes;
  return q === undefined ? 100 * 1024 ** 3 : q;
}

/** Optimistic save, as the server does it: 409 version_conflict past `baseVersion`. */
function assertBaseVersion(d: DriveState, nodeId: string, baseVersion: number | null | undefined) {
  if (baseVersion == null) return;
  const current = currentVersion(d, nodeId)?.version ?? 0;
  if (current !== baseVersion) {
    throw new MockApiError('version_conflict', undefined, { baseVersion, currentVersion: current });
  }
}

/** Logical bytes: every version of every node, trash included, plus reserved uploads. */
function usage(d: DriveState) {
  let used = d.otherBytes;
  let trash = 0;
  for (const v of d.versions) {
    const size = d.blobs.find((b) => b.id === v.blobId)?.sizeBytes ?? 0;
    used += size;
    const n = d.nodes.find((x) => x.id === v.nodeId);
    if (n && !live(n)) trash += size;
  }
  for (const up of d.uploads) if (up.status === 'uploading') used += up.sizeBytes;
  return { used, trash };
}

// ---- uploads ----

function toUpload(up: MockUpload) {
  return {
    id: up.id,
    spaceId: up.spaceId,
    parentId: up.parentId,
    nodeId: up.nodeId,
    name: up.name,
    sizeBytes: up.sizeBytes,
    partSize: up.partSize,
    partCount: up.partCount,
    status:
      up.status === 'uploading' && new Date(up.expiresAt).getTime() < Date.now()
        ? ('expired' as const)
        : up.status,
    uploadedParts: [...up.parts].sort((a, b) => a.partNumber - b.partNumber),
    expiresAt: up.expiresAt,
    createdAt: up.createdAt,
  };
}

function uploadOf(s: MockState, u: MockUser, id: string): MockUpload {
  const up = driveState(s).uploads.find((x) => x.id === id && x.userId === u.id);
  if (!up) throw new MockApiError('not_found');
  return up;
}

async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function artFor(name: string, mime: string | null): BlobArt {
  const m = mime ?? '';
  if (m === 'image/svg+xml') return { kind: 'logo', dark: false };
  if (m.startsWith('image/')) return { kind: 'image', width: 1600, height: 1000 };
  if (m === 'application/pdf') return { kind: 'pdf', title: name, pages: 1, lines: [] };
  if (m.startsWith('video/')) return { kind: 'video', durationSec: 0 };
  if (m.startsWith('text/') || /\.(ya?ml|json|md|sh|env|cs|ts|js)$/i.test(name)) {
    return { kind: 'text', text: '' };
  }
  return { kind: 'none' };
}

// ---- shares ----

function toShare(
  s: MockState,
  d: DriveState,
  sh: MockShare,
  forNode: MockNode,
  request?: Request,
): Share {
  const own = sh.nodeId === forNode.id;
  const src = own ? null : d.nodes.find((x) => x.id === sh.nodeId);
  return {
    id: sh.id,
    nodeId: sh.nodeId,
    kind: sh.kind,
    role: sh.role,
    grantee: userSummary(s, sh.granteeId),
    expiresAt: sh.expiresAt,
    allowDownload: sh.allowDownload,
    hasPassword: Boolean(sh.password),
    inheritedFrom: src ? { id: src.id, name: src.name } : null,
    openCount: sh.openCount,
    createdBy: userSummary(s, sh.createdBy),
    createdAt: sh.createdAt,
    ...(request && sh.token ? { url: `${originOf(request)}/s/${sh.token}` } : {}),
  };
}

function shareById(s: MockState, u: MockUser, id: string) {
  const d = driveState(s);
  const sh = d.shares.find((x) => x.id === id);
  if (!sh) throw new MockApiError('not_found');
  const { n, role } = access(s, u, sh.nodeId);
  const need: SpaceAction = sh.kind === 'link' ? 'space.share_link' : 'space.share_user';
  if (!allowed(s, u, role, need)) throw new MockApiError('forbidden');
  return { d, sh, n };
}

// ---- public links ----

const LOCK_MS = 15 * 60_000;
const MAX_TRIES = 5;

function publicShare(s: MockState, token: string) {
  const d = driveState(s);
  const sh = d.shares.find((x) => x.kind === 'link' && x.token === token);
  const n = sh ? d.nodes.find((x) => x.id === sh.nodeId) : undefined;
  // Unknown, revoked and deleted links answer the same (19.3).
  if (!sh || !n || !live(n)) throw new MockApiError('not_found');
  const sharer = s.users.find((x) => x.id === sh.createdBy);
  if (!isActive(sh)) {
    throw new MockApiError('share_expired', undefined, {
      sharedByName: sharer?.name ?? '',
      expiredAt: sh.expiresAt,
    });
  }
  return { d, sh, n, sharerName: sharer?.name ?? '' };
}

function requireGrant(s: MockState, token: string, grant: string | undefined) {
  const ctx = publicShare(s, token);
  if (ctx.sh.password) {
    const g = ctx.d.grants.find(
      (x) =>
        x.grant === grant &&
        x.shareId === ctx.sh.id &&
        new Date(x.expiresAt).getTime() > Date.now(),
    );
    if (!g) throw new MockApiError('share_password_required');
  }
  return ctx;
}

function toPublicNode(d: DriveState, n: MockNode): PublicNode {
  const v = n.type === 'file' ? currentVersion(d, n.id) : undefined;
  const b = blobOf(d, v);
  return {
    id: n.id,
    type: n.type,
    name: n.name,
    mime: b?.mime ?? null,
    sizeBytes: b?.sizeBytes ?? 0,
    hasChildren: d.nodes.some((x) => x.parentId === n.id && shown(x)),
    preview: previewState(b),
    updatedAt: n.updatedAt,
  };
}

/** A node inside the shared root (never above it, 19.5). */
function withinShare(d: DriveState, root: MockNode, id: string | undefined): MockNode {
  if (!id || id === root.id) return root;
  const n = d.nodes.find((x) => x.id === id);
  if (!n || !live(n) || !ancestors(d, n).some((a) => a.id === root.id)) {
    throw new MockApiError('not_found');
  }
  return n;
}

// ---- signed URLs ----

const SIGNED_TTL = 5 * 60_000;

function signed(request: Request, path: string) {
  const exp = new Date(Date.now() + SIGNED_TTL).toISOString();
  return {
    url: `${originOf(request)}${path}${path.includes('?') ? '&' : '?'}exp=${encodeURIComponent(exp)}`,
    expiresAt: exp,
  };
}

function downloadFor(
  s: MockState,
  d: DriveState,
  n: MockNode,
  request: Request,
  versionId?: string,
) {
  if (n.type !== 'file') throw new MockApiError('invalid_target');
  const v = versionId
    ? d.versions.find((x) => x.id === versionId && x.nodeId === n.id)
    : currentVersion(d, n.id);
  const b = blobOf(d, v);
  if (!b) throw new MockApiError('not_found');
  return {
    ...signed(request, `/__mock/blobs/${b.id}?name=${encodeURIComponent(n.name)}`),
    fileName: n.name,
    sizeBytes: b.sizeBytes,
    mime: b.mime,
  };
}

function previewFor(d: DriveState, n: MockNode, kind: PreviewKind, request: Request) {
  const b = blobOf(d, currentVersion(d, n.id));
  if (n.type !== 'file' || previewState(b) !== 'ready' || !b) {
    throw new MockApiError('preview_unavailable');
  }
  const size = kind === 'thumb_256' ? 256 : 1024;
  const dims = b.art.kind === 'image' ? b.art : null;
  const ratio = dims ? dims.height / dims.width : b.art.kind === 'pdf' ? 842 / 595 : 9 / 16;
  return {
    ...signed(request, `/__mock/preview/${b.id}?kind=${kind}`),
    kind,
    width: size,
    height: Math.round(size * ratio),
  };
}

// ---- resolvers ----

export const driveResolvers = {
  listNodes: ({ s, params, query }) => {
    const u = requireUser(s);
    const d = driveState(s);
    let parentId: string | null = null;
    if (query.parentId) {
      const { n } = access(s, u, query.parentId);
      if (n.spaceId !== params.spaceId || !live(n)) throw new MockApiError('not_found');
      parentId = n.id;
    } else {
      spaceAccess(s, u, params.spaceId ?? '', 'space.view');
    }
    const all = siblings(d, params.spaceId ?? '', parentId)
      .filter(
        (n) => !n.systemRole && roleOn(s, d, n, u.id) && (!query.type || n.type === query.type),
      )
      .map((n) => toNode(s, d, n, u.id))
      .sort(compareNodes(query.sort, query.order));
    return paginate(all, query.cursor, query.limit);
  },

  getNode: ({ s, params }) => {
    const u = requireUser(s);
    const { d, n } = access(s, u, params.nodeId ?? '');
    return toDetail(s, d, n, u.id);
  },

  createFolder: ({ s, params, body }) => {
    const u = requireUser(s);
    const d = driveState(s);
    checkTarget(s, u, d, { spaceId: params.spaceId ?? '', parentId: body.parentId });
    if (body.system) {
      const found = d.nodes.find(
        (x) =>
          live(x) &&
          x.spaceId === params.spaceId &&
          x.parentId === body.parentId &&
          x.systemRole === body.system,
      );
      if (found) return toNode(s, d, found, u.id);
    } else {
      const clash = nameTaken(d, params.spaceId ?? '', body.parentId, body.name);
      if (clash) throw new MockApiError('node_name_taken', undefined, { nodeId: clash.id });
    }
    const n: MockNode = {
      id: newId(),
      spaceId: params.spaceId ?? '',
      parentId: body.parentId,
      type: 'folder',
      name: body.name,
      createdBy: u.id,
      updatedBy: u.id,
      createdAt: now(),
      updatedAt: now(),
      deletedAt: null,
      deletedBy: null,
      trashedWith: null,
      systemRole: body.system ?? null,
    };
    d.nodes.push(n);
    return toNode(s, d, n, u.id);
  },

  updateNode: ({ s, params, body }) => {
    const u = requireUser(s);
    const { d, n } = access(s, u, params.nodeId ?? '', 'space.edit_content');
    if (body.name !== undefined && body.name !== n.name) {
      const clash = nameTaken(d, n.spaceId, n.parentId, body.name, n.id);
      if (clash) throw new MockApiError('node_name_taken', undefined, { nodeId: clash.id });
      n.name = body.name;
      touch(n, u.id);
    }
    return toNode(s, d, n, u.id);
  },

  moveNodes: ({ s, body }) => {
    const u = requireUser(s);
    const d = driveState(s);
    checkTarget(s, u, d, body.target);
    const moved = body.nodeIds.map((id) => access(s, u, id, 'space.edit_content').n);
    for (const n of moved) {
      if (
        n.id === body.target.parentId ||
        subtree(d, n.id).some((x) => x.id === body.target.parentId)
      ) {
        throw new MockApiError('invalid_target');
      }
      const clash = nameTaken(d, body.target.spaceId, body.target.parentId, n.name, n.id);
      if (clash && n.parentId !== body.target.parentId) {
        throw new MockApiError('node_name_taken', undefined, { nodeId: clash.id });
      }
    }
    for (const n of moved) {
      const crossSpace = n.spaceId !== body.target.spaceId;
      const family = [n, ...subtree(d, n.id)];
      for (const x of family) x.spaceId = body.target.spaceId;
      // Across spaces person shares are dropped; public links keep working (3.13).
      if (crossSpace) {
        const ids = new Set(family.map((x) => x.id));
        d.shares = d.shares.filter((sh) => !(sh.kind === 'user' && ids.has(sh.nodeId)));
      }
      n.parentId = body.target.parentId;
      touch(n, u.id);
    }
    return { items: moved.map((n) => toNode(s, d, n, u.id)) };
  },

  copyNodes: ({ s, body }) => {
    const u = requireUser(s);
    const d = driveState(s);
    checkTarget(s, u, d, body.target);
    const sources = body.nodeIds.map((id) => access(s, u, id).n);
    const copyOf = (src: MockNode, parentId: string | null, name: string): MockNode => {
      const c: MockNode = {
        ...src,
        id: newId(),
        spaceId: body.target.spaceId,
        parentId,
        name,
        createdBy: u.id,
        updatedBy: u.id,
        createdAt: now(),
        updatedAt: now(),
      };
      d.nodes.push(c);
      // Same blobs: copying is instant even for large files (3.13).
      const v = currentVersion(d, src.id);
      if (v) {
        d.versions.push({
          ...v,
          id: newId(),
          nodeId: c.id,
          version: 1,
          createdBy: u.id,
          createdAt: now(),
        });
      }
      for (const child of siblings(d, src.spaceId, src.id)) copyOf(child, c.id, child.name);
      return c;
    };
    const copies = sources.map((src) =>
      copyOf(
        src,
        body.target.parentId,
        freeName(d, body.target.spaceId, body.target.parentId, src.name),
      ),
    );
    return { items: copies.map((n) => toNode(s, d, n, u.id)) };
  },

  trashNodes: ({ s, body }) => {
    const u = requireUser(s);
    const d = driveState(s);
    const items = body.nodeIds.map((id) => access(s, u, id, 'space.trash').n);
    for (const n of items) {
      for (const x of [n, ...subtree(d, n.id)].filter(live)) {
        x.deletedAt = now();
        x.deletedBy = u.id;
        x.trashedWith = n.id;
      }
    }
    return { items: items.map((n) => toNode(s, d, n, u.id)) };
  },

  restoreNodes: ({ s, body }) => {
    const u = requireUser(s);
    const d = driveState(s);
    const items = body.nodeIds.map((id) => access(s, u, id, 'space.trash').n);
    for (const n of items) {
      // Back to the old place; to the root when the parent is gone too (3.16).
      const parent = n.parentId ? d.nodes.find((x) => x.id === n.parentId) : undefined;
      if (parent && !live(parent)) n.parentId = null;
      for (const x of [n, ...subtree(d, n.id)].filter((x) => x.trashedWith === n.id)) {
        x.deletedAt = null;
        x.deletedBy = null;
        x.trashedWith = null;
      }
      n.name = freeName(d, n.spaceId, n.parentId, n.name, n.id);
    }
    return { items: items.map((n) => toNode(s, d, n, u.id)) };
  },

  purgeNodes: ({ s, body }) => {
    const u = requireUser(s);
    const d = driveState(s);
    const ids = new Set<string>();
    for (const id of body.nodeIds) {
      const { n } = access(s, u, id, 'space.purge');
      if (live(n)) throw new MockApiError('invalid_target');
      for (const x of [n, ...subtree(d, n.id)]) ids.add(x.id);
    }
    d.nodes = d.nodes.filter((x) => !ids.has(x.id));
    d.versions = d.versions.filter((v) => !ids.has(v.nodeId));
    d.shares = d.shares.filter((x) => !ids.has(x.nodeId));
    d.userNodes = d.userNodes.filter((x) => !ids.has(x.nodeId));
    return {};
  },

  listTrash: ({ s, params, query }) => {
    const u = requireUser(s);
    spaceAccess(s, u, params.spaceId ?? '', 'space.view');
    const d = driveState(s);
    const items: TrashItem[] = d.nodes
      .filter((n) => n.spaceId === params.spaceId && n.deletedAt && n.trashedWith === n.id)
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
      .map((n) => ({
        ...toNode(s, d, n, u.id),
        deletedAt: n.deletedAt!,
        deletedBy: userSummary(s, n.deletedBy),
        purgeAt: new Date(
          new Date(n.deletedAt!).getTime() + TRASH_RETENTION_DAYS * DAY,
        ).toISOString(),
        originalPath: ancestors(d, n)
          .map((a) => a.name)
          .join(' / '),
      }));
    return paginate(items, query.cursor, query.limit);
  },

  emptyTrash: ({ s, params }) => {
    const u = requireUser(s);
    spaceAccess(s, u, params.spaceId ?? '', 'space.purge');
    const d = driveState(s);
    const ids = new Set(
      d.nodes.filter((n) => n.spaceId === params.spaceId && n.deletedAt).map((n) => n.id),
    );
    d.nodes = d.nodes.filter((x) => !ids.has(x.id));
    d.versions = d.versions.filter((v) => !ids.has(v.nodeId));
    d.shares = d.shares.filter((x) => !ids.has(x.nodeId));
    return {};
  },

  // ---- uploads ----

  createUpload: ({ s, body }) => {
    const u = requireUser(s);
    const d = driveState(s);
    let nodeId: string | null = null;
    let replaceNodeId: string | null = null;
    let name = body.name;
    if (body.nodeId) {
      nodeId = access(s, u, body.nodeId, 'space.edit_content').n.id;
      assertBaseVersion(d, nodeId, body.baseVersion);
    } else {
      checkTarget(s, u, d, { spaceId: body.spaceId, parentId: body.parentId });
      const clash = nameTaken(d, body.spaceId, body.parentId, body.name);
      if (clash) {
        if (body.onConflict === 'ask' || clash.type !== 'file') {
          throw new MockApiError('node_name_taken', undefined, { nodeId: clash.id });
        }
        if (body.onConflict === 'version') nodeId = clash.id;
        if (body.onConflict === 'rename') {
          name = freeName(d, body.spaceId, body.parentId, body.name);
        }
        if (body.onConflict === 'replace') replaceNodeId = clash.id;
      }
    }
    if (body.sizeBytes > maxFileBytes(s)) {
      throw new MockApiError('file_too_large', undefined, { maxBytes: maxFileBytes(s) });
    }
    const quota = quotaBytes(s);
    if (quota !== null && usage(d).used + body.sizeBytes > quota) {
      throw new MockApiError('quota_exceeded');
    }
    const up: MockUpload = {
      id: newId(),
      userId: u.id,
      spaceId: body.spaceId,
      parentId: body.parentId,
      nodeId,
      name,
      sizeBytes: body.sizeBytes,
      mime: body.mime ?? null,
      partSize: UPLOAD_PART_SIZE,
      partCount: Math.max(1, Math.ceil(body.sizeBytes / UPLOAD_PART_SIZE)),
      status: 'uploading',
      parts: [],
      replaceNodeId,
      baseVersion: nodeId ? (body.baseVersion ?? null) : null,
      expiresAt: new Date(Date.now() + DAY).toISOString(),
      createdAt: now(),
    };
    d.uploads.push(up);
    return toUpload(up);
  },

  getUpload: ({ s, params }) => toUpload(uploadOf(s, requireUser(s), params.uploadId ?? '')),

  getUploadPartUrls: ({ s, params, body, request }) => {
    const up = uploadOf(s, requireUser(s), params.uploadId ?? '');
    if (up.status !== 'uploading') throw new MockApiError('upload_invalid');
    if (body.partNumbers.some((p) => p > up.partCount)) throw new MockApiError('upload_invalid');
    const exp = new Date(Date.now() + 60 * 60_000).toISOString();
    return {
      parts: body.partNumbers.map((partNumber) => ({
        partNumber,
        url: `${originOf(request)}/__mock/s3/${up.id}/${partNumber}`,
      })),
      expiresAt: exp,
    };
  },

  completeUpload: async ({ s, params, body }) => {
    const u = requireUser(s);
    const up = uploadOf(s, u, params.uploadId ?? '');
    const d = driveState(s);
    if (up.status !== 'uploading') throw new MockApiError('upload_invalid');
    const byNumber = new Map(up.parts.map((p) => [p.partNumber, p]));
    const complete =
      body.parts.length === up.partCount &&
      body.parts.every((p) => byNumber.get(p.partNumber)?.etag === p.etag);
    const total = up.parts.reduce((a, p) => a + p.sizeBytes, 0);
    if (!complete || total !== up.sizeBytes) throw new MockApiError('upload_invalid');
    if (up.nodeId) {
      try {
        assertBaseVersion(d, up.nodeId, up.baseVersion);
      } catch (e) {
        up.status = 'aborted';
        throw e;
      }
    }

    // Join the parts the fake S3 kept; dedup on the content hash (doc 17 §8 step 6).
    const pieces = partBytes.get(up.id);
    const joined = pieces
      ? new Blob(
          [...pieces.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b),
          {
            type: up.mime ?? '',
          },
        )
      : null;
    partBytes.delete(up.id);
    const sha =
      joined && joined.size === up.sizeBytes ? await sha256Hex(joined) : `upload-${up.id}`;
    let blob = d.blobs.find((b) => b.sha256 === sha);
    if (!blob) {
      blob = {
        id: newId(),
        sha256: sha,
        sizeBytes: up.sizeBytes,
        mime: up.mime,
        art: artFor(up.name, up.mime),
        uploaded: true,
        readyAt: new Date(Date.now() + PREVIEW_DELAY_MS).toISOString(),
      };
      d.blobs.push(blob);
      if (joined) memory.set(blob.id, joined);
    }

    let n: MockNode;
    if (up.nodeId) {
      n = nodeById(d, up.nodeId);
    } else {
      if (up.replaceNodeId) {
        const old = d.nodes.find((x) => x.id === up.replaceNodeId);
        if (old) {
          old.deletedAt = now();
          old.deletedBy = u.id;
          old.trashedWith = old.id;
        }
      }
      n = {
        id: newId(),
        spaceId: up.spaceId,
        parentId: up.parentId,
        type: 'file',
        name: up.name,
        createdBy: u.id,
        updatedBy: u.id,
        createdAt: now(),
        updatedAt: now(),
        deletedAt: null,
        deletedBy: null,
        trashedWith: null,
      };
      d.nodes.push(n);
    }
    const v: MockVersion = {
      id: newId(),
      nodeId: n.id,
      version: (currentVersion(d, n.id)?.version ?? 0) + 1,
      blobId: blob.id,
      label: null,
      source: 'web',
      createdBy: u.id,
      createdAt: now(),
    };
    d.versions.push(v);
    touch(n, u.id);
    up.status = 'completed';
    up.nodeId = n.id;
    return { node: toNode(s, d, n, u.id), version: toVersion(s, d, v) };
  },

  abortUpload: ({ s, params }) => {
    const up = uploadOf(s, requireUser(s), params.uploadId ?? '');
    up.status = 'aborted';
    partBytes.delete(up.id);
    return {};
  },

  // ---- download, preview, versions ----

  getDownloadUrl: ({ s, params, query, request }) => {
    const u = requireUser(s);
    const { d, n } = access(s, u, params.nodeId ?? '');
    return downloadFor(s, d, n, request, query.versionId);
  },

  getPreview: ({ s, params, query, request }) => {
    const u = requireUser(s);
    const { d, n } = access(s, u, params.nodeId ?? '');
    return previewFor(d, n, query.kind, request);
  },

  listVersions: ({ s, params }) => {
    const u = requireUser(s);
    const { d, n } = access(s, u, params.nodeId ?? '');
    return {
      items: d.versions
        .filter((v) => v.nodeId === n.id)
        .sort((a, b) => b.version - a.version)
        .map((v) => toVersion(s, d, v)),
    };
  },

  restoreVersion: ({ s, params }) => {
    const u = requireUser(s);
    const { d, n } = access(s, u, params.nodeId ?? '', 'space.edit_content');
    const old = d.versions.find((v) => v.id === params.versionId && v.nodeId === n.id);
    if (!old) throw new MockApiError('not_found');
    const v: MockVersion = {
      ...old,
      id: newId(),
      version: (currentVersion(d, n.id)?.version ?? 0) + 1,
      label: null,
      createdBy: u.id,
      createdAt: now(),
    };
    d.versions.push(v);
    touch(n, u.id);
    return toVersion(s, d, v);
  },

  // ---- shares ----

  // H16: addresses are kept, so lists carry them too.
  listShares: ({ s, params, request }) => {
    const u = requireUser(s);
    const { d, n } = access(s, u, params.nodeId ?? '');
    const chain = new Set([...ancestors(d, n), n].map((x) => x.id));
    const sp = s.spaces.find((x) => x.id === n.spaceId)!;
    return {
      items: d.shares.filter((x) => chain.has(x.nodeId)).map((x) => toShare(s, d, x, n, request)),
      space: {
        id: sp.id,
        name: sp.name,
        memberCount: s.spaceMembers.filter((x) => x.spaceId === sp.id).length,
      },
    };
  },

  createShare: ({ s, params, body, request }) => {
    const u = requireUser(s);
    const { d, n, role } = access(s, u, params.nodeId ?? '');
    const base = {
      id: newId(),
      nodeId: n.id,
      openCount: 0,
      failures: 0,
      lockedUntil: null,
      createdBy: u.id,
      createdAt: now(),
      expiresAt: body.expiresAt ?? null,
    };
    let sh: MockShare;
    if (body.kind === 'user') {
      if (!allowed(s, u, role, 'space.share_user') || !canGrantSpaceRole(role, body.role)) {
        throw new MockApiError('forbidden');
      }
      if (!s.members.some((m) => m.userId === body.userId)) {
        throw new MockApiError('member_not_found');
      }
      const existing = d.shares.find(
        (x) => x.kind === 'user' && x.nodeId === n.id && x.granteeId === body.userId,
      );
      if (existing) throw new MockApiError('conflict');
      sh = {
        ...base,
        kind: 'user',
        role: body.role,
        granteeId: body.userId,
        token: null,
        password: null,
        allowDownload: true,
      };
    } else {
      if (!allowed(s, u, role, 'space.share_link')) throw new MockApiError('forbidden');
      sh = {
        ...base,
        kind: 'link',
        role: 'viewer',
        granteeId: null,
        token: randomToken(6),
        password: body.password ?? null,
        allowDownload: body.allowDownload,
      };
    }
    d.shares.push(sh);
    return toShare(s, d, sh, n, sh.kind === 'link' ? request : undefined);
  },

  updateShare: ({ s, params, body }) => {
    const u = requireUser(s);
    const { d, sh, n } = shareById(s, u, params.shareId ?? '');
    if (body.role !== undefined) {
      if (sh.kind === 'link' && body.role !== 'viewer') throw new MockApiError('validation_failed');
      sh.role = body.role;
    }
    if (body.expiresAt !== undefined) sh.expiresAt = body.expiresAt;
    if (body.allowDownload !== undefined) sh.allowDownload = body.allowDownload;
    if (body.password !== undefined) sh.password = body.password;
    return toShare(s, d, sh, n);
  },

  deleteShare: ({ s, params }) => {
    const u = requireUser(s);
    const { d, sh } = shareById(s, u, params.shareId ?? '');
    d.shares = d.shares.filter((x) => x !== sh);
    return {};
  },

  regenerateShareLink: ({ s, params, request }) => {
    const u = requireUser(s);
    const { d, sh, n } = shareById(s, u, params.shareId ?? '');
    if (sh.kind !== 'link') throw new MockApiError('validation_failed');
    sh.token = randomToken(6);
    d.grants = d.grants.filter((g) => g.shareId !== sh.id);
    return toShare(s, d, sh, n, request);
  },

  // ---- public links ----

  getPublicShare: ({ s, params, query }) => {
    const { d, sh, n, sharerName } = publicShare(s, params.token ?? '');
    const base = { orgName: s.org?.name ?? '', sharedBy: { name: sharerName } };
    const granted =
      !sh.password ||
      d.grants.some(
        (g) =>
          g.grant === query.grant &&
          g.shareId === sh.id &&
          new Date(g.expiresAt).getTime() > Date.now(),
      );
    if (!granted) return { ...base, status: 'password_required' as const };
    sh.openCount++;
    return {
      ...base,
      status: 'ok' as const,
      node: toPublicNode(d, n),
      allowDownload: sh.allowDownload,
      expiresAt: sh.expiresAt,
    };
  },

  unlockPublicShare: ({ s, params, body }) => {
    const { d, sh } = publicShare(s, params.token ?? '');
    if (sh.lockedUntil && new Date(sh.lockedUntil).getTime() > Date.now()) {
      throw new MockApiError('share_locked', undefined, { lockedUntil: sh.lockedUntil });
    }
    if (!sh.password || body.password !== sh.password) {
      sh.failures++;
      if (sh.failures >= MAX_TRIES) {
        sh.failures = 0;
        sh.lockedUntil = new Date(Date.now() + LOCK_MS).toISOString();
        throw new MockApiError('share_locked', undefined, { lockedUntil: sh.lockedUntil });
      }
      throw new MockApiError('share_password_invalid', undefined, {
        remainingAttempts: MAX_TRIES - sh.failures,
      });
    }
    sh.failures = 0;
    const grant = {
      grant: randomToken(18),
      shareId: sh.id,
      expiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
    };
    d.grants.push(grant);
    return { grant: grant.grant, expiresAt: grant.expiresAt };
  },

  listPublicShareNodes: ({ s, params, query }) => {
    const { d, n } = requireGrant(s, params.token ?? '', query.grant);
    const folder = withinShare(d, n, query.parentId);
    if (folder.type !== 'folder') throw new MockApiError('invalid_target');
    const all = siblings(d, folder.spaceId, folder.id)
      .sort(
        (a, b) =>
          (a.type === 'folder' ? 0 : 1) - (b.type === 'folder' ? 0 : 1) ||
          a.name.localeCompare(b.name, 'tr'),
      )
      .map((x) => toPublicNode(d, x));
    return paginate(all, query.cursor, query.limit);
  },

  getPublicDownloadUrl: ({ s, params, query, request }) => {
    const { d, sh, n } = requireGrant(s, params.token ?? '', query.grant);
    if (!sh.allowDownload) throw new MockApiError('forbidden');
    return downloadFor(s, d, withinShare(d, n, query.nodeId), request);
  },

  getPublicPreview: ({ s, params, query, request }) => {
    const { d, n } = requireGrant(s, params.token ?? '', query.grant);
    return previewFor(d, withinShare(d, n, query.nodeId), query.kind, request);
  },

  // ---- favorites, recent, search, quota ----

  listFavorites: ({ s }) => {
    const u = requireUser(s);
    const d = driveState(s);
    const items = d.userNodes
      .filter((x) => x.userId === u.id && x.favorite)
      .sort((a, b) => a.favoritePos - b.favoritePos)
      .map((x) => d.nodes.find((n) => n.id === x.nodeId))
      .filter((n): n is MockNode => Boolean(n && live(n) && roleOn(s, d, n, u.id)))
      .map((n) => toNode(s, d, n, u.id));
    return { items };
  },

  setFavorite: ({ s, params, body }) => {
    const u = requireUser(s);
    const { d, n } = access(s, u, params.nodeId ?? '');
    let un = d.userNodes.find((x) => x.userId === u.id && x.nodeId === n.id);
    if (!un) {
      un = { userId: u.id, nodeId: n.id, favorite: false, favoritePos: 0, lastOpenedAt: null };
      d.userNodes.push(un);
    }
    un.favorite = body.favorite;
    if (body.favorite) {
      const mine = d.userNodes
        .filter((x) => x.userId === u.id && x.favorite && x !== un)
        .sort((a, b) => a.favoritePos - b.favoritePos);
      const at =
        body.afterId === undefined
          ? mine.length
          : body.afterId === null
            ? 0
            : mine.findIndex((x) => x.nodeId === body.afterId) + 1;
      mine.splice(at, 0, un);
      mine.forEach((x, i) => (x.favoritePos = i));
    }
    return toNode(s, d, n, u.id);
  },

  listRecent: ({ s, query }) => {
    const u = requireUser(s);
    const d = driveState(s);
    const items = d.userNodes
      .filter((x) => x.userId === u.id && x.lastOpenedAt)
      .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''))
      .flatMap((x) => {
        const n = d.nodes.find((y) => y.id === x.nodeId);
        // Lost access or deleted: drops silently (3.17).
        return n && live(n) && roleOn(s, d, n, u.id)
          ? [{ ...toNode(s, d, n, u.id), lastOpenedAt: x.lastOpenedAt! }]
          : [];
      })
      .slice(0, query.limit);
    return { items };
  },

  markNodeOpened: ({ s, params }) => {
    const u = requireUser(s);
    const { d, n } = access(s, u, params.nodeId ?? '');
    const un = d.userNodes.find((x) => x.userId === u.id && x.nodeId === n.id);
    if (un) un.lastOpenedAt = now();
    else {
      d.userNodes.push({
        userId: u.id,
        nodeId: n.id,
        favorite: false,
        favoritePos: 0,
        lastOpenedAt: now(),
      });
    }
    return {};
  },

  // No sync clients in mock mode: an empty feed is enough for the contract.
  listDriveChanges: () => ({ items: [], nextCursor: 'mock', hasMore: false }),

  searchNodes: ({ s, query }) => {
    const u = requireUser(s);
    const d = driveState(s);
    const q = fold(query.q);
    const hits = d.nodes
      .filter(
        (n) =>
          shown(n) &&
          (!query.spaceId || n.spaceId === query.spaceId) &&
          (!query.type || n.type === query.type) &&
          fold(n.name).includes(q) &&
          roleOn(s, d, n, u.id) !== null,
      )
      .sort((a, b) => {
        const pa = fold(a.name).startsWith(q) ? 0 : 1;
        const pb = fold(b.name).startsWith(q) ? 0 : 1;
        return pa - pb || b.updatedAt.localeCompare(a.updatedAt);
      })
      .map((n) => {
        const sp = s.spaces.find((x) => x.id === n.spaceId)!;
        return {
          node: toNode(s, d, n, u.id),
          path: ancestors(d, n).map((a) => ({ id: a.id, name: a.name })),
          space: { id: sp.id, name: sp.name, color: sp.color },
        };
      });
    return paginate(hits, query.cursor, query.limit);
  },

  getQuota: ({ s }) => {
    requireUser(s);
    const d = driveState(s);
    const { used, trash } = usage(d);
    const quota = quotaBytes(s);
    return {
      usedBytes: used,
      quotaBytes: quota,
      trashBytes: trash,
      maxFileBytes: maxFileBytes(s),
      warning: quota !== null && used >= quota * 0.9,
      full: quota !== null && used >= quota,
    };
  },
} satisfies Resolvers<
  | 'listNodes'
  | 'getNode'
  | 'createFolder'
  | 'updateNode'
  | 'moveNodes'
  | 'copyNodes'
  | 'trashNodes'
  | 'restoreNodes'
  | 'purgeNodes'
  | 'listTrash'
  | 'emptyTrash'
  | 'createUpload'
  | 'getUpload'
  | 'getUploadPartUrls'
  | 'completeUpload'
  | 'abortUpload'
  | 'getDownloadUrl'
  | 'getPreview'
  | 'listVersions'
  | 'restoreVersion'
  | 'listShares'
  | 'createShare'
  | 'updateShare'
  | 'deleteShare'
  | 'regenerateShareLink'
  | 'getPublicShare'
  | 'unlockPublicShare'
  | 'listPublicShareNodes'
  | 'getPublicDownloadUrl'
  | 'getPublicPreview'
  | 'listFavorites'
  | 'setFavorite'
  | 'listRecent'
  | 'markNodeOpened'
  | 'listDriveChanges'
  | 'searchNodes'
  | 'getQuota'
>;

/** Node for quick access cards: null when deleted or not visible (the card shows locked). */
export function nodeForUser(s: MockState, nodeId: string, userId: string): DriveNode | null {
  const d = driveState(s);
  const n = d.nodes.find((x) => x.id === nodeId);
  return n && live(n) && roleOn(s, d, n, userId) ? toNode(s, d, n, userId) : null;
}

export function childrenForUser(s: MockState, nodeId: string, userId: string, limit: number) {
  const d = driveState(s);
  const n = d.nodes.find((x) => x.id === nodeId);
  if (!n || n.type !== 'folder') return [];
  return siblings(d, n.spaceId, n.id)
    .filter((x) => roleOn(s, d, x, userId))
    .map((x) => toNode(s, d, x, userId))
    .sort(compareNodes('name', 'asc'))
    .slice(0, limit);
}

// ---- fake object store and raw paths ----

function svgBody(dataUrl: string): string {
  return decodeURIComponent(dataUrl.slice(dataUrl.indexOf(',') + 1));
}

function previewSvg(b: MockBlob, name: string): string | null {
  const art = b.art;
  if (art.kind === 'image') return svgBody(imageArt(b.id, art.width, art.height));
  if (art.kind === 'logo') return svgBody(logoArt(name, art.dark));
  if (art.kind === 'pdf') return svgBody(pdfPage(art.title, art.lines.slice(0, 5), 1));
  if (art.kind === 'video') return svgBody(videoPoster(b.id));
  return null;
}

async function blobResponse(b: MockBlob, name: string): Promise<Response> {
  const kept = memory.get(b.id);
  if (kept) {
    // Bytes, not the Blob: under Node (tests) jsdom's Blob is not a body undici can stream.
    return new HttpResponse(await kept.arrayBuffer(), {
      headers: { 'content-type': b.mime ?? 'application/octet-stream' },
    });
  }
  const art = b.art;
  if (art.kind === 'pdf') {
    const pages = Array.from({ length: Math.min(art.pages, 30) }, () => art.lines);
    return new HttpResponse(buildPdf(art.title, pages), {
      headers: { 'content-type': 'application/pdf' },
    });
  }
  if (art.kind === 'text') {
    return new HttpResponse(art.text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const svg = previewSvg(b, name);
  if (svg) return new HttpResponse(svg, { headers: { 'content-type': 'image/svg+xml' } });
  return new HttpResponse(`Crewhall mock content: ${name}\n`, {
    headers: { 'content-type': 'application/octet-stream' },
  });
}

/** Where the client PUTs parts, the signed URLs point, and the raw 302 paths land. */
export const driveRawHandlers: HttpHandler[] = [
  http.put('*/__mock/s3/:uploadId/:part', async ({ params, request }) => {
    const s = db();
    const up = driveState(s).uploads.find((x) => x.id === params.uploadId);
    const partNumber = Number(params.part);
    if (!up || up.status !== 'uploading') return new HttpResponse(null, { status: 404 });
    const body = await request.blob();
    const etag = `"${up.id.slice(0, 8)}-${partNumber}-${body.size}"`;
    up.parts = up.parts.filter((p) => p.partNumber !== partNumber);
    up.parts.push({ partNumber, sizeBytes: body.size, etag });
    // Keep bytes for previews of small uploads only.
    if (up.sizeBytes <= 256 * 1024 * 1024) {
      const map = partBytes.get(up.id) ?? new Map<number, Blob>();
      map.set(partNumber, body);
      partBytes.set(up.id, map);
    }
    save();
    return new HttpResponse(null, { status: 200, headers: { ETag: etag } });
  }),
  http.get('*/__mock/blobs/:blobId', ({ params, request }) => {
    const b = driveState().blobs.find((x) => x.id === params.blobId);
    if (!b) return new HttpResponse(null, { status: 404 });
    return blobResponse(b, new URL(request.url).searchParams.get('name') ?? 'file');
  }),
  http.get('*/__mock/preview/:blobId', ({ params }) => {
    const b = driveState().blobs.find((x) => x.id === params.blobId);
    const kept = b ? memory.get(b.id) : undefined;
    if (b && kept && (b.mime ?? '').startsWith('image/')) {
      return new HttpResponse(kept, { headers: { 'content-type': b.mime ?? '' } });
    }
    const svg = b ? previewSvg(b, b.id) : null;
    if (!svg) return new HttpResponse(null, { status: 404 });
    return new HttpResponse(svg, { headers: { 'content-type': 'image/svg+xml' } });
  }),
  http.get('*/api/v1/nodes/:nodeId/preview/raw', ({ params, request }) => {
    const s = db();
    const u = s.sessions.find((x) => x.id === s.auth.sessionId);
    const d = driveState(s);
    const n = d.nodes.find((x) => x.id === params.nodeId);
    if (!u || !n || !roleOn(s, d, n, u.userId)) return new HttpResponse(null, { status: 404 });
    const b = blobOf(d, currentVersion(d, n.id));
    if (!b || previewState(b) !== 'ready') return new HttpResponse(null, { status: 404 });
    const kind = new URL(request.url).searchParams.get('kind') ?? 'thumb_256';
    return HttpResponse.redirect(`${originOf(request)}/__mock/preview/${b.id}?kind=${kind}`, 302);
  }),
];

/** Public views of other modules (a page, a board; H15): the node behind a link. */
export function mockPublicNode(
  s: MockState,
  token: string,
  grant: string | undefined,
  nodeId: string | undefined,
) {
  const { d, sh, n } = requireGrant(s, token, grant);
  return { node: withinShare(d, n, nodeId), allowDownload: sh.allowDownload };
}
