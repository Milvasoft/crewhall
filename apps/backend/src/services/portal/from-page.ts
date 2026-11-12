import { and, eq, isNull } from 'drizzle-orm';
import { blobs, nodeVersions, portalDocs, portalMedia, type Db } from '@crewhall/db';
import type { EditorDoc, JSONMark, JSONNode } from '@crewhall/editor';
import type { PortalDocFromPage, PortalDocFromPageResult } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { Storage } from '../../storage/s3';
import { loadNode } from '../drive/access';
import { loadPage } from '../wiki/access';
import { docFromState, docToJson } from '../wiki/doc';
import { loadSite, requireEdit, type PortalActor, type SiteRow } from './access';
import { createDoc, updateDoc, versionByName } from './docs';
import { MAX_MEDIA_BYTES, storeMediaBytes } from './media';

/**
 * "Portal'a gönder" (design 05 5.12, 10.13): a Hub page becomes a draft doc of a portal site. The
 * page stays the source; sending it again to the same version and language updates the same draft,
 * and publishing is still its own step. Images in the page's Drive are copied to the site's media,
 * links to Hub pages become plain text, and what may not leave the Hub (mentions, embeds, Drive
 * videos) is removed at publish time by `toPublicDoc`, as for any doc.
 */
export async function docFromPage(
  deps: { db: Db; storage: Deps['storage'] },
  a: PortalActor,
  siteId: string,
  input: PortalDocFromPage,
): Promise<PortalDocFromPageResult> {
  const { db } = deps;
  requireEdit(a);
  const site = await loadSite(db, a, siteId);
  if (!site.locales.includes(input.locale)) throw new AppError('portal_locale_unsupported');
  const version = await versionByName(db, site, input.version);
  const { node, page } = await loadPage(db, a, input.nodeId);

  const json = docToJson(docFromState(page.ydoc)) as EditorDoc;
  const images = { copied: 0, skipped: 0 };
  const content = await portalBody(deps, a, site, json, images);

  return db.transaction(async (tx) => {
    const linked = await tx
      .select()
      .from(portalDocs)
      .where(
        and(
          eq(portalDocs.siteId, site.id),
          eq(portalDocs.versionId, version.id),
          eq(portalDocs.sourceNodeId, node.id),
          eq(portalDocs.kind, 'doc'),
          isNull(portalDocs.deletedAt),
        ),
      );
    const mine = linked.find((d) => d.locale === input.locale);
    if (mine) {
      const doc = await updateDoc(tx, a, mine.id, { title: node.name, content });
      return { doc, created: false, images };
    }
    // The page in another language already: this one becomes its translation.
    const source =
      linked.find((d) => d.locale === site.defaultLocale) ??
      linked.find((d) => d.locale !== input.locale);
    const doc = await createDoc(tx, a, site.id, {
      kind: 'doc',
      version: version.name,
      locale: input.locale,
      title: node.name,
      content,
      sourceNodeId: node.id,
      ...(source
        ? { translationOf: source.id }
        : {
            parentGroupId: input.parentGroupId ?? null,
            ...(input.slug ? { slug: input.slug } : {}),
          }),
    });
    return { doc, created: true, images };
  });
}

/** A link inside the Hub (`/p/…`, `/pages/…`) means nothing on the public site. */
const hubLink = (m: JSONMark) =>
  m.type === 'link' &&
  typeof m.attrs?.href === 'string' &&
  m.attrs.href.startsWith('/') &&
  !m.attrs.href.startsWith('//');

const DRIVE_SRC = /^node:([0-9a-f-]{36})$/i;

async function portalBody(
  deps: Pick<Deps, 'db' | 'storage'>,
  a: PortalActor,
  site: SiteRow,
  doc: EditorDoc,
  images: { copied: number; skipped: number },
): Promise<EditorDoc> {
  const copied = new Map<string, string | null>();
  const walk = async (n: JSONNode): Promise<JSONNode | null> => {
    if (n.type === 'image') {
      const m = DRIVE_SRC.exec(String(n.attrs?.src ?? ''));
      if (!m) return n;
      const id = m[1]!.toLowerCase();
      if (!copied.has(id)) copied.set(id, await copyImage(deps, a, site, id));
      const path = copied.get(id);
      if (!path) {
        images.skipped += 1;
        return null;
      }
      images.copied += 1;
      return { ...n, attrs: { ...n.attrs, src: path } };
    }
    let next: JSONNode = n;
    if (n.marks?.some(hubLink)) {
      const marks = n.marks.filter((mk) => !hubLink(mk));
      next = { ...n };
      if (marks.length) next.marks = marks;
      else delete next.marks;
    }
    if (!n.content) return next;
    const content: JSONNode[] = [];
    for (const c of n.content) {
      const out = await walk(c);
      if (out) content.push(out);
    }
    if (!content.length && n.content.length) {
      // A paragraph left with only a removed image is empty; any other block keeps a paragraph.
      if (n.type === 'paragraph') {
        const empty = { ...next };
        delete empty.content;
        return empty;
      }
      content.push({ type: 'paragraph' });
    }
    return { ...next, content };
  };
  const content: JSONNode[] = [];
  for (const c of doc.content ?? []) {
    const out = await walk(c);
    if (out) content.push(out);
  }
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

const safeSegment = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'image';

async function readAll(storage: Storage, key: string, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of await storage.getStream(key)) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += b.length;
    if (size > limit) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/**
 * Copies a Drive image the person can see into the site's media under a path of its own, so the
 * same image sent again is reused. Null when it cannot be read (no access, not an image, too big).
 */
async function copyImage(
  deps: Pick<Deps, 'db' | 'storage'>,
  a: PortalActor,
  site: SiteRow,
  nodeId: string,
): Promise<string | null> {
  const { db, storage } = deps;
  if (!storage) return null;
  let node;
  try {
    ({ node } = await loadNode(db, a, nodeId));
  } catch {
    return null;
  }
  if (node.type !== 'file' || !node.currentVersionId) return null;
  const [row] = await db
    .select({ blob: blobs, mime: nodeVersions.mime })
    .from(nodeVersions)
    .innerJoin(blobs, eq(blobs.id, nodeVersions.blobId))
    .where(and(eq(nodeVersions.id, node.currentVersionId), eq(nodeVersions.nodeId, node.id)));
  const mime = row?.mime ?? row?.blob.mime ?? null;
  if (!row || row.blob.status === 'quarantined' || !mime?.startsWith('image/')) return null;
  if (row.blob.size > MAX_MEDIA_BYTES) return null;

  const path = `/media/pages/${node.id}/${safeSegment(node.name)}`;
  const [existing] = await db
    .select()
    .from(portalMedia)
    .where(and(eq(portalMedia.siteId, site.id), eq(portalMedia.path, path)));
  if (existing?.blobId) return path;
  const data = await readAll(storage, row.blob.storageKey, MAX_MEDIA_BYTES).catch(() => null);
  if (!data) return null;
  const media =
    existing ??
    (
      await db
        .insert(portalMedia)
        .values({
          orgId: site.orgId,
          siteId: site.id,
          path,
          fileName: node.name,
          mime,
          size: data.length,
          createdBy: a.userId,
        })
        .returning()
    )[0]!;
  await storeMediaBytes(db, storage, site, media, data, mime);
  return path;
}
