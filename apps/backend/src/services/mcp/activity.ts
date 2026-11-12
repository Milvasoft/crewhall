import { and, desc, eq, gte, ilike, inArray, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  approvalRequests,
  messages,
  portalDocs,
  portalPosts,
  nodes,
  surfaceCards,
  toolCalls,
  type DbOrTx,
  type ToolCallUndo,
} from '@crewhall/db';
import { MCP_LIMITS, type EndpointName, type ToolCall } from '@crewhall/shared';
import { z } from 'zod';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { DriveActor } from '../drive/access';
import * as tree from '../drive/nodes';
import * as quick from '../quick/surfaces';
import { deleteMessage } from '../chat/messages';
import { deleteDoc } from '../portal/docs';
import { deletePost } from '../portal/posts';
import { auditVia } from '../audit';
import { mcpAudit } from './audit';
import { callOperation, personPrincipal } from './bridge';

type ToolCallRow = typeof toolCalls.$inferSelect;

const UNDO_MS = MCP_LIMITS.undoDays * 24 * 60 * 60 * 1000;

const undoable = (r: ToolCallRow) =>
  r.result === 'ok' &&
  r.undo !== null &&
  r.undoneAt === null &&
  Date.now() - r.createdAt.getTime() < UNDO_MS;

export async function toToolCall(
  db: DbOrTx,
  r: ToolCallRow,
  approvals?: Map<string, string>,
): Promise<ToolCall> {
  let approvalStatus: string | null = null;
  if (r.approvalId) {
    if (approvals) approvalStatus = approvals.get(r.approvalId) ?? null;
    else {
      const [a] = await db
        .select({ status: approvalRequests.status })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, r.approvalId));
      approvalStatus = a?.status ?? null;
    }
  }
  return {
    id: String(r.id),
    tool: r.tool,
    via: {
      kind: r.viaGrantId ? 'oauth' : 'token',
      name: r.viaName,
      grantId: r.viaGrantId,
      tokenId: r.viaTokenId,
    },
    params: r.params,
    target: r.targetType ? { type: r.targetType, id: r.targetId, label: r.targetLabel } : null,
    result: r.result,
    errorCode: r.errorCode,
    summary: r.summary,
    approvalId: r.approvalId,
    approvalStatus,
    canUndo: undoable(r),
    undoneAt: r.undoneAt?.toISOString() ?? null,
    write: r.write,
    requestId: r.requestId,
    durationMs: r.durationMs,
    ip: r.ip,
    at: r.createdAt.toISOString(),
  };
}

export async function listActivity(
  db: DbOrTx,
  orgId: string,
  userId: string,
  q: {
    filter: 'all' | 'write' | 'pending' | 'error' | 'undone';
    grantId?: string | undefined;
    tokenId?: string | undefined;
    q?: string | undefined;
    hours: number;
    cursor?: string | undefined;
    limit: number;
  },
) {
  const conds: (SQL | undefined)[] = [
    eq(toolCalls.orgId, orgId),
    eq(toolCalls.userId, userId),
    gte(toolCalls.createdAt, new Date(Date.now() - q.hours * 60 * 60 * 1000)),
  ];
  if (q.filter === 'write') conds.push(eq(toolCalls.write, true));
  if (q.filter === 'pending') conds.push(eq(toolCalls.result, 'pending_approval'));
  if (q.filter === 'error') conds.push(eq(toolCalls.result, 'error'));
  if (q.filter === 'undone') conds.push(isNotNull(toolCalls.undoneAt));
  if (q.grantId) conds.push(eq(toolCalls.viaGrantId, q.grantId));
  if (q.tokenId) conds.push(eq(toolCalls.viaTokenId, q.tokenId));
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    conds.push(or(ilike(toolCalls.tool, like), ilike(toolCalls.targetLabel, like)));
  }
  if (q.cursor) {
    const before = Number(q.cursor);
    if (!Number.isSafeInteger(before))
      throw new AppError('bad_request', { reason: 'invalid_cursor' });
    conds.push(lt(toolCalls.id, before));
  }
  const rows = await db
    .select()
    .from(toolCalls)
    .where(and(...conds))
    .orderBy(desc(toolCalls.id))
    .limit(q.limit + 1);
  const pageRows = rows.slice(0, q.limit);
  const approvalIds = pageRows.map((r) => r.approvalId).filter((x): x is string => !!x);
  const statuses = approvalIds.length
    ? await db
        .select({ id: approvalRequests.id, status: approvalRequests.status })
        .from(approvalRequests)
        .where(inArray(approvalRequests.id, approvalIds))
    : [];
  const map = new Map(statuses.map((s) => [s.id, s.status as string]));
  return {
    items: await Promise.all(pageRows.map((r) => toToolCall(db, r, map))),
    nextCursor: rows.length > q.limit ? String(pageRows[pageRows.length - 1]!.id) : null,
  };
}

export async function todayStats(db: DbOrTx, userId: string) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const [row] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      writes: sql<number>`count(*) filter (where ${toolCalls.write})::int`,
      errors: sql<number>`count(*) filter (where ${toolCalls.result} = 'error')::int`,
    })
    .from(toolCalls)
    .where(and(eq(toolCalls.userId, userId), gte(toolCalls.createdAt, start)));
  return row ?? { calls: 0, writes: 0, errors: 0 };
}

