import { and, eq, sql } from 'drizzle-orm';
import { messages, organizations, type Db, type DbOrTx } from '@crewhall/db';
import { chatTextLinks, type Message } from '@crewhall/shared';
import type { Deps } from '../../deps';
import type { Env } from '../../env';
import type { Jobs } from '../../jobs/queue';
import type { Logger } from '../../logger';
import type { Bus } from '../../realtime/bus';
import { AppError } from '../../http/errors';
import { fetchPagePreview, type PagePreview } from '../quick/links';
import { loadConversation, requireMessage, type ChatActor, type MessageRow } from './access';
import { publishMessage } from './messages';
import { toMessage } from './views';

/**
 * Link preview cards in chat (kararlar.md 2026-11-13). Sending never waits for them: the
 * message goes out, a `chat.link_preview` job reads the first external address through the
 * guarded outbound fetch (quick/links fetchPagePreview) and the card arrives with
 * `message.updated`. The author may remove it for good.
 */

/** The address a message previews: the first link that is not this Crewhall itself. */
export function previewTarget(env: Pick<Env, 'HUB_URL' | 'API_URL'>, text: string) {
  const own = new Set<string>();
  for (const u of [env.HUB_URL, env.API_URL]) {
    try {
      if (u) own.add(new URL(u).host);
    } catch {
      // Not an address: nothing to skip.
    }
  }
  for (const link of chatTextLinks(text)) {
    try {
      if (!own.has(new URL(link).host)) return link;
    } catch {
      // A link the URL parser rejects is not previewed.
    }
  }
  return null;
}

/** Queues the preview of a written or edited message when it has something to preview. */
export function queueLinkPreview(deps: { env: Env; jobs: Jobs; logger: Logger }, row: MessageRow) {
  if (row.kind !== 'user' || row.deletedAt || row.body.linkPreviewRemoved) return;
  // An edit that drops the address also drops the card (the job clears it).
  if (!previewTarget(deps.env, row.text) && !row.body.linkPreview) return;
  void deps.jobs
    .send('chat.link_preview', { messageId: row.id })
    .catch((err: unknown) => deps.logger.warn({ err }, 'link preview not queued'));
}

/** Recently read pages: one popular address shared in many chats is read once. */
const cache = new Map<string, { at: number; preview: PagePreview | null }>();
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 500;

async function previewOf(url: string) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.preview;
  const preview = await fetchPagePreview(url);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(url, { at: Date.now(), preview });
  return preview;
}

/** Tests: forget what was read. */
export function clearLinkPreviewCache() {
  cache.clear();
}

async function previewsOn(db: DbOrTx, orgId: string) {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return org?.settings.chatLinkPreviews !== false;
}

/** The `chat.link_preview` job: sets, replaces or clears the card of one message. */
export async function runLinkPreview(
  deps: { db: Db; bus: Bus; env: Env },
  messageId: string,
): Promise<void> {
  const { db } = deps;
  const [row] = await db.select().from(messages).where(eq(messages.id, messageId));
  if (!row || row.kind !== 'user' || row.deletedAt || row.body.linkPreviewRemoved) return;
  const target = (await previewsOn(db, row.orgId)) ? previewTarget(deps.env, row.text) : null;
  const current = row.body.linkPreview;
  let next: Message['linkPreview'] = null;
  if (target) {
    // The same address as before (an edit elsewhere in the text): keep the card.
    if (current?.url === target) return;
    const page = await previewOf(target);
    // The card opens the address as written; the page may have come through redirects.
    if (page && (page.title || page.description)) next = { ...page, url: target };
  }
  if (!next && !current) return;
  // Only if the text is still the one read (an edit queues its own job) and the author has
  // not removed the card meanwhile.
  const body = next
    ? sql`${messages.body} || jsonb_build_object('linkPreview', ${JSON.stringify(next)}::jsonb)`
    : sql`${messages.body} - 'linkPreview'`;
  const [updated] = await db
    .update(messages)
    .set({ body, updatedAt: new Date() })
    .where(
      and(
        eq(messages.id, row.id),
        eq(messages.text, row.text),
        sql`${messages.deletedAt} is null`,
        sql`(${messages.body} ->> 'linkPreviewRemoved') is null`,
      ),
    )
    .returning();
  if (!updated) return;
  await publishMessage(
    deps,
    await loadConversation(db, row.orgId, row.conversationId),
    'message.updated',
    updated,
  );
}

/** The author takes the card off; it is not read again for this message. */
export async function removeLinkPreview(deps: Deps, a: ChatActor, messageId: string) {
  const { db } = deps;
  const { msg, m } = await requireMessage(db, a, messageId);
  if (msg.authorId !== a.userId || msg.kind !== 'user' || msg.deletedAt) {
    throw new AppError('chat_message_not_editable');
  }
  if (msg.body.linkPreviewRemoved) return toMessage(db, a.userId, msg);
  const [row] = await db
    .update(messages)
    .set({
      body: sql`(${messages.body} - 'linkPreview') || '{"linkPreviewRemoved": true}'::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(messages.id, msg.id))
    .returning();
  await publishMessage(deps, m.conv, 'message.updated', row!);
  return toMessage(db, a.userId, row!);
}
