import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { portalAuthors, portalPosts, users, type DbOrTx } from '@crewhall/db';
import {
  codeBlockCount,
  emptyDoc,
  markdownToDoc,
  readingMinutes,
  wordCount,
  type EditorDoc,
} from '@crewhall/editor';
import type {
  CreatePortalPost,
  PortalAuthor,
  PortalPost,
  PortalPostStatus,
  PortalPostSummary,
  PortalRichDoc,
  PortalSeo,
  UpdatePortalPost,
  UpsertPortalAuthor,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import {
  iso,
  loadSite,
  requireEdit,
  requireView,
  userSummaries,
  type PortalActor,
  type SiteRow,
} from './access';
import { createNode, ensureFolder, renameNode, restoreNode, trashNode } from './nodes';
import { slugSegment } from './urls';

export type PostRow = typeof portalPosts.$inferSelect;
type AuthorRow = typeof portalAuthors.$inferSelect;

export function postStatus(
  r: Pick<PostRow, 'deletedAt' | 'publishedRev' | 'rev' | 'visibleAt'>,
  now = Date.now(),
): PortalPostStatus {
  if (r.deletedAt) return 'removed';
  if (r.publishedRev === 0) return 'draft';
  if (r.rev > r.publishedRev) return 'changed';
  if (r.visibleAt && r.visibleAt.getTime() > now) return 'scheduled';
  return 'published';
}

// --- authors -----------------------------------------------------------------

async function toAuthors(db: DbOrTx, rows: AuthorRow[]): Promise<PortalAuthor[]> {
  const people = await userSummaries(
    db,
    rows.map((r) => r.userId),
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    title: r.title,
    url: r.url,
    imageUrl: r.imageUrl,
    user: r.userId ? (people.get(r.userId) ?? null) : null,
  }));
}

export async function listAuthors(db: DbOrTx, a: PortalActor, siteId: string) {
  requireView(a);
  const site = await loadSite(db, a, siteId);
  const rows = await db
    .select()
    .from(portalAuthors)
    .where(eq(portalAuthors.siteId, site.id))
    .orderBy(asc(portalAuthors.name));
  return { items: await toAuthors(db, rows) };
}

async function assertUserInOrg(db: DbOrTx, userId: string | null | undefined) {
  if (!userId) return;
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!u) throw new AppError('invalid_target', { userId });
}

export async function createAuthor(
  db: DbOrTx,
  a: PortalActor,
  siteId: string,
  input: UpsertPortalAuthor,
) {
  requireEdit(a);
  const site = await loadSite(db, a, siteId);
  await assertUserInOrg(db, input.userId);
  const [clash] = await db
    .select({ id: portalAuthors.id })
    .from(portalAuthors)
    .where(and(eq(portalAuthors.siteId, site.id), eq(portalAuthors.key, input.key)));
  if (clash) throw new AppError('conflict', { key: input.key });
  const [row] = await db
    .insert(portalAuthors)
    .values({
      orgId: site.orgId,
      siteId: site.id,
      key: input.key,
      name: input.name,
      title: input.title ?? null,
      url: input.url ?? null,
      imageUrl: input.imageUrl ?? null,
      userId: input.userId ?? null,
    })
    .returning();
  return (await toAuthors(db, [row!]))[0]!;
}

