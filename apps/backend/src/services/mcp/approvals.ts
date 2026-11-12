import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  approvalRequests,
  nodes,
  notifications,
  organizations,
  portalSites,
  toolCalls,
  users,
  type DbOrTx,
  type ToolCallUndo,
} from '@crewhall/db';
import { resolveLocale } from '@crewhall/i18n';
import {
  MCP_LIMITS,
  type ApprovalAction,
  type ApprovalDetail,
  type ApprovalRule,
  type ApprovalStatus,
  type ApprovalSummary,
  type McpPolicy,
  paths,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { AuthSession } from '../../http/types';
import type { JobDeps } from '../../jobs/handlers';
import type { PresenceReader, PresenceTracker } from '../../realtime/presence';
import { AI_APPLIERS } from '../ai/actions';
import { deliverMessage } from './chat-send';
import { rawChanges } from '../portal/changes';
import { publish } from '../portal/publish';
import { auditVia } from '../audit';
import { mailBrandForOrg } from '../brand';
import type { DriveActor } from '../drive/access';
import * as tree from '../drive/nodes';
import { toActor } from '../membership';
import { activeOrgMember } from '../spaces';
import { notify } from '../notifications/notify';
import { mcpAudit } from './audit';
import { approvalMail } from './mail';
import { isFresh, requireFresh } from './reauth';
import type { ApprovalRequestInput, ToolContext, ToolOutcome } from './tools/types';
import { applyPluginTool } from '../plugins/tools';

type ApprovalRow = typeof approvalRequests.$inferSelect;

/**
 * requiresApproval(action, size, policy) (doc 17 §13): publishing, trash, 20+ items and
 * external links always; space chat messages when the org turned that rule on.
 */
export function requiresApproval(
  action: ApprovalAction | 'write',
  size: number,
  policy: Pick<McpPolicy, 'approvalRules'>,
): boolean {
  const rules = new Set<ApprovalRule>(policy.approvalRules);
  if (size > 20) return true;
  switch (action) {
    case 'portal.publish':
    case 'node.trash':
    case 'bulk':
    case 'share.external':
      return true;
    case 'chat.space_message':
      return rules.has('chat_space_message');
    default:
      return false;
  }
}

const payloadHash = (payload: Record<string, unknown>) =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex');

export const approvalUrl = (hubUrl: string, id: string) => `${hubUrl}${paths.accountApproval(id)}`;

/** Called through ToolContext.requestApproval; the executor links the tool call. */
export async function createApproval(
  ctx: ToolContext,
  tool: string,
  input: ApprovalRequestInput,
): Promise<ToolOutcome> {
  const { db, env } = ctx.deps;
  const expiresAt = new Date(Date.now() + MCP_LIMITS.approvalTtlHours * 60 * 60 * 1000);
  const [row] = await db
    .insert(approvalRequests)
    .values({
      orgId: ctx.a.org.id,
      userId: ctx.a.userId,
      viaGrantId: ctx.principal.grantId,
      viaTokenId: ctx.principal.tokenId,
      viaName: ctx.principal.name,
      action: input.action,
      tool,
      payload: input.payload,
      payloadHash: payloadHash(input.payload),
      preview: { title: input.title, target: input.target, items: input.items },
      targetRevs: input.targetRevs,
      clientNote: input.clientNote?.slice(0, 1000) ?? null,
      expiresAt,
    })
    .returning();
  const approval = row!;
  await mcpAudit(db, {
    orgId: ctx.a.org.id,
    actorId: ctx.a.userId,
    action: 'mcp.approval.request',
    targetType: 'approval_request',
    targetId: approval.id,
    meta: { tool, action: input.action, items: input.items.length },
  });
  const url = approvalUrl(env.HUB_URL, approval.id);
  // Bell and push (the phone opens the approval), as the person's preferences allow.
  await notify(ctx.deps, [
    {
      orgId: ctx.a.org.id,
      userId: ctx.a.userId,
      type: 'approval.requested',
      category: 'alert',
      actorId: null,
      target: { type: 'approval', id: approval.id },
      data: {
        client: ctx.principal.name,
        title: input.title,
        excerpt: input.target ?? input.title,
        count: input.items.length,
      },
      url: paths.accountApproval(approval.id),
    },
  ]).catch((err: unknown) => ctx.deps.logger.warn({ err }, 'approval notification failed'));
  if (await ctx.deps.mailer.enabledFor(ctx.a.org.id)) {
    const [user] = await db
      .select({ email: users.email, locale: users.locale })
      .from(users)
      .where(eq(users.id, ctx.a.userId));
    if (user) {
      const brand = await mailBrandForOrg(db, env.HUB_URL, ctx.a.org.id);
      const mail = approvalMail(brand, {
        locale: resolveLocale(user.locale),
        client: ctx.principal.name,
        title: input.title,
        itemCount: input.items.length,
        expiresAt,
        url,
      });
      await ctx.deps.mailer
        .send({ orgId: ctx.a.org.id, to: user.email, fromName: brand.branding.orgName, ...mail })
        .catch((err) => ctx.deps.logger.warn({ err }, 'approval mail failed'));
    }
  }
  return {
    approvalId: approval.id,
    data: {
      status: 'pending_approval',
      approval_id: approval.id,
      url,
      expires_at: expiresAt.toISOString(),
      message:
        'Bu işlem insan onayı bekliyor. Kişiye Crewhall › Onay bekleyenler ekranından gözden geçirmesini söyle; sonucu get_approval ile görebilirsin.',
    },
    target: { type: 'approval', id: approval.id, label: input.target ?? input.title },
    summary: input.target ?? input.title,
  };
}

// ---- revisions and staleness ----------------------------------------------------------

/** Current revisions of an approval's targets, per tool. */
async function currentRevs(db: DbOrTx, row: ApprovalRow): Promise<Record<string, string>> {
  const ids = Object.keys(row.targetRevs);
  if (ids.length === 0) return {};
  if (row.tool === 'trash_nodes') {
    const rows = await db
      .select({ id: nodes.id, updatedAt: nodes.updatedAt, deletedAt: nodes.deletedAt })
      .from(nodes)
      .where(inArray(nodes.id, ids));
    return Object.fromEntries(
      rows.filter((r) => !r.deletedAt).map((r) => [r.id, r.updatedAt.toISOString()]),
    );
  }
  if (row.tool === 'request_portal_publish') {
    const [site] = await db
      .select()
      .from(portalSites)
      .where(eq(portalSites.id, String(row.payload.site_id)));
    if (!site) return {};
    const changes = await rawChanges(db, site);
    return Object.fromEntries(changes.map((c) => [c.key, c.changedAt.toISOString()]));
  }
  return row.targetRevs;
}

async function isStale(db: DbOrTx, row: ApprovalRow) {
  const now = await currentRevs(db, row);
  return Object.entries(row.targetRevs).some(([id, rev]) => now[id] !== rev);
}

/** Lazy housekeeping: pending requests past their life become expired. */
export async function expireApprovals(db: DbOrTx, userId?: string) {
  const rows = await db
    .update(approvalRequests)
    .set({ status: 'expired', errorCode: 'expired' })
    .where(
      and(
        eq(approvalRequests.status, 'pending'),
        lt(approvalRequests.expiresAt, new Date()),
        userId ? eq(approvalRequests.userId, userId) : undefined,
      ),
    )
    .returning({ id: approvalRequests.id, toolCallId: approvalRequests.toolCallId });
  await settleToolCalls(db, rows, 'error', 'expired');
  await closeNotices(
    db,
    rows.map((r) => r.id),
  );
}

/** A request that is no longer pending leaves the bell: its notification counts as read. */
async function closeNotices(db: DbOrTx, approvalIds: string[]) {
  if (!approvalIds.length) return;
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.type, 'approval.requested'),
        inArray(notifications.targetId, approvalIds),
        isNull(notifications.readAt),
      ),
    );
}

