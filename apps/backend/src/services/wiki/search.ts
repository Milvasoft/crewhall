import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { nodes, pageComments, pages, spaces, users, type DbOrTx } from '@crewhall/db';
import { SNIPPET_MARK_END, SNIPPET_MARK_START, can, type PageSearchHit } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import {
  nodeResource,
  reachableSpaceIds,
  roleForPath,
  spaceRoleOf,
  userSharePaths,
  type DriveActor,
} from '../drive/access';

/**
 * Full-text page search (design 5.18, doc 17 §4 "Arama"): titles and bodies from
 * pages.search, comments from page_comments.search. Both vectors hold Turkish and English
 * stems.
 *
 * Postgres's Turkish snowball stemmer is not consistent across inflections ("sunucu" and
 * "sunucuların" stem to `sunuç`, "sunucular" and "sunucuları" to `sunucu`), so each query
 * word is expanded: the word and its forms with common Turkish suffixes removed, each
 * stemmed Turkish and English and also taken as a plain prefix. Every word is a prefix match
 * so results come while typing; words are AND-ed.
 */
const TR_SUFFIXES = [
  'ların',
  'lerin',
  'ları',
  'leri',
  'lar',
  'ler',
  'nın',
  'nin',
  'nun',
  'nün',
  'dan',
  'den',
  'tan',
  'ten',
  'da',
  'de',
  'ta',
  'te',
  'ın',
  'in',
  'un',
  'ün',
  'yı',
  'yi',
  'yu',
  'yü',
  'ya',
  'ye',
  'ı',
  'i',
  'u',
  'ü',
  'a',
  'e',
];

export function wordForms(word: string): string[] {
  const out = new Set([word]);
  let cur = word;
  for (let round = 0; round < 4; round++) {
    const suffix = TR_SUFFIXES.find((x) => cur.endsWith(x) && cur.length - x.length >= 4);
    if (!suffix) break;
    cur = cur.slice(0, -suffix.length);
    out.add(cur);
  }
  return [...out];
}

