import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { conversations, meetings, messages, users } from '@crewhall/db';
import { CHAT_LIMITS, MEET_IDENTITY, type GuestChatMessage } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { afterWrite, writeMessage } from '../chat/messages';
import { chatEnabled } from '../chat/module';
import { mentionedIds, plainText } from '../chat/text';
import { type Membership } from '../chat/access';
import { liveSession } from './access';
import { guestRow, requireLiveKit } from './join';
import { meetEnabled } from './module';

/**
 * Guests write in the same chat as members (kararlar.md, 2026-11-04). A guest has no account, so
 * this is their whole view of chat: their knock's secret opens the conversation of that one
 * meeting, text only, and never the chat module's general api.
 *
 * What a guest may see is narrow on purpose: messages since this meeting session started (a
 * persistent room's chat goes back months, and that is the members'), while they are in the room.
 * Their ticket outlives their visit, so being in the room is checked against LiveKit.
 */

/** How long a "still in the room" answer holds: guests poll every few seconds. */
const PRESENCE_MS = 30_000;
const inRoom = new Map<string, number>();

const SEND_PER_MINUTE = 30;
const sends = new Map<string, number[]>();

function sendAllowed(key: string, now = Date.now()) {
  const recent = (sends.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= SEND_PER_MINUTE) {
    sends.set(key, recent);
    return false;
  }
  recent.push(now);
  sends.set(key, recent);
  if (sends.size > 5000) sends.clear();
  return true;
}

/** Tests: start from an empty cache and rate limit. */
export function resetGuestChat() {
  inRoom.clear();
  sends.clear();
}

async function stillInRoom(deps: Deps, roomName: string, identity: string) {
  const now = Date.now();
  const known = inRoom.get(identity);
  if (known && now - known < PRESENCE_MS) return true;
  let yes: boolean;
  try {
    const live = await requireLiveKit(deps).listParticipants(roomName);
    yes = live.some((p) => p.identity === identity);
  } catch (err) {
    // LiveKit unreachable: the room is in trouble anyway, the chat need not be.
    deps.logger.warn({ err, room: roomName }, 'guest chat: participants not available');
    yes = true;
  }
  // Only a yes is kept: the chat asks while the guest is still connecting.
  if (inRoom.size > 5000) inRoom.clear();
  if (yes) inRoom.set(identity, now);
  else inRoom.delete(identity);
  return yes;
}

/** The guest's conversation and from when they may read it; refuses everything else. */
async function guestScope(deps: Deps, requestId: string, secret: string) {
  const { db } = deps;
  const row = await guestRow(db, requestId, secret);
  if (row.status !== 'admitted') throw new AppError('forbidden');
  const [m] = await db.select().from(meetings).where(eq(meetings.id, row.meetingId));
  if (!m) throw new AppError('not_found');
  if (!(await meetEnabled(db, m.orgId)))
    throw new AppError('meet_unavailable', { reason: 'module_disabled' });
  const identity = MEET_IDENTITY.guest(row.id);
  const session = await liveSession(db, m.id);
  if (m.cancelledAt || session?.removedIdentities.includes(identity)) {
    throw new AppError('forbidden');
  }
  if (!(await stillInRoom(deps, m.roomName, identity))) throw new AppError('forbidden');
  // No chat for this meeting: the room falls back to its live channel, like members' rooms.
  if (!m.chatConversationId || !(await chatEnabled(db, m.orgId))) throw new AppError('not_found');
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, m.chatConversationId));
  // Only ever the meeting's own conversation, never a direct or group chat it came from.
  if (!conv || conv.type !== 'meeting' || conv.meetingId !== m.id || conv.orgId !== m.orgId) {
    throw new AppError('not_found');
  }
  return { row, conv, identity, since: session?.startedAt ?? row.createdAt };
}

export async function listGuestChat(deps: Deps, requestId: string, secret: string) {
  const { db } = deps;
  const { row, conv, since } = await guestScope(deps, requestId, secret);
  const rows = (
    await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conv.id),
          eq(messages.kind, 'user'),
          gte(messages.createdAt, since),
          isNull(messages.whisperTo),
          isNull(messages.deletedAt),
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(100)
  ).reverse();
  const ids = [
    ...new Set([
      ...rows.flatMap((r) => (r.authorId ? [r.authorId] : [])),
      ...mentionedIds(rows.map((r) => r.text)),
    ]),
  ];
  const people = ids.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const names = new Map(people.map((p) => [p.id, p.name]));
  const items: GuestChatMessage[] = [];
  for (const r of rows) {
    const guest = r.body.guest;
    const author = r.authorId ? byId.get(r.authorId) : undefined;
    const name = guest?.name ?? author?.name ?? r.body.remote?.name;
    if (!name) continue;
    items.push({
      id: r.id,
      name,
      guest: Boolean(guest),
      mine: guest?.id === row.id,
      // Plain text: mention tokens hold member ids.
      text: plainText(r.text, names),
      createdAt: r.createdAt.toISOString(),
    });
  }
  return { items };
}

export async function sendGuestChat(
  deps: Deps,
  requestId: string,
  input: { secret: string; text: string; clientMsgId: string },
) {
  const { row, conv, identity } = await guestScope(deps, requestId, input.secret);
  const text = input.text
    .trim()
    // A guest cannot mention anyone: mention tokens stay plain text.
    .replace(/<@([^>]*)>/g, '@$1')
    .slice(0, CHAT_LIMITS.messageChars);
  if (!text) throw new AppError('bad_request', { reason: 'empty' });
  const [dup] = await deps.db
    .select({ id: messages.id, createdAt: messages.createdAt, text: messages.text })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conv.id),
        eq(messages.clientMsgId, input.clientMsgId),
        sql`${messages.body}->'guest'->>'id' = ${row.id}`,
      ),
    )
    .orderBy(asc(messages.seq))
    .limit(1);
  const out = (m: { id: string; text: string; createdAt: Date }): GuestChatMessage => ({
    id: m.id,
    name: row.name,
    guest: true,
    mine: true,
    text: m.text,
    createdAt: m.createdAt.toISOString(),
  });
  if (dup) return out(dup);
  if (!sendAllowed(identity)) throw new AppError('rate_limited');

  const membership: Membership = { conv, row: null, spaceRole: null, isMember: true };
  const result = await deps.db.transaction((tx) =>
    writeMessage(deps, tx, membership, {
      authorId: null,
      kind: 'user',
      text,
      clientMsgId: input.clientMsgId,
      guest: { id: row.id, name: row.name.slice(0, 200) },
    }),
  );
  await afterWrite(deps, conv, result.msg, result.notes);
  return out(result.msg);
}