async function settleToolCalls(
  db: DbOrTx,
  rows: { toolCallId: number | null }[],
  result: 'ok' | 'error',
  errorCode: string | null,
  undo?: ToolCallUndo,
) {
  const ids = rows.map((r) => r.toolCallId).filter((x): x is number => x !== null);
  if (ids.length === 0) return;
  await db
    .update(toolCalls)
    .set({ result, errorCode, ...(undo ? { undo } : {}) })
    .where(inArray(toolCalls.id, ids));
}

// ---- reading -----------------------------------------------------------------------------

const via = (r: ApprovalRow) => ({
  kind: r.viaGrantId ? ('oauth' as const) : ('token' as const),
  name: r.viaName,
  grantId: r.viaGrantId,
  tokenId: r.viaTokenId,
});

function toSummary(r: ApprovalRow): ApprovalSummary {
  return {
    id: r.id,
    action: r.action as ApprovalAction,
    tool: r.tool,
    title: r.preview.title,
    target: r.preview.target,
    itemCount: r.preview.items.length,
    via: via(r),
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
  };
}

export async function listApprovals(
  db: DbOrTx,
  orgId: string,
  userId: string,
  q: { status: 'pending' | 'history'; cursor?: string | undefined; limit: number },
) {
  await expireApprovals(db, userId);
  const offset = Number(q.cursor ?? 0) || 0;
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.orgId, orgId),
        eq(approvalRequests.userId, userId),
        q.status === 'pending'
          ? eq(approvalRequests.status, 'pending')
          : ne(approvalRequests.status, 'pending'),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(q.limit + 1)
    .offset(offset);
  return {
    items: rows.slice(0, q.limit).map(toSummary),
    nextCursor: rows.length > q.limit ? String(offset + q.limit) : null,
  };
}

