import { and, eq, inArray } from 'drizzle-orm';
import { conversationMembers, incomingWebhooks, users, type DbOrTx } from '@crewhall/db';
import { guessAlertSeverity, type AlertCard } from '@crewhall/shared';
import type { NotificationInput } from '../notifications/notify';
import { defaultNotify, type ConversationRow, type MessageRow } from './access';
import { excerpt, mentionedIds } from './text';
import { paths, withQuery } from '@crewhall/shared';

/**
 * Who hears about a new message (doc 17 §10, design 04 rules):
 * - mentions always (even when muted), unless the level is "none"
 * - direct messages and replies to one's own message
 * - alert cards: critical (urgent push) at "all"/"critical", warning at "all";
 *   success and info only move the counter
 * - a webhook's plain text (no card) is read for its severity (emoji and words, shared
 *   guessAlertSeverity): critical notifies at "all"/"critical" and warning at "all", as a normal
 *   push (a guess never breaks quiet hours); anything else follows the level like a message
 * - other messages only at level "all"
 */
export async function messageNotifications(
  db: DbOrTx,
  conv: ConversationRow,
  msg: MessageRow,
  ctx: {
    members: string[];
    mentioned: Map<string, 'user' | 'all' | 'here'>;
    replyTo: MessageRow | null;
    card: AlertCard | null;
  },
): Promise<NotificationInput[]> {
  if (msg.kind === 'system') return [];
  const recipients = ctx.members.filter((id) => id !== msg.authorId);
  if (recipients.length === 0) return [];

  const rows = await db
    .select({
      userId: conversationMembers.userId,
      notify: conversationMembers.notify,
      mutedUntil: conversationMembers.mutedUntil,
    })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conv.id),
        inArray(conversationMembers.userId, recipients),
      ),
    );
  const settings = new Map(rows.map((r) => [r.userId, r]));

  const nameIds = [...mentionedIds([msg.text]), ...(msg.authorId ? [msg.authorId] : [])];
  const people = nameIds.length
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, nameIds))
    : [];
  const names = new Map(people.map((p) => [p.id, p.name]));
  let authorName = msg.authorId ? (names.get(msg.authorId) ?? null) : null;
  if (!authorName && msg.webhookId) {
    const [h] = await db
      .select({ name: incomingWebhooks.name })
      .from(incomingWebhooks)
      .where(eq(incomingWebhooks.id, msg.webhookId));
    authorName = h?.name ?? null;
  }
  if (!authorName && msg.body.automation) authorName = msg.body.automation.ruleName;
  if (!authorName && msg.body.guest) authorName = msg.body.guest.name;
  // A webhook's text without a card (Google Chat "text", Milvaion, scripts): its words decide.
  const textSeverity =
    msg.kind === 'webhook' && !ctx.card && msg.text ? guessAlertSeverity(msg.text) : null;
  const text =
    msg.text ||
    ctx.card?.title ||
    (msg.body.gif ? 'GIF' : '') ||
    (msg.body.refs?.length ? '🔗' : '');
  const data = {
    conversationTitle: conv.name ?? (conv.type === 'direct' ? authorName : null),
    conversationEmoji: conv.emoji,
    conversationType: conv.type,
    authorName,
    excerpt: excerpt(text, names, 140),
    severity: ctx.card?.severity ?? textSeverity,
  };
  const now = Date.now();
  const out: NotificationInput[] = [];
  const base = (userId: string) => ({
    orgId: conv.orgId,
    userId,
    actorId: msg.authorId,
    target: {
      type: 'message' as const,
      id: msg.id,
      conversationId: conv.id,
      seq: msg.seq,
      spaceId: conv.spaceId,
    },
    data,
    url: withQuery(paths.chatConversation(conv.id), { seq: msg.seq }),
  });

  for (const userId of recipients) {
    const s = settings.get(userId);
    const level = s?.notify ?? defaultNotify(conv.type);
    const muted = !!s?.mutedUntil && s.mutedUntil.getTime() > now;
    if (level === 'none') continue;
    if (ctx.mentioned.has(userId)) {
      out.push({
        ...base(userId),
        type: 'chat.mention',
        category: 'mention',
        groupKey: `chat:${conv.id}:mention`,
      });
      continue;
    }
    if (muted) continue;
    if (msg.kind === 'webhook' && ctx.card) {
      const sev = ctx.card.severity;
      const critical = sev === 'critical' && (level === 'all' || level === 'critical');
      if (critical || (sev === 'warning' && level === 'all')) {
        out.push({
          ...base(userId),
          type: 'chat.alert',
          category: 'alert',
          groupKey: `chat:${conv.id}:alert:${sev}`,
          urgent: critical,
        });
      }
      continue;
    }
    if (textSeverity === 'critical' || textSeverity === 'warning') {
      const critical = textSeverity === 'critical' && (level === 'all' || level === 'critical');
      if (critical || level === 'all') {
        out.push({
          ...base(userId),
          type: 'chat.alert',
          category: 'alert',
          groupKey: `chat:${conv.id}:alert:${textSeverity}`,
        });
      }
      continue;
    }
    if (conv.type === 'direct') {
      out.push({
        ...base(userId),
        type: 'chat.direct',
        category: 'direct_reply',
        groupKey: `chat:${conv.id}:direct`,
      });
    } else if (ctx.replyTo?.authorId === userId) {
      out.push({
        ...base(userId),
        type: 'chat.reply',
        category: 'direct_reply',
        groupKey: `chat:${conv.id}:reply`,
      });
    } else if (level === 'all') {
      out.push({
        ...base(userId),
        type: 'chat.message',
        category: 'conversation_message',
        groupKey: `chat:${conv.id}:message`,
      });
    }
  }
  return out;
}
