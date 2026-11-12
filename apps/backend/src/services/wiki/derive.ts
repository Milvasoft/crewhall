import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  nodes,
  nodeUserState,
  pageComments,
  pageMentions,
  pageRefs,
  pages,
  type Db,
} from '@crewhall/db';
import {
  EMPTY_PAGE_TTL_MINUTES,
  can,
  pageIdFromRef,
  pagePath,
  type PageRefKind,
} from '@crewhall/shared';
import type { Logger } from '../../logger';
import type { Jobs } from '../../jobs/queue';
import { nodeResource, roleForPath, spaceRoleOf, userSharePaths } from '../drive/access';
import { actorFor } from './access';
import { docFromState, docToJson, plainText, walk, wordCount, type PMDoc } from './doc';
import { docToMarkdown } from './markdown';
import { sendPageNotice } from './notify';
import { createPageVersion, maybeAutoVersion, prunePageVersions } from './versions';

export interface WikiJobDeps {
  db: Db;
  logger: Logger;
  jobs: Jobs;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Links (`/p/…-<id>`, `crewhall://page/<id>`), embeds and node / person mentions in a body. */
export function collectRefs(doc: PMDoc) {
  const refs = new Map<string, Set<PageRefKind>>();
  const people = new Set<string>();
  const add = (id: string, kind: PageRefKind) => {
    const key = id.toLowerCase();
    if (!refs.has(key)) refs.set(key, new Set());
    refs.get(key)!.add(kind);
  };
  walk(doc, (n) => {
    // An embedded table is a row of the Tables module, not a node.
    if (
      n.type === 'embed' &&
      n.attrs?.nodeType !== 'table' &&
      typeof n.attrs?.nodeId === 'string' &&
      UUID.test(n.attrs.nodeId)
    ) {
      add(n.attrs.nodeId, 'embed');
    }
    if (n.type === 'mention' && typeof n.attrs?.id === 'string' && UUID.test(n.attrs.id)) {
      if (n.attrs.kind === 'user' || n.attrs.kind === undefined)
        people.add(n.attrs.id.toLowerCase());
      else if (n.attrs.kind === 'node') add(n.attrs.id, 'mention');
    }
    for (const m of n.marks ?? []) {
      if (m.type !== 'link' || typeof m.attrs?.href !== 'string') continue;
      const href = m.attrs.href;
      const internal =
        /^\/p\//.test(href) || /^crewhall:\/\/page\//.test(href) || /\/p\/[^/?#]+$/.test(href);
      const id = internal ? pageIdFromRef(href.split(/[?#]/)[0]!) : null;
      if (id) add(id, 'link');
    }
  });
  return { refs, people: [...people] };
}

/**
 * page.snapshot (doc 17 §6 step 6): from the stored Yjs state derive markdown, plain text,
 * word count, the search vector (title A, body B; turkish + english), page_refs and mention
 * notifications; touch nodes.updated_at when the body changed; keep the 10-minute version.
 */
export async function derivePage(deps: WikiJobDeps, nodeId: string, force = false) {
  const { db } = deps;
  const [row] = await db
    .select({ page: pages, node: nodes })
    .from(pages)
    .innerJoin(nodes, eq(nodes.id, pages.nodeId))
    .where(eq(pages.nodeId, nodeId));
  if (!row) return;
  const { page, node } = row;
  if (!force && page.derivedRev >= page.snapshotRev && page.search !== null) {
    await maybeAutoVersion(db, nodeId);
    return;
  }
  const json = docToJson(docFromState(page.ydoc));
  const markdown = docToMarkdown(json);
  const body = plainText(json);
  const words = wordCount(body);
  const changed = markdown !== page.markdown;

  await db
    .update(pages)
    .set({
      markdown,
      bodyText: body,
      wordCount: words,
      derivedRev: page.snapshotRev,
      search: sql`setweight(to_tsvector('turkish', ${node.name}), 'A')
        || setweight(to_tsvector('english', ${node.name}), 'A')
        || setweight(to_tsvector('turkish', ${body}), 'B')
        || setweight(to_tsvector('english', ${body}), 'B')`,
    })
    .where(and(eq(pages.nodeId, nodeId), eq(pages.snapshotRev, page.snapshotRev)));
  if (changed && page.editedAt) {
    await db.execute(
      sql`update ${nodes} set updated_at = now(), updated_by = ${page.editedBy} where id = ${nodeId}`,
    );
    await notifyFollowers(deps, node, page.editedBy);
  }

  const { refs, people } = collectRefs(json);
  refs.delete(nodeId);
  const targets = refs.size
    ? await db
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(inArray(nodes.id, [...refs.keys()]), eq(nodes.orgId, node.orgId)))
    : [];
  await db.transaction(async (tx) => {
    await tx.delete(pageRefs).where(eq(pageRefs.fromNodeId, nodeId));
    const values = targets.flatMap((t) =>
      [...refs.get(t.id)!].map((kind) => ({
        orgId: node.orgId,
        fromNodeId: nodeId,
        toNodeId: t.id,
        kind,
      })),
    );
    if (values.length) await tx.insert(pageRefs).values(values).onConflictDoNothing();
  });

  // A page created with a body has no editor yet: its creator wrote the mentions.
  if (people.length) await notifyMentions(deps, node, people, page.editedBy ?? node.createdBy);
  await maybeAutoVersion(db, nodeId);
}

async function notifyMentions(
  deps: WikiJobDeps,
  node: typeof nodes.$inferSelect,
  people: string[],
  actorId: string | null,
) {
  const fresh = await deps.db
    .insert(pageMentions)
    .values(
      people.map((userId) => ({
        nodeId: node.id,
        userId,
        orgId: node.orgId,
        mentionedBy: actorId,
      })),
    )
    .onConflictDoNothing()
    .returning({ userId: pageMentions.userId })
    .catch(() => []);
  const allowed: string[] = [];
  for (const { userId } of fresh) {
    if (await canView(deps.db, node, userId)) allowed.push(userId);
  }
  if (!allowed.length) return;
  await deps.db
    .update(pageMentions)
    .set({ notifiedAt: new Date() })
    .where(and(eq(pageMentions.nodeId, node.id), inArray(pageMentions.userId, allowed)));
  await sendPageNotice(
    {
      type: 'page.mention',
      orgId: node.orgId,
      spaceId: node.spaceId,
      nodeId: node.id,
      pageName: node.name,
      actorId,
      userIds: allowed,
      url: pagePath(node),
    },
    deps.logger,
  );
}

/** One save is a few words: followers hear about a page at most this often. */
export const FOLLOW_NOTICE_EVERY_MS = 60 * 60 * 1000;

/**
 * Tells the page's followers, and those who follow one of its ancestors with its sub-pages, that
 * it changed. Each person hears about one page at most once an hour: the stamp sits on the
 * person's row for the changed page (created for it when they follow an ancestor), so following
 * both a page and its parent still gives one notice.
 */
async function notifyFollowers(
  deps: WikiJobDeps,
  node: typeof nodes.$inferSelect,
  actorId: string | null,
) {
  if (node.deletedAt) return;
  const cutoff = new Date(Date.now() - FOLLOW_NOTICE_EVERY_MS);
  const due = or(
    isNull(nodeUserState.followNotifiedAt),
    lt(nodeUserState.followNotifiedAt, cutoff),
  );
  const ancestors = sql`(select ${nodes.id} from ${nodes} where ${nodes.path} @> ${node.path}::ltree and ${nodes.id} <> ${node.id} and ${nodes.deletedAt} is null)`;
  const followers = await deps.db
    .selectDistinct({ userId: nodeUserState.userId })
    .from(nodeUserState)
    .where(
      and(
        eq(nodeUserState.following, true),
        or(
          eq(nodeUserState.nodeId, node.id),
          and(eq(nodeUserState.followDescendants, true), inArray(nodeUserState.nodeId, ancestors)),
        ),
      ),
    );
  if (!followers.length) return;
  const recent = new Set(
    (
      await deps.db
        .select({ userId: nodeUserState.userId })
        .from(nodeUserState)
        .where(
          and(
            eq(nodeUserState.nodeId, node.id),
            inArray(
              nodeUserState.userId,
              followers.map((f) => f.userId),
            ),
            gte(nodeUserState.followNotifiedAt, cutoff),
          ),
        )
    ).map((r) => r.userId),
  );
  const allowed: string[] = [];
  for (const { userId } of followers) {
    if (userId === actorId || recent.has(userId)) continue;
    if (await canView(deps.db, node, userId)) allowed.push(userId);
  }
  if (!allowed.length) return;
  // Checked again in the write: two derives of one page must not both notify.
  const now = new Date();
  const claimed = await deps.db
    .insert(nodeUserState)
    .values(
      allowed.map((userId) => ({
        userId,
        nodeId: node.id,
        orgId: node.orgId,
        followNotifiedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [nodeUserState.userId, nodeUserState.nodeId],
      set: { followNotifiedAt: now },
      setWhere: due,
    })
    .returning({ userId: nodeUserState.userId });
  if (!claimed.length) return;
  await sendPageNotice(
    {
      type: 'page.updated',
      orgId: node.orgId,
      spaceId: node.spaceId,
      nodeId: node.id,
      pageName: node.name,
      actorId,
      userIds: claimed.map((c) => c.userId),
      url: pagePath(node),
    },
    deps.logger,
  );
}

/** Whether a person can see a node (mentions of people without access are not notified). */
export async function canView(db: Db, node: typeof nodes.$inferSelect, userId: string) {
  const actor = await actorFor(db, node.orgId, userId);
  if (!actor) return false;
  const role = roleForPath(
    await spaceRoleOf(db, node.spaceId, userId),
    await userSharePaths(db, node.spaceId, userId),
    node.path,
  );
  return can(actor.actor, 'space.view', nodeResource(actor, role));
}

/**
 * page.sweep (every 5 minutes): derive what a dropped job missed, close editing sessions
 * idle for 5 minutes with a version, remove untitled pages nobody wrote in (design 5.14),
 * and prune old versions once a day.
 */
export async function sweepPages(deps: WikiJobDeps) {
  const { db, logger } = deps;
  const stale = await db
    .select({ id: pages.nodeId })
    .from(pages)
    .where(sql`${pages.derivedRev} < ${pages.snapshotRev}`)
    .limit(200);
  for (const s of stale)
    await derivePage(deps, s.id).catch((err) => logger.warn({ err }, 'derive failed'));

  const idle = await db
    .select({ id: pages.nodeId, by: pages.editedBy, source: pages.lastSource })
    .from(pages)
    .where(
      and(
        sql`${pages.snapshotRev} > ${pages.versionedRev}`,
        lt(pages.editedAt, new Date(Date.now() - 5 * 60_000)),
      ),
    )
    .limit(200);
  for (const p of idle) {
    await createPageVersion(db, p.id, { userId: p.by, source: p.source ?? 'web' }).catch((err) =>
      logger.warn({ err }, 'session version failed'),
    );
  }

  await removeAbandonedPages(db, logger);
  if (new Date().getUTCHours() === 3 && new Date().getUTCMinutes() < 5) await prunePageVersions(db);
}

/** Untitled pages left without any content (design 5.14): deleted outright, not trashed. */
export async function removeAbandonedPages(db: Db, logger: Logger) {
  const cutoff = new Date(Date.now() - EMPTY_PAGE_TTL_MINUTES * 60_000);
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(pages, eq(pages.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.type, 'page'),
        isNull(nodes.deletedAt),
        lt(nodes.createdAt, cutoff),
        // Never renamed or moved after creation (the derive job does not touch empty pages).
        sql`${nodes.updatedAt} - ${nodes.createdAt} < interval '2 seconds'`,
        eq(pages.wordCount, 0),
        eq(pages.bodyText, ''),
        sql`${pages.derivedRev} = ${pages.snapshotRev}`,
        isNull(pages.icon),
        isNull(pages.cover),
        sql`not exists (select 1 from ${nodes} c where c.parent_id = ${nodes.id})`,
        sql`not exists (select 1 from ${pageComments} pc where pc.node_id = ${nodes.id})`,
        sql`not exists (select 1 from ${pageRefs} r where r.to_node_id = ${nodes.id})`,
      ),
    )
    .limit(100);
  if (!rows.length) return 0;
  await db.delete(nodes).where(
    and(
      inArray(
        nodes.id,
        rows.map((r) => r.id),
      ),
      ne(nodes.type, 'folder'),
    ),
  );
  logger.info({ count: rows.length }, 'abandoned empty pages removed');
  return rows.length;
}
