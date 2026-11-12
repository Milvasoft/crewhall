import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { portalDocs, portalSites, portalVersions, type DbOrTx } from '@crewhall/db';
import { PortalDocSlug, PortalLocale, PortalPostSlug } from '@crewhall/shared';
import { z } from 'zod';
import { capabilities, loadSite, type SiteRow } from '../../portal/access';
import { rawChanges } from '../../portal/changes';
import { createDoc, docTree, updateDoc, versionByName } from '../../portal/docs';
import { createPost } from '../../portal/posts';
import { previewPublish } from '../../portal/publish';
import { defineTool, ToolError, type ToolContext } from './types';

/**
 * Portal tools (doc 17 §13): Claude only ever writes drafts; publishing goes through the
 * approval queue every time, then the normal publish flow (§9) runs on the frozen keys.
 */

const SiteId = z.uuid().optional().describe('Portal site; omit for the first site of the org');

async function pickSite(ctx: ToolContext, siteId: string | undefined): Promise<SiteRow> {
  if (siteId) return loadSite(ctx.deps.db, ctx.a, siteId);
  const [site] = await ctx.deps.db
    .select()
    .from(portalSites)
    .where(eq(portalSites.orgId, ctx.a.org.id))
    .orderBy(asc(portalSites.createdAt))
    .limit(1);
  if (!site) throw new ToolError('not_found', 'Kurumda portal sitesi yok.');
  return site;
}

function requireEditor(ctx: ToolContext) {
  if (!capabilities(ctx.a).edit) {
    throw new ToolError('forbidden', 'Portalda taslak yazmak için portal.edit iznin olmalı.');
  }
}

/** The version to write into: the given name, else the current one, else the newest. */
async function versionOf(db: DbOrTx, site: SiteRow, name: string | undefined) {
  if (name) return versionByName(db, site, name);
  const [current] = await db
    .select()
    .from(portalVersions)
    .where(and(eq(portalVersions.siteId, site.id), eq(portalVersions.status, 'current')))
    .limit(1);
  if (current) return current;
  const [newest] = await db
    .select()
    .from(portalVersions)
    .where(eq(portalVersions.siteId, site.id))
    .orderBy(desc(portalVersions.createdAt))
    .limit(1);
  if (!newest) throw new ToolError('not_found', 'Sitede doküman sürümü yok.');
  return newest;
}

export const listPortalDocs = defineTool({
  name: 'list_portal_docs',
  title: 'List portal docs',
  description:
    'The documentation tree of a portal site for one version and language, with draft/published status and translation state.',
  scope: 'hub:read',
  module: 'portal',
  write: false,
  approval: null,
  annotations: { readOnly: true, destructive: false, idempotent: true },
  input: z.object({
    site_id: SiteId,
    version: z
      .string()
      .max(60)
      .optional()
      .describe('Version name, e.g. "1.0.1"; omit for the current one'),
    lang: PortalLocale.optional().describe('Language; omit for the site default'),
  }),
  example: { version: '1.0.1', lang: 'en' },
  async run(ctx, input) {
    const caps = capabilities(ctx.a);
    if (!caps.edit && !caps.publish && !caps.manage) {
      throw new ToolError('forbidden', 'Portalı görmek için portal.edit iznin olmalı.');
    }
    const site = await pickSite(ctx, input.site_id);
    const version = await versionOf(ctx.deps.db, site, input.version);
    const locale = input.lang ?? site.defaultLocale;
    const tree = await docTree(ctx.deps.db, ctx.a, site.id, { version: version.name, locale });
    const items = tree.items.map((d) => ({
      id: d.id,
      group_id: d.groupId,
      kind: d.kind,
      parent_group_id: d.parentGroupId,
      title: d.title,
      slug: d.slug,
      status: d.status,
      translation: d.translation,
    }));
    return {
      data: { site_id: site.id, version: version.name, lang: locale, locales: site.locales, items },
      summary: `${version.name} · ${locale} · ${items.length}`,
    };
  },
});

export const upsertPortalDoc = defineTool({
  name: 'upsert_portal_doc',
  title: 'Upsert portal doc',
  description:
    'Creates or updates a portal doc from Markdown. Always writes a draft, never publishes. The same version, language and slug a second time opens a new revision; another language of an existing slug becomes its translation.',
  scope: 'portal:draft',
  module: 'portal',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: true },
  input: z.object({
    site_id: SiteId,
    version: z.string().max(60).optional(),
    lang: PortalLocale,
    slug: PortalDocSlug,
    title: z.string().trim().min(1).max(200),
    markdown: z.string().max(200_000),
    parent_group_id: z
      .uuid()
      .nullable()
      .optional()
      .describe('Category group id from list_portal_docs'),
    source_node_id: z
      .uuid()
      .optional()
      .describe('Hub page the text came from (kept in the activity)'),
  }),
  example: {
    version: '1.0.1',
    lang: 'en',
    slug: 'milvaion/release-notes/1-5',
    title: 'Milvaion 1.5 Release Notes',
    markdown: '## Highlights\n- Workflow retries',
  },
  async run(ctx, input) {
    requireEditor(ctx);
    const { db } = ctx.deps;
    const site = await pickSite(ctx, input.site_id);
    const version = await versionOf(db, site, input.version);
    const sameSlug = await db
      .select()
      .from(portalDocs)
      .where(
        and(
          eq(portalDocs.versionId, version.id),
          eq(portalDocs.slug, input.slug),
          isNull(portalDocs.deletedAt),
        ),
      );
    const mine = sameSlug.find((d) => d.locale === input.lang);
    const label = `${version.name} · ${input.lang} · ${input.slug}`;
    if (mine) {
      const doc = await updateDoc(db, ctx.a, mine.id, {
        title: input.title,
        markdown: input.markdown,
      });
      return {
        data: { doc_id: doc.id, status: 'draft', rev: doc.rev, created: false },
        target: { type: 'portal_doc', id: doc.id, label },
        summary: label,
      };
    }
    const source =
      sameSlug.find((d) => d.locale === site.defaultLocale) ??
      sameSlug.find((d) => d.locale !== input.lang);
    const doc = await createDoc(db, ctx.a, site.id, {
      kind: 'doc',
      version: version.name,
      locale: input.lang,
      title: input.title,
      markdown: input.markdown,
      ...(source
        ? { translationOf: source.id }
        : { slug: input.slug, parentGroupId: input.parent_group_id ?? null }),
    });
    return {
      data: { doc_id: doc.id, status: 'draft', rev: doc.rev, created: true },
      target: { type: 'portal_doc', id: doc.id, label },
      summary: label,
      undo: { kind: 'delete_portal_doc', docId: doc.id, revs: { [doc.id]: String(doc.rev) } },
    };
  },
});

