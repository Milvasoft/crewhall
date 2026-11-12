import { pagePath } from '@crewhall/shared';
import { z } from 'zod';
import { canEditBody, loadPage } from '../../wiki/access';
import { editPage } from '../../wiki/live';
import { markdownToDoc } from '../../wiki/markdown';
import { createPage as createWikiPage } from '../../wiki/pages';
import { nodeRev } from './drive';
import { defineTool, ToolError } from './types';

/**
 * Wiki pages (design 18.11, scope pages:write): a new page from Markdown, or Markdown added at
 * the end of a page. Both run as the person with the wiki's own checks (editor role, a page that
 * is not locked) and reach open editors live through the collab server.
 */

const Markdown = z.string().min(1).max(100_000).describe('Markdown');

export const createPage = defineTool({
  name: 'create_page',
  title: 'Create page',
  description:
    'Creates a wiki page from Markdown in a space (at the root, or under parent_id). Needs the editor role in the space.',
  scope: 'pages:write',
  module: 'wiki',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: false },
  input: z.object({
    space_id: z.uuid(),
    parent_id: z.uuid().nullable().optional(),
    title: z.string().trim().min(1).max(200),
    markdown: Markdown.optional(),
  }),
  example: {
    space_id: '0192f1c4-0000-7000-8000-000000000000',
    title: 'Sürüm notları',
    markdown: '# Sürüm 2.4\n\n- Yeni takvim',
  },
  async run(ctx, input) {
    ctx.assertSpace(input.space_id);
    const page = await createWikiPage(
      ctx.deps,
      ctx.a,
      input.space_id,
      { parentId: input.parent_id ?? null, name: input.title, markdown: input.markdown },
      { source: 'mcp', locale: 'tr' },
    );
    return {
      data: { node_id: page.id, title: page.name, space_id: page.spaceId, url: pagePath(page) },
      target: { type: 'node', id: page.id, label: page.name },
      summary: page.name,
      undo: { kind: 'trash_nodes', nodeIds: [page.id], revs: { [page.id]: page.updatedAt } },
    };
  },
});

export const appendToPage = defineTool({
  name: 'append_to_page',
  title: 'Add to page',
  description:
    'Adds Markdown at the end of a wiki page the person may edit (meeting notes, a log, a list). Open editors see it at once.',
  scope: 'pages:write',
  module: 'wiki',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: false },
  input: z.object({ node_id: z.uuid(), markdown: Markdown }),
  example: { node_id: '0192f1c4-0000-7000-8000-000000000000', markdown: '- Sürüm cuma çıkıyor.' },
  async run(ctx, input) {
    const access = await loadPage(ctx.deps.db, ctx.a, input.node_id).catch(() => null);
    if (!access) throw new ToolError('not_found', 'Sayfa bulunamadı.');
    ctx.assertSpace(access.node.spaceId);
    if (!canEditBody(ctx.a, access)) {
      throw new ToolError('forbidden', 'Bu sayfayı düzenleme yetkin yok ya da sayfa kilitli.');
    }
    await editPage(ctx.deps, input.node_id, {
      op: 'append',
      doc: markdownToDoc(input.markdown),
      userId: ctx.a.userId,
      source: 'mcp',
    });
    return {
      data: { node_id: access.node.id, url: pagePath(access.node), rev: nodeRev(access.node) },
      target: { type: 'node', id: access.node.id, label: access.node.name },
      summary: access.node.name,
    };
  },
});
