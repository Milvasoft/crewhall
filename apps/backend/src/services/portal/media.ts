import { and, asc, eq, isNull, like } from 'drizzle-orm';
import {
  blobs,
  newId,
  portalDocs,
  portalMedia,
  portalPosts,
  portalSites,
  type DbOrTx,
} from '@crewhall/db';
import type { CreatePortalMedia, PortalMedia, PortalMediaUsage } from '@crewhall/shared';
import sharp from 'sharp';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import type { Storage } from '../../storage/s3';
import { audit } from '../audit';
import { releaseBlob } from '../drive/tree';
import { requireStorage } from '../drive/files';
import {
  loadSite,
  requireEdit,
  requireView,
  userSummaries,
  type PortalActor,
  type SiteRow,
} from './access';

export type MediaRow = typeof portalMedia.$inferSelect;

/** Upper bound for one media file (design 10.14: images, PDFs). */
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/** Editors load media through the api with their session (design 10.14 "kalıcı URL"). */
export const editorMediaUrl = (siteId: string, path: string) =>
  `/api/v1/portal/sites/${siteId}/files/${path.replace(/^\/media\//, '')}`;

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  json: 'application/json',
  txt: 'text/plain',
};

export function mimeFor(fileName: string, declared?: string | null) {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MIME[ext] ?? declared ?? 'application/octet-stream';
}

const safeSegment = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'file';

/** Where a media path is referenced: docs, posts, home, navigation, settings. */
async function usageMap(db: DbOrTx, site: SiteRow, paths: string[]) {
  const usage = new Map<string, PortalMediaUsage[]>(paths.map((p) => [p, []]));
  if (!paths.length) return usage;
  const docs = await db
    .select({
      id: portalDocs.id,
      title: portalDocs.title,
      locale: portalDocs.locale,
      content: portalDocs.content,
      md: portalDocs.contentMd,
    })
    .from(portalDocs)
    .where(and(eq(portalDocs.siteId, site.id), isNull(portalDocs.deletedAt)));
  const posts = await db
    .select({
      id: portalPosts.id,
      title: portalPosts.title,
      locale: portalPosts.locale,
      content: portalPosts.content,
      cover: portalPosts.cover,
      md: portalPosts.contentMd,
    })
    .from(portalPosts)
    .where(and(eq(portalPosts.siteId, site.id), isNull(portalPosts.deletedAt)));
  const texts: { usage: PortalMediaUsage; text: string }[] = [
    ...docs.map((d) => ({
      usage: { kind: 'doc' as const, id: d.id, title: d.title, locale: d.locale },
      text: `${JSON.stringify(d.content)}\n${d.md ?? ''}`,
    })),
    ...posts.map((p) => ({
      usage: { kind: 'post' as const, id: p.id, title: p.title, locale: p.locale },
      text: `${JSON.stringify(p.content)}\n${p.md ?? ''}\n${p.cover ?? ''}`,
    })),
    {
      usage: { kind: 'home', id: null, title: 'home', locale: null },
      text: JSON.stringify([site.homeDraft, site.home]),
    },
    {
      usage: { kind: 'navigation', id: null, title: 'navigation', locale: null },
      text: JSON.stringify([site.navDraft, site.nav]),
    },
    {
      usage: { kind: 'settings', id: null, title: 'settings', locale: null },
      text: JSON.stringify(site.settings),
    },
  ];
  for (const p of paths) {
    // Old Docusaurus static paths (/img/x) count too.
    const alt = p.startsWith('/media/img/') ? p.replace('/media/img/', '/img/') : null;
    for (const t of texts) {
      if (t.text.includes(p) || (alt && t.text.includes(`"${alt}`))) usage.get(p)!.push(t.usage);
    }
  }
  return usage;
}

async function toMedia(db: DbOrTx, site: SiteRow, rows: MediaRow[]): Promise<PortalMedia[]> {
  const usage = await usageMap(
    db,
    site,
    rows.map((r) => r.path),
  );
  const people = await userSummaries(
    db,
    rows.map((r) => r.createdBy),
  );
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    fileName: r.fileName,
    mime: r.mime,
    size: r.size,
    width: r.width,
    height: r.height,
    alt: r.alt,
    url: editorMediaUrl(site.id, r.path),
    status: r.blobId ? 'ready' : 'pending',
    usage: usage.get(r.path) ?? [],
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy ? (people.get(r.createdBy) ?? null) : null,
  }));
}