async function ownApproval(db: DbOrTx, orgId: string, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.id, id),
        eq(approvalRequests.orgId, orgId),
        eq(approvalRequests.userId, userId),
      ),
    );
  if (!row) throw new AppError('not_found');
  return row;
}

async function markStale(db: DbOrTx, row: ApprovalRow) {
  await db
    .update(approvalRequests)
    .set({ status: 'stale', errorCode: 'stale' })
    .where(and(eq(approvalRequests.id, row.id), eq(approvalRequests.status, 'pending')));
  await settleToolCalls(db, [row], 'error', 'stale');
  await closeNotices(db, [row.id]);
}

export async function approvalDetail(
  deps: Pick<Deps, 'db'>,
  ctx: { orgId: string; userId: string; session: AuthSession },
  id: string,
): Promise<ApprovalDetail> {
  const { db } = deps;
  await expireApprovals(db, ctx.userId);
  let row = await ownApproval(db, ctx.orgId, ctx.userId, id);
  // The target changed while waiting: the request asks again (18.7 "eskidi").
  if (row.status === 'pending' && (await isStale(db, row))) {
    await markStale(db, row);
    row = await ownApproval(db, ctx.orgId, ctx.userId, id);
  }
  let decidedBy: ApprovalDetail['decidedBy'] = null;
  if (row.decidedBy) {
    const [u] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, row.decidedBy));
    decidedBy = u ?? null;
  }
  return {
    ...toSummary(row),
    clientNote: row.clientNote,
    items: row.preview.items,
    payload: row.payload,
    decidedBy,
    errorCode: row.errorCode,
    needsReauth: row.status === 'pending' && !(await isFresh(deps, ctx.session)),
    result: row.status === 'applied' ? (row.result ?? null) : null,
  };
}

export async function pendingCount(db: DbOrTx, userId: string) {
  await expireApprovals(db, userId);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.userId, userId), eq(approvalRequests.status, 'pending')));
  return row?.n ?? 0;
}

// ---- deciding ------------------------------------------------------------------------------

export async function approve(
  deps: Deps,
  ctx: { orgId: string; userId: string; session: AuthSession },
  id: string,
) {
  const { db } = deps;
  await expireApprovals(db, ctx.userId);
  const row = await ownApproval(db, ctx.orgId, ctx.userId, id);
  if (row.status !== 'pending') throw new AppError('mcp_approval_closed', { status: row.status });
  await requireFresh(deps, ctx.session);
  if (await isStale(db, row)) {
    await markStale(db, row);
    throw new AppError('mcp_approval_closed', { status: 'stale' });
  }
  const [updated] = await db
    .update(approvalRequests)
    .set({ status: 'approved', decidedBy: ctx.userId, decidedAt: new Date() })
    .where(and(eq(approvalRequests.id, row.id), eq(approvalRequests.status, 'pending')))
    .returning();
  if (!updated) throw new AppError('mcp_approval_closed');
  await mcpAudit(db, {
    orgId: ctx.orgId,
    actorId: ctx.userId,
    action: 'mcp.approval.approve',
    targetType: 'approval_request',
    targetId: row.id,
    meta: { tool: row.tool, payloadHash: row.payloadHash },
  });
  await closeNotices(db, [row.id]);
  await deps.jobs.send('approval.apply', { approvalId: row.id });
  return approvalDetail(deps, ctx, id);
}

export async function reject(
  deps: Deps,
  ctx: { orgId: string; userId: string; session: AuthSession },
  id: string,
  reason: string | undefined,
) {
  const { db } = deps;
  const row = await ownApproval(db, ctx.orgId, ctx.userId, id);
  if (row.status !== 'pending') throw new AppError('mcp_approval_closed', { status: row.status });
  await db
    .update(approvalRequests)
    .set({
      status: 'rejected',
      decidedBy: ctx.userId,
      decidedAt: new Date(),
      rejectReason: reason ?? null,
      errorCode: 'rejected',
    })
    .where(eq(approvalRequests.id, row.id));
  await settleToolCalls(db, [row], 'error', 'rejected');
  await mcpAudit(db, {
    orgId: ctx.orgId,
    actorId: ctx.userId,
    action: 'mcp.approval.reject',
    targetType: 'approval_request',
    targetId: row.id,
    meta: { tool: row.tool },
  });
  await closeNotices(db, [row.id]);
  return approvalDetail(deps, ctx, id);
}

