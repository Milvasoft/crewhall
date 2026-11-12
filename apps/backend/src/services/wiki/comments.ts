import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { nodes, pageComments, users, type Db, type DbOrTx } from '@crewhall/db';
import { checkDlp } from '../compliance/policy';
import { pagePath, type CommentThread, withQuery } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { Logger } from '../../logger';
import type { DriveActor } from '../drive/access';
import { canDo, loadPage, requirePage } from './access';
import { canView } from './derive';
import { notifyCollab } from './live';
import type { Env } from '../../env';
import { sendPageNotice } from './notify';

type Row = typeof pageComments.$inferSelect;
type UserRow = typeof users.$inferSelect;

const b64 = (b: Buffer | null) => (b ? b.toString('base64') : null);
const fromB64 = (s: string | undefined) => (s ? Buffer.from(s, 'base64') : null);
const summary = (u: UserRow | undefined) =>
  u ? { id: u.id, name: u.name, email: u.email, imageUrl: u.image } : null;

export interface CommentDeps {
  db: Db;
  env: Env;
  logger: Logger;
}

async function threadsOf(db: DbOrTx, nodeId: string, rootIds?: string[]): Promise<CommentThread[]> {
  const rows = await db
    .select()
    .from(pageComments)
    .where(
      and(
        eq(pageComments.nodeId, nodeId),
        rootIds
          ? or(inArray(pageComments.id, rootIds), inArray(pageComments.rootId, rootIds))
          : undefined,
      ),
    )
    .orderBy(asc(pageComments.createdAt), asc(pageComments.id));
  const peopleIds = [
    ...new Set(rows.flatMap((r) => [r.authorId, r.resolvedBy]).filter((x): x is string => !!x)),
  ];
  const people = new Map(
    (peopleIds.length ? await db.select().from(users).where(inArray(users.id, peopleIds)) : []).map(
      (u) => [u.id, u],
    ),
  );
  const roots = rows.filter((r) => r.rootId === null);
  return roots.map((root) => {
    const replies = rows.filter((r) => r.rootId === root.id);
    const all = [root, ...replies];
    return {
      id: root.id,
      nodeId,
      anchorStart: b64(root.anchorStart),
      anchorEnd: b64(root.anchorEnd),
      quote: root.quote,
      resolvedAt: root.resolvedAt?.toISOString() ?? null,
      resolvedBy: root.resolvedBy ? summary(people.get(root.resolvedBy)) : null,
      comments: all.map((c: Row) => ({
        id: c.id,
        author: c.authorId ? summary(people.get(c.authorId)) : null,
        body: c.body,
        mentions: c.mentions,
        createdAt: c.createdAt.toISOString(),
        editedAt: c.editedAt?.toISOString() ?? null,
      })),
      createdAt: root.createdAt.toISOString(),
      updatedAt: (all.at(-1)?.createdAt ?? root.createdAt).toISOString(),
    };
  });
}

export async function listComments(
  db: DbOrTx,
  a: DriveActor,
  nodeId: string,
  status: 'open' | 'resolved' | 'all',
) {
  await loadPage(db, a, nodeId);
  const threads = await threadsOf(db, nodeId);
  if (status === 'open') return threads.filter((t) => !t.resolvedAt);
  if (status === 'resolved') return threads.filter((t) => t.resolvedAt);
  return threads;
}

async function thread(db: DbOrTx, nodeId: string, rootId: string) {
  const [t] = await threadsOf(db, nodeId, [rootId]);
  if (!t) throw new AppError('not_found');
  return t;
}

/** Opens the page with the comments panel on the thread. */
const threadUrl = (node: typeof nodes.$inferSelect, threadId: string) =>
  withQuery(pagePath(node), { comment: threadId, panel: 'comments' });

/** Mentioned people who can see the page are notified (doc 17 §10). */
async function notifyMentioned(
  deps: CommentDeps,
  node: typeof nodes.$inferSelect,
  actorId: string,
  mentions: string[],
  comment: { id: string; rootId: string | null },
  body: string,
) {
  if (!mentions.length) return;
  const allowed: string[] = [];
  for (const id of new Set(mentions)) if (await canView(deps.db, node, id)) allowed.push(id);
  await sendPageNotice(
    {
      type: 'page.comment_mention',
      orgId: node.orgId,
      spaceId: node.spaceId,
      nodeId: node.id,
      pageName: node.name,
      actorId,
      userIds: allowed,
      commentId: comment.id,
      threadId: comment.rootId ?? comment.id,
      excerpt: body.slice(0, 140),
      url: threadUrl(node, comment.rootId ?? comment.id),
    },
    deps.logger,
  );
}

