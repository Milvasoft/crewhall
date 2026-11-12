import { sql } from 'drizzle-orm';
import {
  conversationMembers,
  conversations,
  messageAttachments,
  messages,
  type DbOrTx,
} from '@crewhall/db';
import { AppError } from '../../http/errors';
import { mySpaceRoles, whisperVisible, type ChatActor } from './access';
import { visibleTo } from './conversations';
import { conversationViews, toMessages } from './views';

/**
 * Message search (design 4.16): only conversations the caller can read and only the
 * history shared with them. Full text on messages.search ('simple'), newest first.
 */
export async function searchMessages(
  db: DbOrTx,
  a: ChatActor,
  q: {
    q: string;
    conversationId?: string | undefined;
    fromUserId?: string | undefined;
    hasFile?: boolean | undefined;
    after?: string | undefined;
    before?: string | undefined;
    cursor?: string | undefined;
    limit: number;
  },
) {
  const words = q.q
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter(Boolean);
  if (words.length === 0) return { items: [], nextCursor: null };
  const tsq = words.map((w) => `${w}:*`).join(' & ');
  const spaceIds = [...(await mySpaceRoles(db, a.org.id, a.userId)).keys()];
  let offset = 0;
  if (q.cursor) {
    offset = Number(Buffer.from(q.cursor, 'base64url').toString('utf8'));
    if (!Number.isInteger(offset) || offset < 0) {
      throw new AppError('bad_request', { reason: 'invalid_cursor' });
    }
  }
  const rows = await db
    .select({
      msg: messages,
      highlight: sql<string>`ts_headline('simple', ${messages.text}, to_tsquery('simple', ${tsq}), 'StartSel=<mark>, StopSel=</mark>, MaxWords=30, MinWords=10')`,
    })
    .from(messages)
    .innerJoin(conversations, sql`${conversations.id} = ${messages.conversationId}`)
    .leftJoin(
      conversationMembers,
      sql`${conversationMembers.conversationId} = ${messages.conversationId} and ${conversationMembers.userId} = ${a.userId}::uuid`,
    )
    .where(
      sql`${visibleTo(a.org.id, a.userId, spaceIds)}
        and ${messages.deletedAt} is null
        and ${whisperVisible(a.userId)}
        and ${messages.search} @@ to_tsquery('simple', ${tsq})
        and ${messages.seq} >= greatest(coalesce(${conversationMembers.historyFromSeq}, 0), coalesce(${conversationMembers.clearedAtSeq} + 1, 0))
        ${q.conversationId ? sql`and ${messages.conversationId} = ${q.conversationId}::uuid` : sql``}
        ${q.fromUserId ? sql`and ${messages.authorId} = ${q.fromUserId}::uuid` : sql``}
        ${q.after ? sql`and ${messages.createdAt} >= ${new Date(q.after)}` : sql``}
        ${q.before ? sql`and ${messages.createdAt} < ${new Date(q.before)}` : sql``}
        ${
          q.hasFile
            ? sql`and exists (select 1 from ${messageAttachments} ma where ma.message_id = ${messages.id})`
            : sql``
        }`,
    )
    .orderBy(sql`${messages.createdAt} desc`)
    .limit(q.limit + 1)
    .offset(offset);
  const page = rows.slice(0, q.limit);
  const views = await toMessages(
    db,
    a.userId,
    page.map((r) => r.msg),
  );
  const convIds = [...new Set(page.map((r) => r.msg.conversationId))];
  const convRows = convIds.length
    ? await db
        .select()
        .from(conversations)
        .where(
          sql`${conversations.id} in (${sql.join(
            convIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        )
    : [];
  const convViews = new Map((await conversationViews(db, a, convRows)).map((c) => [c.id, c]));
  return {
    items: page.map((r, i) => {
      const c = convViews.get(r.msg.conversationId)!;
      return {
        message: views[i]!,
        conversation: { id: c.id, type: c.type, title: c.title, emoji: c.emoji ?? null },
        highlight: escapeExceptMark(r.highlight),
      };
    }),
    nextCursor:
      rows.length > q.limit ? Buffer.from(String(offset + q.limit)).toString('base64url') : null,
  };
}

/** ts_headline returns raw text: escape everything but the <mark> tags it added. */
function escapeExceptMark(s: string) {
  return s
    .split(/(<mark>|<\/mark>)/)
    .map((part) =>
      part === '<mark>' || part === '</mark>'
        ? part
        : part.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    )
    .join('');
}
