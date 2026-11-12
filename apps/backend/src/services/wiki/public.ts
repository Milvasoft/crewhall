import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { nodes, pages } from '@crewhall/db';
import type { PublicPage } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { fileDownload } from '../drive/files';
import { publicNodeOf } from '../drive/shares';
import { isModuleEnabled } from '../identity/modules';
import { docFromState, docToJson, walk } from './doc';

/**
 * A page opened from a public link (H15, design 19): the stored body, read-only. Files the body
 * shows as `node:<fileId>` get short-lived URLs when they are inside the shared subtree or in
 * the page's own space (imported images sit in an attachments folder next to the pages):
 * images always, other files and videos only when the link allows downloads.
 */

const NODE_SRC = /^node:([0-9a-f-]{36})$/i;

export async function publicPage(
  deps: Deps,
  token: string,
  q: { grant?: string | undefined; nodeId?: string | undefined },
): Promise<PublicPage> {
  const { node, root, allowDownload } = await publicNodeOf(deps, token, q);
  if (node.type !== 'page') throw new AppError('bad_request', { reason: 'not_a_page' });
  if (!(await isModuleEnabled(deps.db, node.orgId, 'wiki'))) throw new AppError('not_found');
  const [page] = await deps.db.select().from(pages).where(eq(pages.nodeId, node.id));
  if (!page) throw new AppError('not_found');
  const doc = docToJson(docFromState(page.ydoc));

  // node:<id> sources: images (always shown) and links (downloads).
  const images = new Set<string>();
  const links = new Set<string>();
  walk(doc, (n) => {
    const src = n.type === 'image' ? NODE_SRC.exec(String(n.attrs?.src ?? '')) : null;
    if (src) images.add(src[1]!.toLowerCase());
    // A video plays the whole file, so it counts as a download.
    const video = n.type === 'video' ? NODE_SRC.exec(String(n.attrs?.src ?? '')) : null;
    if (video) links.add(video[1]!.toLowerCase());
    for (const m of n.marks ?? []) {
      const href = m.type === 'link' ? NODE_SRC.exec(String(m.attrs?.href ?? '')) : null;
      if (href) links.add(href[1]!.toLowerCase());
    }
  });
  const coverId = page.cover ? NODE_SRC.exec(page.cover)?.[1]?.toLowerCase() : undefined;
  if (coverId) images.add(coverId);
  const wanted = [...images, ...(allowDownload ? links : [])];

  const files: Record<string, string> = {};
  if (wanted.length) {
    const rows = await deps.db
      .select()
      .from(nodes)
      .where(
        and(
          inArray(nodes.id, wanted),
          eq(nodes.orgId, node.orgId),
          eq(nodes.type, 'file'),
          isNull(nodes.deletedAt),
          or(eq(nodes.spaceId, node.spaceId), sql`${nodes.path} <@ ${root.path}::ltree`),
        ),
      );
    for (const row of rows) {
      try {
        files[row.id] = (await fileDownload(deps, row, undefined, 'inline')).url;
      } catch {
        // A quarantined or missing blob is simply not shown.
      }
    }
  }

  let cover = page.cover;
  if (coverId) cover = files[coverId] ?? null;
  return {
    id: node.id,
    name: node.name,
    icon: page.icon,
    cover,
    fullWidth: page.fullWidth,
    smallText: page.smallText,
    doc,
    files,
    updatedAt: (page.editedAt ?? node.updatedAt).toISOString(),
  };
}