export function searchQuery(q: string): SQL | null {
  const words = (q.toLocaleLowerCase('tr').match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
  if (!words.length) return null;
  const perWord = words.map((w) => {
    const parts = wordForms(w).flatMap((f) => {
      const e = `${f}:*`;
      return [
        sql`to_tsquery('turkish', ${e})`,
        sql`to_tsquery('english', ${e})`,
        sql`to_tsquery('simple', ${e})`,
      ];
    });
    return sql`(${sql.join(parts, sql` || `)})`;
  });
  return sql`(${sql.join(perWord, sql` && `)})`;
}

const HEADLINE = `StartSel=${SNIPPET_MARK_START}, StopSel=${SNIPPET_MARK_END}, MaxWords=28, MinWords=10, MaxFragments=2, FragmentDelimiter=" … "`;

interface Candidate {
  kind: 'page' | 'comment';
  nodeId: string;
  name: string;
  icon: string | null;
  spaceId: string;
  path: string;
  updatedAt: Date;
  updatedBy: string | null;
  rank: number;
  titleHit: boolean;
  snippet: string;
  authorId: string | null;
}

export async function searchPages(
  db: DbOrTx,
  a: DriveActor,
  q: {
    q: string;
    spaceId?: string | undefined;
    comments: boolean;
    days?: number | undefined;
    cursor?: string | undefined;
    limit: number;
  },
) {
  const reachable = await reachableSpaceIds(db, a);
  if (q.spaceId && !reachable.includes(q.spaceId)) throw new AppError('not_found');
  const spaceIds = q.spaceId ? [q.spaceId] : reachable;
  const tq = searchQuery(q.q);
  if (!tq || !spaceIds.length) return { items: [], nextCursor: null };
  const offset = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString('utf8')) || 0 : 0;
  const take = (offset + q.limit) * 3 + 1;

  const scope: SQL[] = [
    eq(nodes.orgId, a.org.id),
    inArray(nodes.spaceId, spaceIds),
    sql`${nodes.deletedAt} is null`,
  ];
  if (q.days) scope.push(sql`${nodes.updatedAt} > now() - make_interval(days => ${q.days})`);

  const pageRows = await db
    .select({
      nodeId: nodes.id,
      name: nodes.name,
      icon: pages.icon,
      spaceId: nodes.spaceId,
      path: nodes.path,
      updatedAt: nodes.updatedAt,
      updatedBy: nodes.updatedBy,
      rank: sql<number>`ts_rank_cd(${pages.search}, ${tq})`,
      titleHit: sql<boolean>`(to_tsvector('turkish', ${nodes.name}) || to_tsvector('english', ${nodes.name})) @@ ${tq}`,
      snippet: sql<string>`ts_headline('turkish', ${pages.bodyText}, ${tq}, ${HEADLINE})`,
    })
    .from(pages)
    .innerJoin(nodes, eq(nodes.id, pages.nodeId))
    .where(and(...scope, sql`${pages.search} @@ ${tq}`))
    .orderBy(sql`ts_rank_cd(${pages.search}, ${tq}) desc`, nodes.id)
    .limit(take);

  const commentRows = q.comments
    ? await db
        .select({
          nodeId: nodes.id,
          name: nodes.name,
          icon: pages.icon,
          spaceId: nodes.spaceId,
          path: nodes.path,
          updatedAt: pageComments.createdAt,
          authorId: pageComments.authorId,
          rank: sql<number>`ts_rank_cd(${pageComments.search}, ${tq})`,
          snippet: sql<string>`ts_headline('turkish', ${pageComments.body}, ${tq}, ${HEADLINE})`,
        })
        .from(pageComments)
        .innerJoin(nodes, eq(nodes.id, pageComments.nodeId))
        .leftJoin(pages, eq(pages.nodeId, nodes.id))
        .where(and(...scope, sql`${pageComments.search} @@ ${tq}`))
        .orderBy(sql`ts_rank_cd(${pageComments.search}, ${tq}) desc`, pageComments.id)
        .limit(take)
    : [];

  const candidates: Candidate[] = [
    ...pageRows.map((r) => ({
      kind: 'page' as const,
      ...r,
      rank: Number(r.rank) + (r.titleHit ? 1 : 0),
      authorId: null,
    })),
    ...commentRows.map((r) => ({
      kind: 'comment' as const,
      ...r,
      rank: Number(r.rank) * 0.8,
      updatedBy: r.authorId,
      titleHit: false,
    })),
  ].sort((x, y) => y.rank - x.rank);

  // Rights: the space role or a share on the page or an ancestor.
  const roles = new Map<string, Awaited<ReturnType<typeof spaceRoleOf>>>();
  const shares = new Map<string, Awaited<ReturnType<typeof userSharePaths>>>();
  const visible: Candidate[] = [];
  for (const c of candidates) {
    if (!roles.has(c.spaceId)) {
      roles.set(c.spaceId, await spaceRoleOf(db, c.spaceId, a.userId));
      shares.set(c.spaceId, await userSharePaths(db, c.spaceId, a.userId));
    }
    const role = roleForPath(roles.get(c.spaceId)!, shares.get(c.spaceId)!, c.path);
    if (role && can(a.actor, 'space.view', nodeResource(a, role))) visible.push(c);
  }
  const slice = visible.slice(offset, offset + q.limit);

  const spaceRows = slice.length
    ? await db
        .select({ id: spaces.id, name: spaces.name, slug: spaces.slug, color: spaces.color })
        .from(spaces)
        .where(inArray(spaces.id, [...new Set(slice.map((c) => c.spaceId))]))
    : [];
  const peopleIds = [
    ...new Set(slice.flatMap((c) => [c.updatedBy, c.authorId]).filter((x): x is string => !!x)),
  ];
  const people = new Map(
    (peopleIds.length ? await db.select().from(users).where(inArray(users.id, peopleIds)) : []).map(
      (u) => [u.id, { id: u.id, name: u.name, email: u.email, imageUrl: u.image }],
    ),
  );

  const items: PageSearchHit[] = [];
  for (const c of slice) {
    const ancestors = await db
      .select({ name: nodes.name })
      .from(nodes)
      .where(sql`${nodes.path} @> ${c.path}::ltree and ${nodes.id} <> ${c.nodeId}`)
      .orderBy(sql`nlevel(${nodes.path})`);
    const snippet = c.snippet?.trim() ?? '';
    items.push({
      node: { id: c.nodeId, name: c.name, icon: c.icon },
      space: spaceRows.find((s) => s.id === c.spaceId)!,
      path: ancestors.map((x) => x.name).join(' / '),
      matchedIn:
        c.kind === 'comment'
          ? 'comment'
          : c.titleHit && !snippet.includes(SNIPPET_MARK_START)
            ? 'title'
            : 'body',
      snippet,
      author: c.kind === 'comment' && c.authorId ? (people.get(c.authorId) ?? null) : null,
      updatedAt: c.updatedAt.toISOString(),
      updatedBy: c.updatedBy ? (people.get(c.updatedBy) ?? null) : null,
    });
  }
  return {
    items,
    nextCursor:
      visible.length > offset + q.limit
        ? Buffer.from(String(offset + q.limit)).toString('base64url')
        : null,
  };
}
