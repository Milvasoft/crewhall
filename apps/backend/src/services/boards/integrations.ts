import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import {
  conversationMembers,
  conversations,
  nodes,
  shares,
  spaceMembers,
  type Db,
  type DbOrTx,
  type Tx,
} from '@crewhall/db';
import type { BoardsWsEvent } from '@crewhall/shared';
import { publishToUsers, type Bus } from '../../realtime/bus';
import { chatEnabled } from '../chat/module';
import { appendSystem } from '../chat/messages';
import {
  createNotifications,
  deliverNotifications,
  type NotificationRow,
  type NotifyDeps,
} from '../notifications/notify';

/**
 * Seams to the chat module: notifications (doc 17 §10: the row commits with the event,
 * delivery happens after commit) and the card conversation (`conversations.type = 'card'`,
 * members are the card's followers). Board events (`board.changed`, `drawing.thumbnail`)
 * go to the WebSocket through the Bus after commit, to everyone who can see the node;
 * clients without a socket keep polling `getBoardRev`.
 */

export interface BoardNotification {
  orgId: string;
  userId: string;
  type: 'boards.assigned' | 'boards.comment' | 'boards.due_soon';
  actorId: string | null;
  cardId: string;
  spaceId: string;
  conversationId: string | null;
  data: Record<string, string | number | boolean | null>;
  /** Web path of the card: /b/<boardId>/<KEY-n>. */
  url: string;
}

export interface CardConversationInput {
  orgId: string;
  spaceId: string;
  cardId: string;
  title: string;
  /** Assignees and followers become members. */
  memberIds: string[];
  createdBy: string;
}

export interface BoardsIntegrations {
  /** Inside the event's transaction; delivered after commit by `inBoardsTx`. */
  notify(tx: DbOrTx, inputs: BoardNotification[]): Promise<void>;
  /** After commit; audience is everyone who can see the space or node. */
  /** Buffered inside `inBoardsTx` and sent after commit; elsewhere only listeners see it. */
  publish(event: BoardsWsEvent, audience: BoardsAudience): void;
  /** Creates the `card` conversation and returns its id; null when chat is off. */
  openCardConversation:
    ((tx: DbOrTx, input: CardConversationInput) => Promise<string | null>) | null;
  /** New followers of a card with a conversation join it. */
  addConversationMembers: (
    tx: DbOrTx,
    conversationId: string,
    orgId: string,
    userIds: string[],
  ) => Promise<void>;
  /** System line in an open card conversation (needs card events in chat's SystemEvent). */
  postCardSystemLine:
    | ((
        tx: DbOrTx,
        conversationId: string,
        line: { kind: string; actorId: string | null; data: Record<string, unknown> },
      ) => Promise<void>)
    | null;
}

type Listener = {
  notify?: (inputs: BoardNotification[]) => void;
  publish?: (event: BoardsWsEvent) => void;
};

const listeners = new Set<Listener>();

/** Tests observe what boards deliver. */
export function onBoardsDelivery(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface BoardsAudience {
  orgId: string;
  spaceId: string;
  /** The board or drawing node; shares on it or an ancestor reach people outside the space. */
  nodeId: string;
}

interface Delivery {
  deps: Pick<NotifyDeps, 'bus'> & Partial<NotifyDeps>;
  rows: NotificationRow[];
  /** Latest event per board / drawing, sent once the transaction committed. */
  events: Map<string, { event: BoardsWsEvent; audience: BoardsAudience }>;
}

const delivery = new AsyncLocalStorage<Delivery>();

/**
 * Runs a write in a transaction and delivers the notifications it created once it
 * committed (bell over WS, push jobs). Without it (no chat deps) rows are still written.
 */
export async function inBoardsTx<T>(
  deps: NotifyDeps & { db: Db },
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  const ctx: Delivery = { deps, rows: [], events: new Map() };
  const out = await delivery.run(ctx, () => deps.db.transaction(run));
  if (ctx.rows.length) await deliverNotifications(deps, ctx.rows);
  await sendBoardEvents(deps.db, deps.bus, ctx.events.values());
  return out;
}

/** Same as inBoardsTx for writers without notifications (collab store, thumbnails). */
export async function withBoardEvents<T>(
  deps: { db: Db; bus?: Bus | null },
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!deps.bus) return deps.db.transaction(run);
  const ctx: Delivery = { deps: { bus: deps.bus }, rows: [], events: new Map() };
  const out = await delivery.run(ctx, () => deps.db.transaction(run));
  await sendBoardEvents(deps.db, deps.bus, ctx.events.values());
  return out;
}