export const createBlogPost = defineTool({
  name: 'create_blog_post',
  title: 'Create blog post',
  description:
    'Writes a blog post draft from Markdown. It goes live only through request_portal_publish.',
  scope: 'portal:draft',
  module: 'portal',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: false },
  input: z.object({
    site_id: SiteId,
    lang: PortalLocale,
    title: z.string().trim().min(1).max(200),
    slug: PortalPostSlug.optional(),
    markdown: z.string().max(200_000),
    tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    translation_of: z.uuid().optional().describe('Post id this is the translation of'),
  }),
  example: { lang: 'en', title: 'Milvaion 1.5 is out', markdown: 'Milvaion 1.5 brings…' },
  async run(ctx, input) {
    requireEditor(ctx);
    const site = await pickSite(ctx, input.site_id);
    const post = await createPost(ctx.deps.db, ctx.a, site.id, {
      locale: input.lang,
      title: input.title,
      slug: input.slug,
      markdown: input.markdown,
      tags: input.tags,
      translationOf: input.translation_of,
    });
    return {
      data: { post_id: post.id, status: 'draft', slug: post.slug, rev: post.rev },
      target: { type: 'portal_post', id: post.id, label: `${input.lang} · ${post.slug}` },
      summary: `${input.lang} · ${post.title}`,
      undo: { kind: 'delete_portal_post', postId: post.id, revs: { [post.id]: String(post.rev) } },
    };
  },
});

export const requestPortalPublish = defineTool({
  name: 'request_portal_publish',
  title: 'Request portal publish',
  description:
    'Sends drafts to the person for approval to publish. Never publishes directly: the answer is {status: "pending_approval"}. After the approval the normal publish flow refreshes the affected pages. Omit keys to send the whole queue of unpublished changes.',
  scope: 'portal:publish',
  module: 'portal',
  write: true,
  approval: 'always',
  annotations: { readOnly: false, destructive: false, idempotent: true },
  input: z.object({
    site_id: SiteId,
    keys: z
      .array(z.string().max(120))
      .max(1000)
      .optional()
      .describe('Change keys like "doc:<id>", "post:<id>"; omit for every unpublished change'),
    doc_ids: z.array(z.uuid()).max(500).optional(),
    post_ids: z.array(z.uuid()).max(500).optional(),
    note: z.string().max(1000).optional().describe('Shown to the person as unverified text'),
  }),
  example: { doc_ids: ['0192f1c4-0000-7000-8000-000000000000'], note: 'Release notes 1.5' },
  async run(ctx, input) {
    if (!capabilities(ctx.a).publish) {
      throw new ToolError('forbidden', 'Portalda yayın isteği için portal.publish iznin olmalı.');
    }
    const site = await pickSite(ctx, input.site_id);
    const pending = await rawChanges(ctx.deps.db, site);
    const wanted = new Set([
      ...(input.keys ?? []),
      ...(input.doc_ids ?? []).map((id) => `doc:${id}`),
      ...(input.post_ids ?? []).map((id) => `post:${id}`),
    ]);
    const chosen = wanted.size ? pending.filter((c) => wanted.has(c.key)) : pending;
    const missing = [...wanted].filter((k) => !pending.some((c) => c.key === k));
    if (missing.length) {
      throw new ToolError('not_found', 'Bu öğelerde yayınlanmamış değişiklik yok.', {
        keys: missing,
      });
    }
    if (chosen.length === 0) throw new ToolError('conflict', 'Yayınlanacak değişiklik yok.');
    const keys = chosen.map((c) => c.key);
    const preview = await previewPublish(ctx.deps, ctx.a, site.id, { keys });
    return ctx.requestApproval({
      action: 'portal.publish',
      payload: { site_id: site.id, keys, note: input.note ?? null },
      title: preview.changes[0]?.title ?? site.name,
      target: site.name,
      items: [
        ...preview.changes.map((c) => ({
          kind: c.kind,
          label: c.title,
          detail: [c.version, c.locale, c.action].filter(Boolean).join(' · '),
          location: site.name,
        })),
        ...(preview.paths.length
          ? [
              {
                kind: 'paths',
                label: preview.paths.slice(0, 20).join(' · '),
                detail: String(preview.paths.length),
                location: null,
              },
            ]
          : []),
      ],
      // Any edit after the request makes it stale: the person approves what was frozen.
      targetRevs: Object.fromEntries(chosen.map((c) => [c.key, c.changedAt.toISOString()])),
      clientNote: input.note ?? null,
    });
  },
});