export async function createComment(
  deps: CommentDeps,
  a: DriveActor,
  nodeId: string,
  input: {
    body: string;
    threadId?: string | undefined;
    anchorStart?: string | undefined;
    anchorEnd?: string | undefined;
    quote?: string | undefined;
    mentions: string[];
  },
) {
  const { db } = deps;
  const access = await loadPage(db, a, nodeId);
  requirePage(a, access, 'space.comment');
  await checkDlp(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      surface: 'page_comment',
      targetType: 'page',
      targetId: nodeId,
    },
    input.body,
  );
  let rootId: string | null = null;
  let threadAuthors: string[] = [];
  if (input.threadId) {
    const [root] = await db
      .select()
      .from(pageComments)
      .where(
        and(
          eq(pageComments.id, input.threadId),
          eq(pageComments.nodeId, nodeId),
          isNull(pageComments.rootId),
        ),
      );
    if (!root) throw new AppError('not_found');
    rootId = root.id;
    const authors = await db
      .selectDistinct({ id: pageComments.authorId })
      .from(pageComments)
      .where(or(eq(pageComments.id, root.id), eq(pageComments.rootId, root.id)));
    threadAuthors = authors.map((x) => x.id).filter((x): x is string => !!x);
  }
  const [row] = await db
    .insert(pageComments)
    .values({
      orgId: a.org.id,
      nodeId,
      rootId,
      authorId: a.userId,
      body: input.body,
      mentions: [...new Set(input.mentions)],
      anchorStart: rootId ? null : fromB64(input.anchorStart),
      anchorEnd: rootId ? null : fromB64(input.anchorEnd),
      quote: rootId ? null : (input.quote ?? null),
    })
    .returning();
  // Replying reopens a resolved thread.
  if (rootId) {
    await db
      .update(pageComments)
      .set({ resolvedAt: null, resolvedBy: null })
      .where(and(eq(pageComments.id, rootId), isNotNull(pageComments.resolvedAt)));
  }
  await notifyMentioned(deps, access.node, a.userId, input.mentions, row!, input.body);
  if (rootId) {
    await sendPageNotice(
      {
        type: 'page.comment_reply',
        orgId: access.node.orgId,
        spaceId: access.node.spaceId,
        nodeId,
        pageName: access.node.name,
        actorId: a.userId,
        userIds: threadAuthors.filter((id) => !input.mentions.includes(id)),
        commentId: row!.id,
        threadId: rootId,
        excerpt: input.body.slice(0, 140),
        url: threadUrl(access.node, rootId),
      },
      deps.logger,
    );
  }
  await notifyCollab(deps, nodeId, 'meta');
  return thread(db, nodeId, rootId ?? row!.id);
}

async function loadComment(db: DbOrTx, a: DriveActor, commentId: string) {
  const [row] = await db
    .select()
    .from(pageComments)
    .where(and(eq(pageComments.id, commentId), eq(pageComments.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  const access = await loadPage(db, a, row.nodeId);
  return { row, access };
}

export async function updateComment(
  deps: CommentDeps,
  a: DriveActor,
  commentId: string,
  input: { body: string; mentions: string[] },
) {
  const { db } = deps;
  const { row, access } = await loadComment(db, a, commentId);
  if (row.authorId !== a.userId) throw new AppError('forbidden');
  await checkDlp(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      surface: 'page_comment',
      targetType: 'page_comment',
      targetId: commentId,
    },
    input.body,
  );
  await db
    .update(pageComments)
    .set({ body: input.body, mentions: [...new Set(input.mentions)], editedAt: new Date() })
    .where(eq(pageComments.id, commentId));
  const added = input.mentions.filter((m) => !row.mentions.includes(m));
  await notifyMentioned(deps, access.node, a.userId, added, row, input.body);
  return thread(db, row.nodeId, row.rootId ?? row.id);
}

export async function deleteComment(deps: CommentDeps, a: DriveActor, commentId: string) {
  const { db } = deps;
  const { row, access } = await loadComment(db, a, commentId);
  const isAdmin = canDo(a, access.role, 'space.purge');
  if (row.authorId !== a.userId && !isAdmin) throw new AppError('forbidden');
  await db.delete(pageComments).where(eq(pageComments.id, commentId));
  await notifyCollab(deps, row.nodeId, 'meta');
}

export async function resolveThread(
  deps: CommentDeps,
  a: DriveActor,
  threadId: string,
  resolved: boolean,
) {
  const { db } = deps;
  const { row, access } = await loadComment(db, a, threadId);
  if (row.rootId !== null) throw new AppError('not_found');
  requirePage(a, access, 'space.comment');
  await db
    .update(pageComments)
    .set(
      resolved
        ? { resolvedAt: sql`coalesce(${pageComments.resolvedAt}, now())`, resolvedBy: a.userId }
        : { resolvedAt: null, resolvedBy: null },
    )
    .where(eq(pageComments.id, threadId));
  await notifyCollab(deps, row.nodeId, 'meta');
  return thread(db, row.nodeId, threadId);
}