/** Did anyone change the target after the call? Then undo goes through version history. */
async function stillAsLeft(db: DbOrTx, undo: ToolCallUndo) {
  const revs = undo.revs ?? {};
  const ids = Object.keys(revs);
  if (ids.length === 0) return true;
  if (undo.kind === 'trash_nodes' || undo.kind === 'restore_nodes') {
    const rows = await db
      .select({ id: nodes.id, updatedAt: nodes.updatedAt })
      .from(nodes)
      .where(inArray(nodes.id, ids));
    const now = new Map(rows.map((r) => [r.id, r.updatedAt.toISOString()]));
    return ids.every((id) => now.get(id) === revs[id]);
  }
  if (undo.kind === 'delete_portal_doc' || undo.kind === 'delete_portal_post') {
    // Someone (or a later call) edited the draft: it is theirs now, undo goes by hand.
    const table = undo.kind === 'delete_portal_doc' ? portalDocs : portalPosts;
    const rows = await db
      .select({ id: table.id, rev: table.rev, deletedAt: table.deletedAt })
      .from(table)
      .where(inArray(table.id, ids));
    return (
      rows.length === ids.length && rows.every((r) => !r.deletedAt && String(r.rev) === revs[r.id])
    );
  }
  if (undo.kind === 'delete_message') {
    const rows = await db
      .select({ id: messages.id, updatedAt: messages.updatedAt, deletedAt: messages.deletedAt })
      .from(messages)
      .where(inArray(messages.id, ids));
    // An edit or a reaction from someone else changes updated_at: undo then goes by hand.
    return (
      rows.length === ids.length &&
      rows.every((r) => !r.deletedAt && r.updatedAt.toISOString() === revs[r.id])
    );
  }
  const rows = await db
    .select({ id: surfaceCards.id, updatedAt: surfaceCards.updatedAt })
    .from(surfaceCards)
    .where(inArray(surfaceCards.id, ids));
  const now = new Map(rows.map((r) => [r.id, r.updatedAt.toISOString()]));
  return ids.every((id) => now.get(id) === revs[id]);
}

export const CallNo = z.coerce.number().int().positive();

/** "Geri al" (18.6): the reverse of a write, within 7 days, as the person. */
export async function undoToolCall(deps: Deps, a: DriveActor, callNo: string) {
  const { db } = deps;
  const parsed = CallNo.safeParse(callNo);
  if (!parsed.success) throw new AppError('not_found');
  const [row] = await db
    .select()
    .from(toolCalls)
    .where(
      and(
        eq(toolCalls.id, parsed.data),
        eq(toolCalls.orgId, a.org.id),
        eq(toolCalls.userId, a.userId),
      ),
    );
  if (!row) throw new AppError('not_found');
  if (!undoable(row) || !row.undo) throw new AppError('mcp_undo_unavailable');
  const undo = row.undo;
  if (!(await stillAsLeft(db, undo))) throw new AppError('mcp_undo_stale');
  if (undo.kind === 'delete_portal_doc' || undo.kind === 'delete_portal_post') {
    const req = { ip: null, userAgent: 'mcp', locale: null };
    await auditVia.run({ kind: 'mcp_undo', toolCall: row.id }, () =>
      undo.kind === 'delete_portal_doc'
        ? deleteDoc(db, a, undo.docId!, req)
        : deletePost(db, a, undo.postId!, req),
    );
    await db.update(toolCalls).set({ undoneAt: new Date() }).where(eq(toolCalls.id, row.id));
  } else if (undo.kind === 'api_call') {
    // The reverse operation, through the router as the person (tools/api.ts).
    const via = { kind: 'mcp_undo', toolCall: row.id };
    await auditVia.run(via, () =>
      callOperation(
        deps,
        {
          principal: personPrincipal({ userId: a.userId, orgId: a.org.id, name: row.viaName }),
          via,
          locale: null,
          ip: null,
        },
        undo.operation as EndpointName,
        { params: undo.params ?? {}, body: undo.body },
      ),
    );
    await db.update(toolCalls).set({ undoneAt: new Date() }).where(eq(toolCalls.id, row.id));
  } else if (undo.kind === 'delete_message') {
    // Chat deletes in its own transaction and tells the open clients (WS).
    await auditVia.run({ kind: 'mcp_undo', toolCall: row.id }, () =>
      deleteMessage(deps, a, undo.messageId!),
    );
    await db.update(toolCalls).set({ undoneAt: new Date() }).where(eq(toolCalls.id, row.id));
  } else
    await auditVia.run({ kind: 'mcp_undo', toolCall: row.id }, () =>
      db.transaction(async (tx) => {
        switch (undo.kind) {
          case 'trash_nodes':
            await tree.trashNodes(tx, a, undo.nodeIds ?? []);
            break;
          case 'restore_nodes':
            await tree.restoreNodes(tx, a, undo.nodeIds ?? []);
            break;
          case 'delete_card':
            await quick.deleteCard(tx, a, undo.cardId!);
            break;
          case 'remove_group_link':
            await quick.removeGroupLink(tx, a, undo.cardId!, undo.itemId!);
            break;
          case 'delete_message':
          case 'api_call':
          case 'delete_portal_doc':
          case 'delete_portal_post':
            break;
        }
        await tx.update(toolCalls).set({ undoneAt: new Date() }).where(eq(toolCalls.id, row.id));
      }),
    );
  await mcpAudit(db, {
    orgId: a.org.id,
    actorId: a.userId,
    action: 'mcp.tool_call.undo',
    targetType: 'tool_call',
    targetId: String(row.id),
    meta: { tool: row.tool, kind: undo.kind },
  });
  const [fresh] = await db.select().from(toolCalls).where(eq(toolCalls.id, row.id));
  return toToolCall(db, fresh!);
}
