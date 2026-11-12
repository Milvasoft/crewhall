import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { nodes, nodeUserState, spaces, type DbOrTx } from '@crewhall/db';
import type { NodeSearchHit, NodeType, RecentNode } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { keyBetween } from '../../util/position';
import { loadNode, mapVisible, reachableSpaceIds, type DriveActor } from './access';
import { hiddenNodeTypes, visibleNodeTypes } from '../identity/node-types';
import { searchContents } from './content';

/** Favorites strip (3.17): across spaces, in the person's own order. */
export async function listFavorites(db: DbOrTx, a: DriveActor) {
  const rows = await db
    .select({ node: nodes })
    .from(nodeUserState)
    .innerJoin(nodes, eq(nodes.id, nodeUserState.nodeId))
    .where(
      and(
        eq(nodeUserState.userId, a.userId),
        eq(nodeUserState.orgId, a.org.id),
        eq(nodeUserState.favorite, true),
        isNull(nodes.deletedAt),
        visibleNodeTypes(await hiddenNodeTypes(db, a.org.id)),
      ),
    )
    .orderBy(asc(nodeUserState.favoritePosition), desc(nodeUserState.updatedAt));
  // Nodes the person lost access to drop out silently (3.17).
  return mapVisible(
    db,
    a,
    rows.map((r) => r.node),
  );
}

export async function setFavorite(
  db: DbOrTx,
  a: DriveActor,
  nodeId: string,
  input: { favorite: boolean; afterId?: string | null | undefined },
) {
  const access = await loadNode(db, a, nodeId);
  let position: string | null = null;
  if (input.favorite) {
    const strip = await db
      .select({ nodeId: nodeUserState.nodeId, pos: nodeUserState.favoritePosition })
      .from(nodeUserState)
      .where(
        and(
          eq(nodeUserState.userId, a.userId),
          eq(nodeUserState.favorite, true),
          isNotNull(nodeUserState.favoritePosition),
          sql`${nodeUserState.nodeId} <> ${nodeId}::uuid`,
        ),
      )
      .orderBy(asc(nodeUserState.favoritePosition));
    if (input.afterId === undefined) {
      position = keyBetween(strip.at(-1)?.pos ?? null, null);
    } else {
      const i = input.afterId === null ? -1 : strip.findIndex((s) => s.nodeId === input.afterId);
      position = keyBetween(strip[i]?.pos ?? null, strip[i + 1]?.pos ?? null);
    }
  }
  await db
    .insert(nodeUserState)
    .values({
      userId: a.userId,
      nodeId,
      orgId: access.node.orgId,
      favorite: input.favorite,
      favoritePosition: position,
    })
    .onConflictDoUpdate({
      target: [nodeUserState.userId, nodeUserState.nodeId],
      set: { favorite: input.favorite, favoritePosition: position, updatedAt: new Date() },
    });
  const [node] = await mapVisible(db, a, [access.node]);
  return node!;
}

export async function listRecent(db: DbOrTx, a: DriveActor, limit: number): Promise<RecentNode[]> {
  const rows = await db
    .select({ node: nodes, at: nodeUserState.lastOpenedAt })
    .from(nodeUserState)
    .innerJoin(nodes, eq(nodes.id, nodeUserState.nodeId))
    .where(
      and(
        eq(nodeUserState.userId, a.userId),
        eq(nodeUserState.orgId, a.org.id),
        isNotNull(nodeUserState.lastOpenedAt),
        isNull(nodes.deletedAt),
        visibleNodeTypes(await hiddenNodeTypes(db, a.org.id)),
      ),
    )
    .orderBy(desc(nodeUserState.lastOpenedAt))
    .limit(limit * 2);
  const opened = new Map(rows.map((r) => [r.node.id, r.at!]));
  const visible = await mapVisible(
    db,
    a,
    rows.map((r) => r.node),
  );
  return visible
    .slice(0, limit)
    .map((n) => ({ ...n, lastOpenedAt: opened.get(n.id)!.toISOString() }));
}

/**
 * Drive search (3.15, Ctrl K): names first (doc 17 §4: pg_trgm, substring matches before
 * trigram similarity), then files whose text matches (roadmap 10: Turkish and English
 * full-text index), filtered by what the caller may see. `content: false` searches names only.
 */
export async function searchNodes(
  db: DbOrTx,
  a: DriveActor,
  q: {
    q: string;
    spaceId?: string | undefined;
    type?: NodeType | undefined;
    content?: boolean | undefined;
    cursor?: string | undefined;
    limit: number;
  },
) {
  const reachable = await reachableSpaceIds(db, a);
  if (q.spaceId && !reachable.includes(q.spaceId)) throw new AppError('not_found');
  const spaceIds = q.spaceId ? [q.spaceId] : reachable;
  if (spaceIds.length === 0) return { items: [], nextCursor: null };
  const term = q.q.trim();
  const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const score = sql<number>`(case when ${nodes.name} ilike ${like} then 1 else 0 end) + similarity(${nodes.name}, ${term})`;
  const conds: SQL[] = [
    inArray(nodes.spaceId, spaceIds),
    eq(nodes.orgId, a.org.id),
    isNull(nodes.deletedAt),
    sql`(${nodes.name} ilike ${like} or ${nodes.name} % ${term})`,
  ];
  const typeFilter = visibleNodeTypes(await hiddenNodeTypes(db, a.org.id));
  if (typeFilter) conds.push(typeFilter);
  if (q.type) conds.push(eq(nodes.type, q.type));
  const offset = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString('utf8')) || 0 : 0;
  // Both lists from the top: content matches follow once the name matches run out.
  const want = offset + q.limit + 1;
  const nameRows = await db
    .select({ node: nodes })
    .from(nodes)
    .where(and(...conds))
    .orderBy(desc(score), asc(nodes.name), asc(nodes.id))
    .limit(want);
  const named = new Set(nameRows.map((r) => r.node.id));
  const contentHits =
    q.content !== false && (!q.type || q.type === 'file') && nameRows.length < want
      ? await searchContents(db, a, { q: term, spaceIds, limit: want })
      : [];
  const merged = [
    ...nameRows.map((r) => ({ node: r.node, matchedIn: 'name' as const, snippet: null })),
    ...contentHits
      .filter((h) => !named.has(h.node.id))
      .map((h) => ({ node: h.node, matchedIn: 'content' as const, snippet: h.snippet })),
  ];
  const pageRows = merged.slice(offset, offset + q.limit);
  const visible = await mapVisible(
    db,
    a,
    pageRows.map((r) => r.node),
  );
  const spaceRows = visible.length
    ? await db
        .select({ id: spaces.id, name: spaces.name, color: spaces.color })
        .from(spaces)
        .where(inArray(spaces.id, [...new Set(visible.map((n) => n.spaceId))]))
    : [];
  const items: NodeSearchHit[] = [];
  for (const node of visible) {
    const row = pageRows.find((r) => r.node.id === node.id)!;
    const ancestors = await db
      .select({ id: nodes.id, name: nodes.name })
      .from(nodes)
      .where(sql`${nodes.path} @> ${row.node.path}::ltree and ${nodes.id} <> ${row.node.id}`)
      .orderBy(sql`nlevel(${nodes.path})`);
    const space = spaceRows.find((s) => s.id === node.spaceId)!;
    items.push({ node, path: ancestors, space, matchedIn: row.matchedIn, snippet: row.snippet });
  }
  return {
    items,
    nextCursor:
      merged.length > offset + q.limit
        ? Buffer.from(String(offset + q.limit)).toString('base64url')
        : null,
  };
}
