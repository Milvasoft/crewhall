import { and, asc, eq, inArray, isNull, max, ne, sql } from 'drizzle-orm';
import { portalDocs, portalVersions, type DbOrTx } from '@crewhall/db';
import {
  docToMarkdown,
  emptyDoc,
  markdownToDoc,
  wordCount,
  type EditorDoc,
} from '@crewhall/editor';
import type {
  CreatePortalDoc,
  PortalDoc,
  PortalItemStatus,
  PortalRichDoc,
  PortalSeo,
  PortalTranslationState,
  PortalTreeItem,
  UpdatePortalDoc,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import {
  loadSite,
  requireEdit,
  requireView,
  userSummaries,
  type PortalActor,
  type SiteRow,
} from './access';
import { createNode, ensureFolder, moveNode, renameNode, restoreNode, trashNode } from './nodes';
import { joinSlug, slugSegment } from './urls';

export type DocRow = typeof portalDocs.$inferSelect;
export type VersionRow = typeof portalVersions.$inferSelect;

export function docStatus(r: Pick<DocRow, 'deletedAt' | 'publishedRev' | 'rev'>): PortalItemStatus {
  if (r.deletedAt) return 'removed';
  if (r.publishedRev === 0) return 'draft';
  return r.rev > r.publishedRev ? 'changed' : 'published';
}

export function translationState(
  row: Pick<DocRow, 'locale' | 'sourceRev'>,
  source: Pick<DocRow, 'rev'> | null | undefined,
  defaultLocale: string,
): PortalTranslationState {
  if (row.locale === defaultLocale || !source) return 'source';
  return (row.sourceRev ?? 0) < source.rev ? 'outdated' : 'current';
}

export async function versionByName(db: DbOrTx, site: SiteRow, name: string) {
  const [v] = await db
    .select()
    .from(portalVersions)
    .where(and(eq(portalVersions.siteId, site.id), eq(portalVersions.name, name)));
  if (!v) throw new AppError('not_found', { version: name });
  return v;
}

async function versionById(db: DbOrTx, id: string) {
  const [v] = await db.select().from(portalVersions).where(eq(portalVersions.id, id));
  if (!v) throw new AppError('not_found');
  return v;
}

export async function loadDoc(db: DbOrTx, a: PortalActor, docId: string) {
  const [row] = await db
    .select()
    .from(portalDocs)
    .where(and(eq(portalDocs.id, docId), eq(portalDocs.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  const site = await loadSite(db, a, row.siteId);
  const version = await versionById(db, row.versionId);
  return { row, site, version };
}

const groupRows = (db: DbOrTx, versionId: string, groupId: string) =>
  db
    .select()
    .from(portalDocs)
    .where(and(eq(portalDocs.versionId, versionId), eq(portalDocs.groupId, groupId)));

async function sourceRow(db: DbOrTx, site: SiteRow, row: DocRow) {
  if (row.locale === site.defaultLocale) return null;
  const [src] = await db
    .select()
    .from(portalDocs)
    .where(
      and(
        eq(portalDocs.versionId, row.versionId),
        eq(portalDocs.groupId, row.groupId),
        eq(portalDocs.locale, site.defaultLocale),
      ),
    );
  return src ?? null;
}

/** Category titles from the root to the parent (source locale; own locale when translated). */
async function categoryPath(db: DbOrTx, row: DocRow) {
  const rows = await db
    .select({
      groupId: portalDocs.groupId,
      parentGroupId: portalDocs.parentGroupId,
      title: portalDocs.title,
      locale: portalDocs.locale,
    })
    .from(portalDocs)
    .where(and(eq(portalDocs.versionId, row.versionId), eq(portalDocs.kind, 'category')));
  const byGroup = new Map<string, { parentGroupId: string | null; title: string }>();
  for (const r of rows) {
    if (!byGroup.has(r.groupId) || r.locale === row.locale) byGroup.set(r.groupId, r);
  }
  const path: { groupId: string; title: string }[] = [];
  let g = row.parentGroupId;
  for (let i = 0; g && i < 50; i++) {
    const c = byGroup.get(g);
    if (!c) break;
    path.unshift({ groupId: g, title: c.title });
    g = c.parentGroupId;
  }
  return path;
}

export async function toDoc(
  db: DbOrTx,
  site: SiteRow,
  version: VersionRow,
  row: DocRow,
): Promise<PortalDoc> {
  const siblings = await groupRows(db, row.versionId, row.groupId);
  const source = siblings.find((s) => s.locale === site.defaultLocale && s.id !== row.id) ?? null;
  const people = await userSummaries(db, [row.updatedBy, row.publishedBy]);
  return {
    id: row.id,
    siteId: row.siteId,
    groupId: row.groupId,
    kind: row.kind,
    version: version.name,
    versionStatus: version.status,
    locale: row.locale,
    nodeId: row.nodeId ?? row.id,
    parentGroupId: row.parentGroupId,
    title: row.title,
    slug: row.slug,
    description: row.description,
    sidebarLabel: row.sidebarLabel,
    position: row.position,
    unlisted: row.unlisted,
    categoryLink: row.categoryLink,
    categorySlug: row.categorySlug,
    frontMatter: row.frontMatter,
    seo: row.seo as PortalSeo,
    content: row.content as PortalRichDoc,
    rev: row.rev,
    status: docStatus(row),
    published:
      row.publishedRev > 0 && row.publishedAt
        ? {
            rev: row.publishedRev,
            slug: row.pubSlug ?? row.slug,
            at: row.publishedAt.toISOString(),
            by: row.publishedBy ? (people.get(row.publishedBy) ?? null) : null,
          }
        : null,
    translation: translationState(row, source, site.defaultLocale),
    source: source
      ? { id: source.id, rev: source.rev, updatedAt: source.updatedAt.toISOString() }
      : null,
    translations: site.locales.map((locale) => {
      const t = siblings.find((s) => s.locale === locale);
      const src = siblings.find((s) => s.locale === site.defaultLocale);
      return {
        locale,
        docId: t?.id ?? null,
        state: t ? translationState(t, src, site.defaultLocale) : 'missing',
        status: t ? docStatus(t) : null,
      };
    }),
    path: await categoryPath(db, row),
    wordCount: row.wordCount,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy ? (people.get(row.updatedBy) ?? null) : null,
    sourceNodeId: row.sourceNodeId,
  };
}

export async function getDoc(db: DbOrTx, a: PortalActor, docId: string) {
  requireView(a);
  const { row, site, version } = await loadDoc(db, a, docId);
  return toDoc(db, site, version, row);
}

// --- tree ------------------------------------------------------------------

export async function docTree(
  db: DbOrTx,
  a: PortalActor,
  siteId: string,
  query: { version: string; locale: string },
): Promise<{ items: PortalTreeItem[] }> {
  requireView(a);
  const site = await loadSite(db, a, siteId);
  if (!site.locales.includes(query.locale)) throw new AppError('portal_locale_unsupported');
  const version = await versionByName(db, site, query.version);
  const rows = await db
    .select()
    .from(portalDocs)
    .where(
      and(
        eq(portalDocs.versionId, version.id),
        sql`(${portalDocs.deletedAt} is null or ${portalDocs.publishedRev} > 0)`,
      ),
    )
    .orderBy(asc(portalDocs.position), asc(portalDocs.title));
  const source = rows.filter((r) => r.locale === site.defaultLocale);
  const own = new Map(rows.filter((r) => r.locale === query.locale).map((r) => [r.groupId, r]));
  const items: PortalTreeItem[] = source.map((src) => {
    const t = query.locale === site.defaultLocale ? src : own.get(src.groupId);
    return {
      id: t?.id ?? null,
      groupId: src.groupId,
      sourceId: src.id,
      kind: src.kind,
      parentGroupId: src.parentGroupId,
      title: t?.title ?? src.title,
      sidebarLabel: t?.sidebarLabel ?? src.sidebarLabel,
      slug: src.slug,
      position: src.position,
      status: t ? docStatus(t) : null,
      translation: t ? translationState(t, src, site.defaultLocale) : 'missing',
      unlisted: src.unlisted,
      updatedAt: (t ?? src).updatedAt.toISOString(),
    };
  });
  // Docs that exist only in this locale (no source yet, design 10.13 "kaynak eksik").
  if (query.locale !== site.defaultLocale) {
    const known = new Set(source.map((s) => s.groupId));
    for (const r of own.values()) {
      if (known.has(r.groupId)) continue;
      items.push({
        id: r.id,
        groupId: r.groupId,
        sourceId: r.id,
        kind: r.kind,
        parentGroupId: r.parentGroupId,
        title: r.title,
        sidebarLabel: r.sidebarLabel,
        slug: r.slug,
        position: r.position,
        status: docStatus(r),
        translation: 'source',
        unlisted: r.unlisted,
        updatedAt: r.updatedAt.toISOString(),
      });
    }
  }
  return { items };
}

// --- nodes -----------------------------------------------------------------

async function localeFolder(
  db: DbOrTx,
  site: SiteRow,
  version: VersionRow,
  locale: string,
  userId: string,
) {
  let versionNode = version.nodeId;
  if (!versionNode) {
    versionNode = await ensureFolder(db, {
      orgId: site.orgId,
      spaceId: site.contentSpaceId,
      parentId: site.rootNodeId,
      name: version.name,
      userId,
    });
    await db
      .update(portalVersions)
      .set({ nodeId: versionNode })
      .where(eq(portalVersions.id, version.id));
  }
  return ensureFolder(db, {
    orgId: site.orgId,
    spaceId: site.contentSpaceId,
    parentId: versionNode,
    name: locale,
    userId,
  });
}

/**
 * Folder a doc of `locale` goes into: the node of its parent category in that locale, or a
 * folder mirroring the source category chain when the category is not translated.
 */
export async function parentFolder(
  db: DbOrTx,
  site: SiteRow,
  version: VersionRow,
  locale: string,
  parentGroupId: string | null,
  userId: string,
): Promise<string> {
  if (!parentGroupId) return localeFolder(db, site, version, locale, userId);
  const cats = await groupRows(db, version.id, parentGroupId);
  const own = cats.find((c) => c.locale === locale && !c.deletedAt);
  if (own?.nodeId) return own.nodeId;
  const src = cats.find((c) => c.locale === site.defaultLocale) ?? cats[0];
  if (!src) return localeFolder(db, site, version, locale, userId);
  const parent = await parentFolder(db, site, version, locale, src.parentGroupId, userId);
  return ensureFolder(db, {
    orgId: site.orgId,
    spaceId: site.contentSpaceId,
    parentId: parent,
    name: src.title,
    userId,
  });
}

// --- create ----------------------------------------------------------------

async function uniqueSlug(
  db: DbOrTx,
  versionId: string,
  locale: string,
  kind: 'doc' | 'category',
  wanted: string,
  exceptGroup?: string,
) {
  const taken = new Set(
    (
      await db
        .select({ slug: portalDocs.slug })
        .from(portalDocs)
        .where(
          and(
            eq(portalDocs.versionId, versionId),
            eq(portalDocs.locale, locale),
            eq(portalDocs.kind, kind),
            isNull(portalDocs.deletedAt),
            exceptGroup ? ne(portalDocs.groupId, exceptGroup) : undefined,
          ),
        )
    ).map((r) => r.slug),
  );
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; ; i++) if (!taken.has(`${wanted}-${i}`)) return `${wanted}-${i}`;
}

async function assertSlugFree(
  db: DbOrTx,
  versionId: string,
  locales: string[],
  kind: 'doc' | 'category',
  slug: string,
  groupId: string,
) {
  const [clash] = await db
    .select({ id: portalDocs.id })
    .from(portalDocs)
    .where(
      and(
        eq(portalDocs.versionId, versionId),
        inArray(portalDocs.locale, locales),
        eq(portalDocs.kind, kind),
        eq(portalDocs.slug, slug),
        isNull(portalDocs.deletedAt),
        ne(portalDocs.groupId, groupId),
      ),
    );
  if (clash) throw new AppError('portal_slug_taken', { slug });
}

async function categoryOf(db: DbOrTx, site: SiteRow, versionId: string, groupId: string) {
  const rows = await groupRows(db, versionId, groupId);
  const cat = rows.find((r) => r.locale === site.defaultLocale) ?? rows[0];
  if (!cat || cat.kind !== 'category' || cat.deletedAt) {
    throw new AppError('invalid_target', { parentGroupId: groupId });
  }
  return cat;
}

function contentFrom(input: {
  markdown?: string | undefined;
  content?: PortalRichDoc | undefined;
}) {
  if (input.markdown !== undefined) return markdownToDoc(input.markdown).doc;
  if (input.content) return input.content as EditorDoc;
  return null;
}

/** Server-side extras for a new doc: the body as a document, and the Hub page it came from. */
export interface DocExtras {
  content?: EditorDoc;
  sourceNodeId?: string;
}

export async function createDoc(
  db: DbOrTx,
  a: PortalActor,
  siteId: string,
  input: CreatePortalDoc & DocExtras,
): Promise<PortalDoc> {
  requireEdit(a);
  const site = await loadSite(db, a, siteId);
  if (!site.locales.includes(input.locale)) throw new AppError('portal_locale_unsupported');
  const version = await versionByName(db, site, input.version);

  if (input.translationOf) {
    const [src] = await db
      .select()
      .from(portalDocs)
      .where(and(eq(portalDocs.id, input.translationOf), eq(portalDocs.siteId, site.id)));
    if (!src || src.versionId !== version.id || src.deletedAt) {
      throw new AppError('portal_translation_source_missing');
    }
    const existing = (await groupRows(db, version.id, src.groupId)).find(
      (r) => r.locale === input.locale,
    );
    if (existing) throw new AppError('conflict', { docId: existing.id });
    const content =
      contentFrom(input) ?? (input.copySource ? (src.content as EditorDoc) : emptyDoc());
    const nodeId = await createNode(db, {
      orgId: site.orgId,
      spaceId: site.contentSpaceId,
      parentId: await parentFolder(db, site, version, input.locale, src.parentGroupId, a.userId),
      type: src.kind === 'category' ? 'folder' : 'page',
      name: input.title,
      userId: a.userId,
    });
    const [row] = await db
      .insert(portalDocs)
      .values({
        orgId: site.orgId,
        siteId: site.id,
        versionId: version.id,
        locale: input.locale,
        groupId: src.groupId,
        kind: src.kind,
        nodeId,
        parentGroupId: src.parentGroupId,
        title: input.title,
        slug: src.slug,
        description: src.description,
        sidebarLabel: null,
        position: src.position,
        unlisted: src.unlisted,
        categoryLink: src.categoryLink,
        categorySlug: src.categorySlug,
        frontMatter: src.frontMatter,
        content,
        wordCount: wordCount(content),
        sourceRev: src.rev,
        sourceNodeId: input.sourceNodeId ?? null,
        updatedBy: a.userId,
      })
      .returning();
    return toDoc(db, site, version, row!);
  }

  const kind = input.kind;
  const parentGroupId = input.parentGroupId ?? null;
  const parent = parentGroupId ? await categoryOf(db, site, version.id, parentGroupId) : null;
  const groupId = crypto.randomUUID();
  const slug = input.slug
    ? input.slug
    : await uniqueSlug(
        db,
        version.id,
        input.locale,
        kind,
        joinSlug(parent?.slug, slugSegment(input.title)),
      );
  await assertSlugFree(db, version.id, site.locales, kind, slug, groupId);
  const categorySlug =
    kind === 'category'
      ? await uniqueCategorySlug(db, version.id, `category/${slugSegment(input.title)}`)
      : null;
  let position = input.position;
  if (position === undefined) {
    const [last] = await db
      .select({ p: max(portalDocs.position) })
      .from(portalDocs)
      .where(
        and(
          eq(portalDocs.versionId, version.id),
          parentGroupId
            ? eq(portalDocs.parentGroupId, parentGroupId)
            : isNull(portalDocs.parentGroupId),
        ),
      );
    position = (last?.p ?? 0) + 10;
  }
  const content = contentFrom(input) ?? emptyDoc();
  const nodeId = await createNode(db, {
    orgId: site.orgId,
    spaceId: site.contentSpaceId,
    parentId: await parentFolder(db, site, version, input.locale, parentGroupId, a.userId),
    type: kind === 'category' ? 'folder' : 'page',
    name: input.title,
    userId: a.userId,
  });
  const [row] = await db
    .insert(portalDocs)
    .values({
      orgId: site.orgId,
      siteId: site.id,
      versionId: version.id,
      locale: input.locale,
      groupId,
      kind,
      nodeId,
      parentGroupId,
      title: input.title,
      slug,
      position,
      categoryLink: kind === 'category' ? 'generated-index' : 'none',
      categorySlug,
      content,
      wordCount: wordCount(content),
      sourceNodeId: input.sourceNodeId ?? null,
      updatedBy: a.userId,
    })
    .returning();
  return toDoc(db, site, version, row!);
}

async function uniqueCategorySlug(
  db: DbOrTx,
  versionId: string,
  wanted: string,
  exceptGroup?: string,
) {
  const taken = new Set(
    (
      await db
        .select({ s: portalDocs.categorySlug })
        .from(portalDocs)
        .where(
          and(
            eq(portalDocs.versionId, versionId),
            eq(portalDocs.kind, 'category'),
            isNull(portalDocs.deletedAt),
            exceptGroup ? ne(portalDocs.groupId, exceptGroup) : undefined,
          ),
        )
    ).map((r) => r.s),
  );
  if (!taken.has(wanted)) return wanted;
  for (let i = 2; ; i++) if (!taken.has(`${wanted}-${i}`)) return `${wanted}-${i}`;
}

// --- update ----------------------------------------------------------------

/** True when `candidate` is `groupId` or below it (no moving a category into itself). */
async function isWithin(db: DbOrTx, versionId: string, candidate: string, groupId: string) {
  const rows = await db
    .select({ groupId: portalDocs.groupId, parentGroupId: portalDocs.parentGroupId })
    .from(portalDocs)
    .where(eq(portalDocs.versionId, versionId));
  const parentOf = new Map(rows.map((r) => [r.groupId, r.parentGroupId]));
  let g: string | null | undefined = candidate;
  for (let i = 0; g && i < 100; i++) {
    if (g === groupId) return true;
    g = parentOf.get(g);
  }
  return false;
}

export async function updateDoc(
  db: DbOrTx,
  a: PortalActor,
  docId: string,
  input: UpdatePortalDoc,
): Promise<PortalDoc> {
  requireEdit(a);
  const { row, site, version } = await loadDoc(db, a, docId);
  if (row.deletedAt) throw new AppError('conflict', { reason: 'removed' });
  if (input.baseRev !== undefined && input.baseRev !== row.rev) {
    throw new AppError('portal_doc_conflict', { rev: row.rev });
  }

  // Structure (slug, parent, position, visibility, category link) is shared by all locales.
  const shared: Partial<DocRow> = {};
  if (input.slug !== undefined && input.slug !== row.slug) {
    await assertSlugFree(db, version.id, site.locales, row.kind, input.slug, row.groupId);
    shared.slug = input.slug;
  }
  if (input.parentGroupId !== undefined && input.parentGroupId !== row.parentGroupId) {
    if (input.parentGroupId) {
      await categoryOf(db, site, version.id, input.parentGroupId);
      if (await isWithin(db, version.id, input.parentGroupId, row.groupId)) {
        throw new AppError('invalid_target', { reason: 'cycle' });
      }
    }
    shared.parentGroupId = input.parentGroupId;
  }
  if (input.position !== undefined && input.position !== row.position)
    shared.position = input.position;
  if (input.unlisted !== undefined && input.unlisted !== row.unlisted)
    shared.unlisted = input.unlisted;
  if (input.categoryLink !== undefined && input.categoryLink !== row.categoryLink) {
    shared.categoryLink = input.categoryLink;
    if (input.categoryLink === 'generated-index' && !row.categorySlug) {
      shared.categorySlug = await uniqueCategorySlug(
        db,
        version.id,
        `category/${slugSegment(row.title)}`,
        row.groupId,
      );
    }
  }

  const content = contentFrom(input);
  const own: Partial<DocRow> = {};
  if (input.title !== undefined) own.title = input.title;
  if (input.description !== undefined) own.description = input.description;
  if (input.sidebarLabel !== undefined) own.sidebarLabel = input.sidebarLabel;
  if (input.frontMatter !== undefined) own.frontMatter = input.frontMatter;
  if (input.seo !== undefined) own.seo = input.seo;
  if (content) {
    own.content = content;
    own.wordCount = wordCount(content);
  }

  const [updated] = await db
    .update(portalDocs)
    .set({ ...own, ...shared, rev: sql`${portalDocs.rev} + 1`, updatedBy: a.userId })
    .where(eq(portalDocs.id, row.id))
    .returning();

  if (Object.keys(shared).length) {
    const others = (await groupRows(db, version.id, row.groupId)).filter((r) => r.id !== row.id);
    for (const other of others) {
      await db
        .update(portalDocs)
        .set({ ...shared, rev: sql`${portalDocs.rev} + 1`, updatedBy: a.userId })
        .where(eq(portalDocs.id, other.id));
    }
    if (shared.parentGroupId !== undefined) {
      for (const r of [updated!, ...others]) {
        const folder = await parentFolder(
          db,
          site,
          version,
          r.locale,
          shared.parentGroupId ?? null,
          a.userId,
        );
        await moveNode(db, r.nodeId, folder, a.userId);
      }
    }
  }
  if (own.title && own.title !== row.title) await renameNode(db, row.nodeId, own.title, a.userId);
  return toDoc(db, site, version, updated!);
}

// --- delete / restore -------------------------------------------------------

/**
 * Deleting a source doc removes its translations too; deleting a translation only that one.
 * Never-published rows go away now; published ones wait for the next publish (design 10.11).
 */
export async function deleteDoc(db: DbOrTx, a: PortalActor, docId: string, req: RequestInfo) {
  requireEdit(a);
  const { row, site, version } = await loadDoc(db, a, docId);
  if (row.deletedAt) return {};
  const targets =
    row.locale === site.defaultLocale
      ? (await groupRows(db, version.id, row.groupId)).filter((r) => !r.deletedAt)
      : [row];
  if (row.kind === 'category') {
    const [child] = await db
      .select({ id: portalDocs.id })
      .from(portalDocs)
      .where(
        and(
          eq(portalDocs.versionId, version.id),
          eq(portalDocs.parentGroupId, row.groupId),
          isNull(portalDocs.deletedAt),
          row.locale === site.defaultLocale ? undefined : eq(portalDocs.locale, row.locale),
        ),
      );
    if (child) throw new AppError('portal_category_not_empty');
  }
  for (const t of targets) {
    await trashNode(db, t.nodeId, a.userId);
    if (t.publishedRev === 0) {
      await db.delete(portalDocs).where(eq(portalDocs.id, t.id));
    } else {
      await db
        .update(portalDocs)
        .set({ deletedAt: new Date(), deletedBy: a.userId })
        .where(eq(portalDocs.id, t.id));
    }
  }
  await audit(
    db,
    {
      orgId: site.orgId,
      actorId: a.userId,
      action: 'portal.doc.delete',
      targetType: 'portal_doc',
      targetId: row.id,
      meta: { title: row.title, version: version.name, locale: row.locale, count: targets.length },
    },
    req,
  );
  return {};
}

export async function restoreDoc(db: DbOrTx, a: PortalActor, docId: string) {
  requireEdit(a);
  const { row, site, version } = await loadDoc(db, a, docId);
  if (!row.deletedAt) return toDoc(db, site, version, row);
  await assertSlugFree(db, version.id, [row.locale], row.kind, row.slug, row.groupId);
  const [restored] = await db
    .update(portalDocs)
    .set({ deletedAt: null, deletedBy: null })
    .where(eq(portalDocs.id, row.id))
    .returning();
  await restoreNode(db, row.nodeId);
  return toDoc(db, site, version, restored!);
}

// --- markdown and translations ---------------------------------------------

/** Docusaurus front matter for a doc (export, MCP). */
export function docFrontMatter(
  row: Pick<DocRow, 'title' | 'description' | 'sidebarLabel' | 'position' | 'frontMatter' | 'slug'>,
) {
  return {
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    ...(row.sidebarLabel ? { sidebar_label: row.sidebarLabel } : {}),
    sidebar_position: row.position,
    ...row.frontMatter,
  };
}

export async function docMarkdown(db: DbOrTx, a: PortalActor, docId: string) {
  requireView(a);
  const { row } = await loadDoc(db, a, docId);
  return {
    markdown: docToMarkdown(row.content as EditorDoc, {
      frontMatter: docFrontMatter(row),
      docusaurusImports: true,
    }),
  };
}

/** "Güncel olarak işaretle" (design 10.3): the translation catches up with its source. */
export async function markTranslationCurrent(db: DbOrTx, a: PortalActor, docId: string) {
  requireEdit(a);
  const { row, site, version } = await loadDoc(db, a, docId);
  const source = await sourceRow(db, site, row);
  if (!source) throw new AppError('portal_translation_source_missing');
  const [updated] = await db
    .update(portalDocs)
    .set({ sourceRev: source.rev, rev: sql`${portalDocs.rev} + 1`, updatedBy: a.userId })
    .where(eq(portalDocs.id, row.id))
    .returning();
  return toDoc(db, site, version, updated!);
}

/** "next'e de uygula" (design 10.2): copy this draft over the same doc in `next`. */
export async function applyToNext(db: DbOrTx, a: PortalActor, docId: string) {
  requireEdit(a);
  const { row, site, version } = await loadDoc(db, a, docId);
  if (version.status === 'next') throw new AppError('invalid_target', { reason: 'already_next' });
  const next = await versionByName(db, site, 'next');
  const [target] = await db
    .select()
    .from(portalDocs)
    .where(
      and(
        eq(portalDocs.versionId, next.id),
        eq(portalDocs.groupId, row.groupId),
        eq(portalDocs.locale, row.locale),
        isNull(portalDocs.deletedAt),
      ),
    );
  if (target) {
    const [updated] = await db
      .update(portalDocs)
      .set({
        title: row.title,
        description: row.description,
        sidebarLabel: row.sidebarLabel,
        frontMatter: row.frontMatter,
        seo: row.seo,
        content: row.content,
        wordCount: row.wordCount,
        sourceRev: row.sourceRev,
        rev: sql`${portalDocs.rev} + 1`,
        updatedBy: a.userId,
      })
      .where(eq(portalDocs.id, target.id))
      .returning();
    await renameNode(db, target.nodeId, row.title, a.userId);
    return toDoc(db, site, next, updated!);
  }
  // Not in next yet: create it there (under the same category when it exists in next).
  const parentInNext = row.parentGroupId
    ? (await groupRows(db, next.id, row.parentGroupId)).find((r) => !r.deletedAt)
    : null;
  const parentGroupId = parentInNext ? row.parentGroupId : null;
  await assertSlugFree(db, next.id, [row.locale], row.kind, row.slug, row.groupId);
  const nodeId = await createNode(db, {
    orgId: site.orgId,
    spaceId: site.contentSpaceId,
    parentId: await parentFolder(db, site, next, row.locale, parentGroupId, a.userId),
    type: row.kind === 'category' ? 'folder' : 'page',
    name: row.title,
    userId: a.userId,
  });
  const [created] = await db
    .insert(portalDocs)
    .values({
      orgId: site.orgId,
      siteId: site.id,
      versionId: next.id,
      locale: row.locale,
      groupId: row.groupId,
      kind: row.kind,
      nodeId,
      parentGroupId,
      title: row.title,
      slug: row.slug,
      description: row.description,
      sidebarLabel: row.sidebarLabel,
      position: row.position,
      unlisted: row.unlisted,
      categoryLink: row.categoryLink,
      categorySlug: row.categorySlug,
      frontMatter: row.frontMatter,
      seo: row.seo,
      content: row.content,
      wordCount: row.wordCount,
      sourceRev: row.sourceRev,
      updatedBy: a.userId,
    })
    .returning();
  return toDoc(db, site, next, created!);
}