async function loadMedia(db: DbOrTx, a: PortalActor, mediaId: string) {
  const [row] = await db
    .select()
    .from(portalMedia)
    .where(and(eq(portalMedia.id, mediaId), eq(portalMedia.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  return { row, site: await loadSite(db, a, row.siteId) };
}

export async function listMedia(
  db: DbOrTx,
  a: PortalActor,
  siteId: string,
  filter: 'all' | 'image' | 'document' | 'unused',
) {
  requireView(a);
  const site = await loadSite(db, a, siteId);
  const rows = await db
    .select()
    .from(portalMedia)
    .where(
      and(
        eq(portalMedia.siteId, site.id),
        filter === 'image' ? like(portalMedia.mime, 'image/%') : undefined,
      ),
    )
    .orderBy(asc(portalMedia.path));
  let items = await toMedia(db, site, rows);
  if (filter === 'document') items = items.filter((m) => !m.mime?.startsWith('image/'));
  if (filter === 'unused') items = items.filter((m) => m.usage.length === 0);
  return { items };
}

async function uniquePath(db: DbOrTx, siteId: string, wanted: string) {
  const dot = wanted.lastIndexOf('.');
  const base = dot > wanted.lastIndexOf('/') ? wanted.slice(0, dot) : wanted;
  const ext = dot > wanted.lastIndexOf('/') ? wanted.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? wanted : `${base}-${i}${ext}`;
    const [clash] = await db
      .select({ id: portalMedia.id })
      .from(portalMedia)
      .where(and(eq(portalMedia.siteId, siteId), eq(portalMedia.path, candidate)));
    if (!clash) return candidate;
  }
  throw new AppError('conflict');
}

export async function createMedia(
  db: DbOrTx,
  a: PortalActor,
  siteId: string,
  input: CreatePortalMedia,
) {
  requireEdit(a);
  const site = await loadSite(db, a, siteId);
  const folder = (input.folder ?? 'uploads').split('/').map(safeSegment).filter(Boolean).join('/');
  const path = await uniquePath(db, site.id, `/media/${folder}/${safeSegment(input.fileName)}`);
  const [row] = await db
    .insert(portalMedia)
    .values({
      orgId: site.orgId,
      siteId: site.id,
      path,
      fileName: input.fileName,
      mime: mimeFor(input.fileName, input.mime),
      size: input.size,
      createdBy: a.userId,
    })
    .returning();
  const [media] = await toMedia(db, site, [row!]);
  return { media: media!, uploadPath: `/api/v1/portal/media/${row!.id}/content` };
}

async function dimensions(data: Buffer, mime: string) {
  if (!mime.startsWith('image/') || mime === 'image/x-icon') return { width: null, height: null };
  try {
    const meta = await sharp(data, { failOn: 'none' }).metadata();
    return { width: meta.width ?? null, height: meta.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

/**
 * Stores bytes for a media row (first upload or "Değiştir"): the path stays, the blob changes,
 * so pages using it need no republish (design 10.14).
 */
export async function storeMediaBytes(
  db: DbOrTx,
  storage: Storage,
  site: Pick<SiteRow, 'id' | 'orgId'>,
  media: MediaRow,
  data: Buffer,
  mime?: string | null,
) {
  const type = mimeFor(media.fileName, mime ?? media.mime);
  const storageKey = `orgs/${site.orgId}/blobs/${newId()}`;
  await storage.put(storageKey, data, type);
  const [blob] = await db
    .insert(blobs)
    // No sha256: portal media keep their own blob (no dedup with Drive files).
    .values({
      orgId: site.orgId,
      size: data.length,
      mime: type,
      storageKey,
      status: 'ready',
      refCount: 1,
    })
    .returning();
  const { width, height } = await dimensions(data, type);
  const [updated] = await db
    .update(portalMedia)
    .set({ blobId: blob!.id, size: data.length, mime: type, width, height })
    .where(eq(portalMedia.id, media.id))
    .returning();
  if (media.blobId) await releaseBlob(db, media.blobId);
  await db.update(portalSites).set({ updatedAt: new Date() }).where(eq(portalSites.id, site.id));
  return updated!;
}

export async function uploadMediaContent(
  deps: Deps,
  a: PortalActor,
  mediaId: string,
  data: Buffer,
  mime: string | null,
) {
  requireEdit(a);
  const { row, site } = await loadMedia(deps.db, a, mediaId);
  if (data.length > MAX_MEDIA_BYTES) throw new AppError('file_too_large');
  const updated = await storeMediaBytes(deps.db, requireStorage(deps), site, row, data, mime);
  return (await toMedia(deps.db, site, [updated]))[0]!;
}

export async function updateMedia(
  db: DbOrTx,
  a: PortalActor,
  mediaId: string,
  alt: Record<string, string>,
) {
  requireEdit(a);
  const { row, site } = await loadMedia(db, a, mediaId);
  const [updated] = await db
    .update(portalMedia)
    .set({ alt })
    .where(eq(portalMedia.id, row.id))
    .returning();
  return (await toMedia(db, site, [updated!]))[0]!;
}

export async function deleteMedia(db: DbOrTx, a: PortalActor, mediaId: string, req: RequestInfo) {
  requireEdit(a);
  const { row, site } = await loadMedia(db, a, mediaId);
  const [media] = await toMedia(db, site, [row]);
  if (media && media.usage.length)
    throw new AppError('portal_media_in_use', { usage: media.usage.length });
  await db.delete(portalMedia).where(eq(portalMedia.id, row.id));
  if (row.blobId) await releaseBlob(db, row.blobId);
  await audit(
    db,
    {
      orgId: site.orgId,
      actorId: a.userId,
      action: 'portal.media.delete',
      targetType: 'portal_media',
      targetId: row.id,
      meta: { path: row.path },
    },
    req,
  );
  return {};
}

/** The bytes of `/media/<rest>` of a site, for the editor route and the public route. */
export async function mediaFile(deps: Deps, siteId: string, rest: string) {
  const path = `/media/${rest}`;
  const [row] = await deps.db
    .select({ media: portalMedia, blob: blobs })
    .from(portalMedia)
    .innerJoin(blobs, eq(blobs.id, portalMedia.blobId))
    .where(and(eq(portalMedia.siteId, siteId), eq(portalMedia.path, path)));
  if (!row) throw new AppError('not_found');
  const storage = requireStorage(deps);
  return {
    stream: await storage.getStream(row.blob.storageKey),
    mime: row.media.mime ?? 'application/octet-stream',
    size: row.blob.size,
    etag: `"${row.blob.id}"`,
  };
}

export async function viewerCanSeeSite(db: DbOrTx, a: PortalActor, siteId: string) {
  requireView(a);
  return loadSite(db, a, siteId);
}