/** Space members plus people a share on the node or an ancestor reaches. */
async function audienceOf(db: DbOrTx, a: BoardsAudience) {
  const rows = await db.execute<{ user_id: string }>(sql`
    select m.user_id from ${spaceMembers} m where m.space_id = ${a.spaceId}::uuid
    union
    select s.grantee_user_id from ${shares} s
    join ${nodes} sn on sn.id = s.node_id
    join ${nodes} n on n.id = ${a.nodeId}::uuid
    where s.kind = 'user' and s.grantee_user_id is not null and n.path <@ sn.path`);
  return rows.rows.map((r) => r.user_id);
}

async function sendBoardEvents(
  db: DbOrTx,
  bus: Bus,
  events: Iterable<{ event: BoardsWsEvent; audience: BoardsAudience }>,
) {
  for (const { event, audience } of events) {
    try {
      publishToUsers(bus, await audienceOf(db, audience), event);
    } catch {
      // Clients still poll the board revision; a lost event only delays them.
    }
  }
}

/** After-commit publish for code that already committed (the thumbnail job). */
export async function publishBoardEvent(
  deps: { db: DbOrTx; bus?: Bus | null },
  event: BoardsWsEvent,
  audience: BoardsAudience,
) {
  for (const l of listeners) l.publish?.(event);
  if (deps.bus) await sendBoardEvents(deps.db, deps.bus, [{ event, audience }]);
}

const toInput = (n: BoardNotification) => ({
  orgId: n.orgId,
  userId: n.userId,
  type: n.type,
  category: 'boards' as const,
  actorId: n.actorId,
  target: {
    type: 'card' as const,
    id: n.cardId,
    conversationId: n.conversationId,
    spaceId: n.spaceId,
  },
  data: n.data,
  url: n.url,
  // Comments on one card merge into one unread row ("5 yeni yorum").
  groupKey: n.type === 'boards.comment' ? `boards.comment:${n.cardId}` : null,
});

const chatIntegrations: BoardsIntegrations = {
  async notify(tx, inputs) {
    for (const l of listeners) l.notify?.(inputs);
    if (!inputs.length) return;
    const ctx = delivery.getStore();
    const rows = await createNotifications(tx, inputs.map(toInput), ctx?.deps.presence);
    ctx?.rows.push(...rows);
  },
  publish(event, audience) {
    for (const l of listeners) l.publish?.(event);
    const key = event.type === 'board.changed' ? `b:${event.boardId}` : `d:${event.nodeId}`;
    delivery.getStore()?.events.set(key, { event, audience });
  },
  async openCardConversation(tx, input) {
    if (!(await chatEnabled(tx, input.orgId))) return null;
    // Not space-bound: the members are the card's followers, not the whole space.
    const [conv] = await tx
      .insert(conversations)
      .values({
        orgId: input.orgId,
        type: 'card',
        spaceId: null,
        name: input.title.slice(0, 200),
        createdBy: input.createdBy,
      })
      .returning();
    await chatIntegrations.addConversationMembers(tx, conv!.id, input.orgId, input.memberIds);
    await appendSystem(tx, conv!, { type: 'created', actorId: input.createdBy });
    return conv!.id;
  },
  async addConversationMembers(tx, conversationId, orgId, userIds) {
    if (!userIds.length) return;
    await tx
      .insert(conversationMembers)
      .values(userIds.map((userId) => ({ conversationId, userId, orgId, notify: 'all' as const })))
      .onConflictDoNothing();
  },
  postCardSystemLine: null,
};

let bound: BoardsIntegrations | null = null;

/** Lets a test replace the chat binding. */
export function bindBoardsIntegrations(impl: Partial<BoardsIntegrations> | null): void {
  bound = impl ? { ...chatIntegrations, ...impl } : null;
}

export function integrations(): BoardsIntegrations {
  return bound ?? chatIntegrations;
}