// ---- applying (worker job approval.apply) ----------------------------------------------

interface ApplyResult {
  result: Record<string, unknown>;
  undo?: ToolCallUndo;
}

/** The same service call the tool would have made, on the frozen payload. */
const APPLY: Record<
  string,
  (
    live: Deps,
    a: DriveActor,
    payload: Record<string, unknown>,
    via: Record<string, unknown>,
  ) => Promise<ApplyResult>
> = {
  async trash_nodes(live, a, payload) {
    const ids = payload.node_ids as string[];
    const trashed = await live.db.transaction((tx) => tree.trashNodes(tx, a, ids));
    return {
      result: { trashed: trashed.map((n) => n.id) },
      undo: {
        kind: 'restore_nodes',
        nodeIds: ids,
        revs: Object.fromEntries(trashed.map((n) => [n.id, n.updatedAt])),
      },
    };
  },
  async request_portal_publish(live, a, payload) {
    const out = await publish(
      live,
      a,
      String(payload.site_id),
      { keys: payload.keys as string[], note: (payload.note as string | null) ?? null },
      { ip: null, userAgent: 'mcp', locale: null },
    );
    return { result: { publish_id: out.id, number: out.number } };
  },
  async send_message(live, a, payload, via) {
    const input = payload as { conversation_id: string; text: string; reply_to_id?: string };
    const { msg, rev } = await deliverMessage(live, a, input, via);
    return {
      result: { message_id: msg.id, conversation_id: msg.conversationId },
      undo: { kind: 'delete_message', messageId: msg.id, revs: { [msg.id]: rev } },
    };
  }, // Actions proposed by the AI assistant (yol haritası #18, services/ai/actions.ts).
  ...AI_APPLIERS,
};

/**
 * The worker has no WebSocket connections, so nobody counts as online there: @here reaches
 * no one and notifications fall back to push, as for anyone away.
 */
const NOBODY_ONLINE: PresenceReader = {
  hasFocusedSession: () => false,
  isConnected: () => false,
  onlineUserIds: () => [],
};

/** Service deps for applying in the worker (no auth, no live presence there). */
function liveDeps(deps: JobDeps): Deps {
  return {
    ...deps,
    auth: undefined as never,
    setupToken: null,
    presence: NOBODY_ONLINE as PresenceTracker,
  };
}

export async function applyApproval(deps: JobDeps, approvalId: string) {
  const { db, logger } = deps;
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, approvalId));
  if (!row || row.status !== 'approved') return;
  const fail = async (code: string) => {
    await db
      .update(approvalRequests)
      .set({ status: code === 'stale' ? 'stale' : 'failed', errorCode: code })
      .where(eq(approvalRequests.id, row.id));
    await settleToolCalls(db, [row], 'error', code);
  };
  if (await isStale(db, row)) return fail('stale');
  const apply =
    APPLY[row.tool] ??
    (row.action === 'plugin.tool'
      ? (live: Deps, actor: DriveActor, payload: Record<string, unknown>): Promise<ApplyResult> =>
          applyPluginTool(live, actor, payload)
      : undefined);
  if (!apply) return fail('unsupported');
  const [org] = await db.select().from(organizations).where(eq(organizations.id, row.orgId));
  const member = org ? await activeOrgMember(db, row.orgId, row.userId) : null;
  if (!org || !member) return fail('forbidden');
  const a: DriveActor = { org, actor: toActor(member), userId: row.userId };
  const viaInfo = {
    kind: row.action === 'ai.action' ? 'ai' : 'mcp',
    client: row.viaName,
    grant: row.viaGrantId,
    token: row.viaTokenId,
  };
  try {
    const out = await auditVia.run(viaInfo, () => apply(liveDeps(deps), a, row.payload, viaInfo));
    await db
      .update(approvalRequests)
      .set({ status: 'applied', result: out.result, errorCode: null })
      .where(eq(approvalRequests.id, row.id));
    await settleToolCalls(db, [row], 'ok', null, out.undo);
    await mcpAudit(db, {
      orgId: row.orgId,
      actorId: row.userId,
      action: 'mcp.approval.apply',
      targetType: 'approval_request',
      targetId: row.id,
      meta: { tool: row.tool, result: out.result },
      via: viaInfo,
    });
  } catch (err) {
    const code = err instanceof AppError ? err.code : 'internal';
    if (!(err instanceof AppError)) logger.error({ err, approvalId }, 'approval apply failed');
    await fail(code);
  }
}

export type { ApprovalStatus };