export async function updateAuthor(
  db: DbOrTx,
  a: PortalActor,
  authorId: string,
  input: Partial<UpsertPortalAuthor>,
) {
  requireEdit(a);
  const [row] = await db
    .select()
    .from(portalAuthors)
    .where(and(eq(portalAuthors.id, authorId), eq(portalAuthors.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  await assertUserInOrg(db, input.userId);
  if (input.key && input.key !== row.key) {
    const [clash] = await db
      .select({ id: portalAuthors.id })
      .from(portalAuthors)
      .where(and(eq(portalAuthors.siteId, row.siteId), eq(portalAuthors.key, input.key)));
    if (clash) throw new AppError('conflict', { key: input.key });
  }
  const [updated] = await db
    .update(portalAuthors)
    .set({
      key: input.key ?? row.key,
      name: input.name ?? row.name,
      title: input.title === undefined ? row.title : input.title,
      url: input.url === undefined ? row.url : input.url,
      imageUrl: input.imageUrl === undefined ? row.imageUrl : input.imageUrl,
      userId: input.userId === undefined ? row.userId : input.userId,
    })
    .where(eq(portalAuthors.id, row.id))
    .returning();
  return (await toAuthors(db, [updated!]))[0]!;
}

async function authorsById(db: DbOrTx, siteId: string) {
  const rows = await db.select().from(portalAuthors).where(eq(portalAuthors.siteId, siteId));
  const list = await toAuthors(db, rows);
  return new Map(list.map((x) => [x.id, x]));
}

async function assertAuthors(db: DbOrTx, siteId: string, ids: string[] | undefined) {
  if (!ids?.length) return;
  const rows = await db
    .select({ id: portalAuthors.id })
    .from(portalAuthors)
    .where(and(eq(portalAuthors.siteId, siteId), inArray(portalAuthors.id, ids)));
  if (rows.length !== new Set(ids).size) throw new AppError('invalid_target', { authorIds: ids });
}

// --- posts -------------------------------------------------------------------

async function loadPost(db: DbOrTx, a: PortalActor, postId: string) {
  const [row] = await db
    .select()
    .from(portalPosts)
    .where(and(eq(portalPosts.id, postId), eq(portalPosts.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  const site = await loadSite(db, a, row.siteId);
  return { row, site };
}

function summary(
  row: PostRow,
  authors: Map<string, PortalAuthor>,
  siblings: PostRow[],
  site: SiteRow,
): PortalPostSummary {
  return {
    id: row.id,
    groupId: row.groupId,
    locale: row.locale,
    slug: row.slug,
    title: row.title,
    status: postStatus(row),
    authors: row.authorIds.map((id) => authors.get(id)).filter((x): x is PortalAuthor => !!x),
    tags: row.tags,
    date: iso(row.date),
    scheduledAt: iso(row.scheduledAt),
    readingMinutes: readingMinutes(row.content as EditorDoc),
    translations: site.locales.map((locale) => {
      const t = siblings.find((s) => s.locale === locale && !s.deletedAt);
      return { locale, postId: t?.id ?? null, status: t ? postStatus(t) : null };
    }),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function toPost(db: DbOrTx, site: SiteRow, row: PostRow): Promise<PortalPost> {
  const [authors, siblings, people] = await Promise.all([
    authorsById(db, site.id),
    db
      .select()
      .from(portalPosts)
      .where(and(eq(portalPosts.siteId, site.id), eq(portalPosts.groupId, row.groupId))),
    userSummaries(db, [row.updatedBy, row.publishedBy]),
  ]);
  return {
    ...summary(row, authors, siblings, site),
    siteId: site.id,
    nodeId: row.nodeId ?? row.id,
    description: row.description,
    cover: row.cover,
    frontMatter: row.frontMatter,
    seo: row.seo as PortalSeo,
    content: row.content as PortalRichDoc,
    rev: row.rev,
    wordCount: row.wordCount,
    codeBlockCount: row.codeBlocks,
    published:
      row.publishedRev > 0 && row.publishedAt
        ? {
            rev: row.publishedRev,
            slug: row.pubSlug ?? row.slug,
            at: row.publishedAt.toISOString(),
            by: row.publishedBy ? (people.get(row.publishedBy) ?? null) : null,
          }
        : null,
    updatedBy: row.updatedBy ? (people.get(row.updatedBy) ?? null) : null,
  };
}

export async function listPosts(
  db: DbOrTx,
  a: PortalActor,
  siteId: string,
  query: { status: 'all' | 'published' | 'scheduled' | 'draft'; locale?: string | undefined },
) {
  requireView(a);
  const site = await loadSite(db, a, siteId);
  const rows = await db
    .select()
    .from(portalPosts)
    .where(
      and(
        eq(portalPosts.siteId, site.id),
        sql`(${portalPosts.deletedAt} is null or ${portalPosts.publishedRev} > 0)`,
      ),
    )
    .orderBy(
      desc(
        sql`coalesce(${portalPosts.scheduledAt}, ${portalPosts.date}, ${portalPosts.createdAt})`,
      ),
    );
  const authors = await authorsById(db, site.id);
  const locale = query.locale ?? site.defaultLocale;
  // One line per post: the requested locale's row, else the default locale's, else any.
  const groups = new Map<string, PostRow[]>();
  for (const r of rows) groups.set(r.groupId, [...(groups.get(r.groupId) ?? []), r]);
  const items: PortalPostSummary[] = [];
  for (const siblings of groups.values()) {
    const row =
      siblings.find((s) => s.locale === locale) ??
      siblings.find((s) => s.locale === site.defaultLocale) ??
      siblings[0]!;
    const s = summary(row, authors, siblings, site);
    const keep =
      query.status === 'all' ||
      (query.status === 'published' && (s.status === 'published' || s.status === 'changed')) ||
      (query.status === 'scheduled' &&
        (s.status === 'scheduled' ||
          (row.scheduledAt !== null && row.scheduledAt.getTime() > Date.now()))) ||
      (query.status === 'draft' && s.status === 'draft');
    if (keep) items.push(s);
  }
  return { items };
}

export async function getPost(db: DbOrTx, a: PortalActor, postId: string) {
  requireView(a);
  const { row, site } = await loadPost(db, a, postId);
  return toPost(db, site, row);
}

async function blogFolder(db: DbOrTx, site: SiteRow, locale: string, userId: string) {
  const blog = await ensureFolder(db, {
    orgId: site.orgId,
    spaceId: site.contentSpaceId,
    parentId: site.rootNodeId,
    name: 'blog',
    userId,
  });
  return ensureFolder(db, {
    orgId: site.orgId,
    spaceId: site.contentSpaceId,
    parentId: blog,
    name: locale,
    userId,
  });
}

async function assertPostSlugFree(
  db: DbOrTx,
  siteId: string,
  locale: string,
  slug: string,
  groupId?: string,
) {
  const [clash] = await db
    .select({ id: portalPosts.id })
    .from(portalPosts)
    .where(
      and(
        eq(portalPosts.siteId, siteId),
        eq(portalPosts.locale, locale),
        eq(portalPosts.slug, slug),
        isNull(portalPosts.deletedAt),
        groupId ? ne(portalPosts.groupId, groupId) : undefined,
      ),
    );
  if (clash) throw new AppError('portal_slug_taken', { slug });
}

function stats(content: EditorDoc) {
  return { wordCount: wordCount(content), codeBlocks: codeBlockCount(content) };
}

export async function createPost(
  db: DbOrTx,
  a: PortalActor,
  siteId: string,
  input: CreatePortalPost,
) {
  requireEdit(a);
  const site = await loadSite(db, a, siteId);
  if (!site.locales.includes(input.locale)) throw new AppError('portal_locale_unsupported');
  await assertAuthors(db, site.id, input.authorIds);

  let groupId: string = crypto.randomUUID();
  let base: PostRow | null = null;
  if (input.translationOf) {
    const [src] = await db
      .select()
      .from(portalPosts)
      .where(and(eq(portalPosts.id, input.translationOf), eq(portalPosts.siteId, site.id)));
    if (!src || src.deletedAt) throw new AppError('portal_translation_source_missing');
    const [existing] = await db
      .select({ id: portalPosts.id })
      .from(portalPosts)
      .where(
        and(
          eq(portalPosts.siteId, site.id),
          eq(portalPosts.groupId, src.groupId),
          eq(portalPosts.locale, input.locale),
        ),
      );
    if (existing) throw new AppError('conflict', { postId: existing.id });
    groupId = src.groupId;
    base = src;
  }
  const slug = base?.slug ?? input.slug ?? slugSegment(input.title);
  await assertPostSlugFree(db, site.id, input.locale, slug, groupId);
  const content = input.markdown !== undefined ? markdownToDoc(input.markdown).doc : emptyDoc();
  const nodeId = await createNode(db, {
    orgId: site.orgId,
    spaceId: site.contentSpaceId,
    parentId: await blogFolder(db, site, input.locale, a.userId),
    type: 'page',
    name: input.title,
    userId: a.userId,
  });
  const [row] = await db
    .insert(portalPosts)
    .values({
      orgId: site.orgId,
      siteId: site.id,
      locale: input.locale,
      groupId,
      nodeId,
      title: input.title,
      slug,
      description: base?.description ?? null,
      authorIds: input.authorIds ?? base?.authorIds ?? [],
      tags: input.tags ?? base?.tags ?? [],
      date: base?.date ?? null,
      scheduledAt: base?.scheduledAt ?? null,
      cover: base?.cover ?? null,
      content,
      ...stats(content),
      updatedBy: a.userId,
    })
    .returning();
  return toPost(db, site, row!);
}

export async function updatePost(
  db: DbOrTx,
  a: PortalActor,
  postId: string,
  input: UpdatePortalPost,
) {
  requireEdit(a);
  const { row, site } = await loadPost(db, a, postId);
  if (row.deletedAt) throw new AppError('conflict', { reason: 'removed' });
  if (input.baseRev !== undefined && input.baseRev !== row.rev) {
    throw new AppError('portal_doc_conflict', { rev: row.rev });
  }
  await assertAuthors(db, site.id, input.authorIds);
  const set: Partial<PostRow> = {};
  if (input.title !== undefined) set.title = input.title;
  if (input.description !== undefined) set.description = input.description;
  if (input.authorIds !== undefined) set.authorIds = input.authorIds;
  if (input.tags !== undefined) set.tags = [...new Set(input.tags)];
  if (input.date !== undefined) set.date = input.date ? new Date(input.date) : null;
  if (input.scheduledAt !== undefined)
    set.scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
  if (input.cover !== undefined) set.cover = input.cover;
  if (input.frontMatter !== undefined) set.frontMatter = input.frontMatter;
  if (input.seo !== undefined) set.seo = input.seo;
  const content =
    input.markdown !== undefined
      ? markdownToDoc(input.markdown).doc
      : (input.content as EditorDoc | undefined);
  if (content) Object.assign(set, { content }, stats(content));
  // Slugs are shared by the translations of a post (one URL per locale prefix).
  if (input.slug !== undefined && input.slug !== row.slug) {
    for (const locale of site.locales)
      await assertPostSlugFree(db, site.id, locale, input.slug, row.groupId);
    await db
      .update(portalPosts)
      .set({ slug: input.slug, rev: sql`${portalPosts.rev} + 1`, updatedBy: a.userId })
      .where(
        and(
          eq(portalPosts.groupId, row.groupId),
          ne(portalPosts.id, row.id),
          isNull(portalPosts.deletedAt),
        ),
      );
    set.slug = input.slug;
  }
  const [updated] = await db
    .update(portalPosts)
    .set({ ...set, rev: sql`${portalPosts.rev} + 1`, updatedBy: a.userId })
    .where(eq(portalPosts.id, row.id))
    .returning();
  if (set.title && set.title !== row.title) await renameNode(db, row.nodeId, set.title, a.userId);
  return toPost(db, site, updated!);
}

export async function deletePost(db: DbOrTx, a: PortalActor, postId: string, req: RequestInfo) {
  requireEdit(a);
  const { row, site } = await loadPost(db, a, postId);
  if (row.deletedAt) return {};
  await trashNode(db, row.nodeId, a.userId);
  if (row.publishedRev === 0) await db.delete(portalPosts).where(eq(portalPosts.id, row.id));
  else {
    await db
      .update(portalPosts)
      .set({ deletedAt: new Date(), deletedBy: a.userId })
      .where(eq(portalPosts.id, row.id));
  }
  await audit(
    db,
    {
      orgId: site.orgId,
      actorId: a.userId,
      action: 'portal.post.delete',
      targetType: 'portal_post',
      targetId: row.id,
      meta: { title: row.title, locale: row.locale },
    },
    req,
  );
  return {};
}

export async function restorePost(db: DbOrTx, a: PortalActor, postId: string) {
  requireEdit(a);
  const { row, site } = await loadPost(db, a, postId);
  if (!row.deletedAt) return toPost(db, site, row);
  await assertPostSlugFree(db, site.id, row.locale, row.slug, row.groupId);
  const [restored] = await db
    .update(portalPosts)
    .set({ deletedAt: null, deletedBy: null })
    .where(eq(portalPosts.id, row.id))
    .returning();
  await restoreNode(db, row.nodeId);
  return toPost(db, site, restored!);
}
