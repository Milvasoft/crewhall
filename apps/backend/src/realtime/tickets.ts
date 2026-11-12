import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, or, isNotNull, sql } from 'drizzle-orm';
import { wsTickets, type Db } from '@crewhall/db';
import { CHAT_LIMITS } from '@crewhall/shared';

const hash = (ticket: string) => createHash('sha256').update(ticket).digest('hex');

/** One-time WebSocket ticket (doc 17 §2): browsers can't send headers when opening a WS. */
export async function createWsTicket(
  db: Db,
  input: { orgId: string; userId: string; sessionId: string | null },
) {
  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + CHAT_LIMITS.wsTicketSeconds * 1000);
  await db.insert(wsTickets).values({
    tokenHash: hash(ticket),
    orgId: input.orgId,
    userId: input.userId,
    sessionId: input.sessionId,
    expiresAt,
  });
  return { ticket, expiresAt };
}

/** Marks the ticket used and returns who it belongs to; null when unknown, used or expired. */
export async function consumeWsTicket(db: Db, ticket: string) {
  if (!ticket || ticket.length > 100) return null;
  const [row] = await db
    .update(wsTickets)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(wsTickets.tokenHash, hash(ticket)),
        isNull(wsTickets.usedAt),
        gt(wsTickets.expiresAt, sql`now()`),
      ),
    )
    .returning({
      orgId: wsTickets.orgId,
      userId: wsTickets.userId,
      sessionId: wsTickets.sessionId,
    });
  return row ?? null;
}

/** Housekeeping: tickets live 30 s, keep them an hour for diagnostics. */
export async function purgeWsTickets(db: Db) {
  await db
    .delete(wsTickets)
    .where(
      or(
        lt(wsTickets.expiresAt, sql`now() - interval '1 hour'`),
        and(isNotNull(wsTickets.usedAt), lt(wsTickets.usedAt, sql`now() - interval '1 hour'`)),
      ),
    );
}
