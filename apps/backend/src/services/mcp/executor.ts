import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { approvalRequests, idempotencyKeys, toolCalls } from '@crewhall/db';
import { MCP_LIMITS, type McpPolicy, type McpScope, type McpVia } from '@crewhall/shared';
import { z } from 'zod';
import type { Deps } from '../../deps';
import { AppError, localizedMessage } from '../../http/errors';
import type { MemberRow, OrgRow, RequestInfo } from '../../http/types';
import { auditVia } from '../audit';
import type { DriveActor } from '../drive/access';
import { reachableSpaceIds } from '../drive/access';
import { personalSpaceId } from '../spaces';
import { createApproval } from './approvals';
import { moduleOn } from './policy';
import { mcpAudit } from './audit';
import type { McpPrincipal } from './principal';
import { TOOL_BY_NAME, TOOLS } from './tools';
import { ToolError, type ToolContext, type ToolDef, type ToolOutcome } from './tools/types';

export interface CallContextInput {
  deps: Deps;
  principal: McpPrincipal;
  org: OrgRow;
  member: MemberRow;
  actor: DriveActor['actor'];
  policy: McpPolicy;
  scopes: McpScope[];
  req: RequestInfo;
  requestId: string;
}

export function makeContext(input: CallContextInput): ToolContext {
  const { deps, principal, org, member } = input;
  const a: DriveActor = { org, actor: input.actor, userId: principal.userId };
  const via: McpVia = {
    kind: principal.kind,
    name: principal.name,
    grantId: principal.grantId,
    tokenId: principal.tokenId,
  };
  let personal: Promise<string | null> | null = null;
  const ctx: ToolContext = {
    deps,
    a,
    member,
    principal,
    via,
    scopes: input.scopes,
    spaceIds: principal.spaceIds,
    policy: input.policy,
    req: input.req,
    requestId: input.requestId,
    assertSpace(spaceId) {
      if (principal.spaceIds !== null && !principal.spaceIds.includes(spaceId)) {
        throw new ToolError(
          'space_not_in_connection',
          'Bu bağlantı bu space ile sınırlı değil. Space eklemek için Hesabım › MCP ve API ekranını aç.',
        );
      }
    },
    async allowedSpaceIds() {
      const reachable = await reachableSpaceIds(deps.db, a);
      return principal.spaceIds === null
        ? reachable
        : reachable.filter((id) => principal.spaceIds!.includes(id));
    },
    personalSpaceId() {
      personal ??= personalSpaceId(deps.db, org.id, principal.userId).then((id) => id ?? null);
      return personal;
    },
    requestApproval: (approval) => createApproval(ctx, currentTool.get(ctx) ?? 'unknown', approval),
  };
  return ctx;
}

/** The tool running in a context, so requestApproval knows which tool asked. */
const currentTool = new WeakMap<ToolContext, string>();

type OrgModules = Parameters<typeof moduleOn>[0];

/** Tools of modules the org turned off do not exist for its connections. */
export const toolsOfOrg = (org: OrgModules) =>
  TOOLS.filter((t) => !t.module || moduleOn(org, t.module));

/** Tools this connection may see and call: scope ∩ policy ∩ org modules (vault never exists). */
export const visibleTools = (scopes: readonly McpScope[], org: OrgModules) =>
  toolsOfOrg(org).filter((t) => scopes.includes(t.scope));

/** Who knows the tool but lacks its scope: answered with 403 insufficient_scope. */
export function scopeProblem(name: string, scopes: readonly McpScope[], org: OrgModules) {
  const tool = toolsOfOrg(org).find((t) => t.name === name);
  if (!tool || scopes.includes(tool.scope)) return null;
  return tool;
}

const SECRET_KEY = /secret|password|token|authorization|api[_-]?key/i;
const LONG = 500;

/** Parameters for the activity log: secrets hidden, long strings and blobs cut. */
export function trimParams(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (SECRET_KEY.test(key)) return '[gizlendi]';
    if (key === 'content_base64') return `[${Math.floor((value.length * 3) / 4)} bayt]`;
    return value.length > LONG ? `${value.slice(0, LONG)}… (${value.length} karakter)` : value;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((v) => trimParams(v, key));
    return value.length > 20 ? [...head, `… +${value.length - 20}`] : head;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, trimParams(v, k)]),
    );
  }
  return value;
}

/** In-process concurrency per connection (doc 17 §13: 4 calls at once). */
const inFlight = new Map<string, number>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ToolError(
              'timeout',
              `Araç ${ms / 1000} saniyede bitmedi; daha küçük bir istekle dene.`,
            ),
          ),
        ms,
      );
    }),
  ]);
}

export interface CallResult {
  isError: boolean;
  data: Record<string, unknown>;
  /** Stored replay (Idempotency-Key). */
  replayed?: boolean;
}

function errorData(code: string, message: string, details?: Record<string, unknown>) {
  return { error: code, message, ...(details ? { details } : {}) };
}

function asToolError(err: unknown, locale: string | null): ToolError {
  if (err instanceof ToolError) return err;
  if (err instanceof AppError) {
    const details =
      err.details && typeof err.details === 'object'
        ? (err.details as Record<string, unknown>)
        : undefined;
    return new ToolError(err.code, localizedMessage(err.code, locale), details);
  }
  return new ToolError('internal', localizedMessage('internal', locale));
}

/**
 * Runs one tools/call: validation, idempotency, limits, the tool itself as the person
 * (audit rows carry `via`), then the tool_calls row and the org audit entry.
 */
export async function callTool(
  ctx: ToolContext,
  name: string,
  args: unknown,
  idempotencyKey: string | null,
): Promise<CallResult> {
  const tool = TOOL_BY_NAME.get(name);
  if (
    !tool ||
    !ctx.scopes.includes(tool.scope) ||
    (tool.module && !moduleOn(ctx.a.org, tool.module))
  ) {
    return { isError: true, data: errorData('unknown_tool', `Bilinmeyen araç: ${name}`) };
  }
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      isError: true,
      data: errorData('validation_failed', z.prettifyError(parsed.error)),
    };
  }

  const { db } = ctx.deps;
  // Idempotency-Key: a retried write returns the first answer instead of running twice.
  let idemWhere: ReturnType<typeof and> | undefined;
  if (tool.write && idempotencyKey) {
    const path = `/mcp#${tool.name}`;
    const requestHash = createHash('sha256')
      .update(`${path}\n${JSON.stringify(parsed.data)}`)
      .digest('hex');
    idemWhere = and(
      eq(idempotencyKeys.userId, ctx.a.userId),
      eq(idempotencyKeys.key, idempotencyKey),
    );
    const [existing] = await db.select().from(idempotencyKeys).where(idemWhere);
    if (existing && Date.now() - existing.createdAt.getTime() < 24 * 60 * 60 * 1000) {
      if (existing.requestHash !== requestHash) {
        return {
          isError: true,
          data: errorData(
            'idempotency_key_reused',
            localizedMessage('idempotency_key_reused', ctx.req.locale),
          ),
        };
      }
      if (existing.status !== null) {
        return { ...(existing.response as CallResult), replayed: true };
      }
      return { isError: true, data: errorData('conflict', 'Aynı istek hâlâ çalışıyor.') };
    }
    if (existing) await db.delete(idempotencyKeys).where(idemWhere);
    await db
      .insert(idempotencyKeys)
      .values({ userId: ctx.a.userId, key: idempotencyKey, method: 'MCP', path, requestHash })
      .onConflictDoNothing();
  }

  const slot = ctx.principal.grantId ?? ctx.principal.tokenId!;
  const busy = inFlight.get(slot) ?? 0;
  if (busy >= MCP_LIMITS.concurrentCallsPerGrant) {
    if (idemWhere) await db.delete(idempotencyKeys).where(idemWhere);
    return {
      isError: true,
      data: errorData(
        'rate_limited',
        'Bu bağlantıda aynı anda en çok 4 çağrı çalışır; birazdan yeniden dene.',
      ),
    };
  }
  inFlight.set(slot, busy + 1);

  const started = performance.now();
  let outcome: ToolOutcome | null = null;
  let failure: ToolError | null = null;
  currentTool.set(ctx, tool.name);
  const viaInfo = {
    kind: 'mcp',
    client: ctx.principal.name,
    grant: ctx.principal.grantId,
    token: ctx.principal.tokenId,
  };
  try {
    outcome = await auditVia.run(viaInfo, () =>
      withTimeout(tool.run(ctx, parsed.data), MCP_LIMITS.toolTimeoutMs),
    );
  } catch (err) {
    failure = asToolError(err, ctx.req.locale);
    if (failure.code === 'internal')
      ctx.deps.logger.error({ err, tool: tool.name }, 'mcp tool failed');
  } finally {
    inFlight.set(slot, (inFlight.get(slot) ?? 1) - 1);
  }

  let data = outcome?.data ?? errorData(failure!.code, failure!.message, failure!.details);
  if (outcome && Buffer.byteLength(JSON.stringify(data)) > MCP_LIMITS.responseBytes) {
    failure = new ToolError(
      'response_too_large',
      'Yanıt 256 KB sınırını aşıyor; limit ya da cursor ile daha küçük sayfalar iste.',
    );
    data = errorData(failure.code, failure.message);
    outcome = null;
  }
  const result = outcome?.approvalId ? 'pending_approval' : failure ? 'error' : 'ok';
  const [row] = await db
    .insert(toolCalls)
    .values({
      orgId: ctx.a.org.id,
      userId: ctx.a.userId,
      viaGrantId: ctx.principal.grantId,
      viaTokenId: ctx.principal.tokenId,
      viaName: ctx.principal.name,
      tool: tool.name,
      write: tool.write,
      params: trimParams(parsed.data) as Record<string, unknown>,
      targetType: outcome?.target?.type ?? null,
      targetId: outcome?.target?.id ?? null,
      targetLabel: outcome?.target?.label ?? null,
      result,
      errorCode: failure?.code ?? null,
      summary: outcome?.summary ?? null,
      approvalId: outcome?.approvalId ?? null,
      undo: outcome?.undo ?? null,
      requestId: ctx.requestId,
      durationMs: Math.round(performance.now() - started),
      ip: ctx.req.ip,
    })
    .returning({ id: toolCalls.id });
  if (outcome?.approvalId) {
    await db
      .update(approvalRequests)
      .set({ toolCallId: row!.id })
      .where(eq(approvalRequests.id, outcome.approvalId));
  }
  await mcpAudit(
    db,
    {
      orgId: ctx.a.org.id,
      actorId: ctx.a.userId,
      action: 'mcp.tool.call',
      targetType: outcome?.target?.type ?? 'tool',
      targetId: outcome?.target?.id ?? tool.name,
      meta: { tool: tool.name, result, errorCode: failure?.code ?? null, toolCall: row!.id },
      via: viaInfo,
    },
    ctx.req,
  );

  const callResult: CallResult = { isError: failure !== null, data };
  if (idemWhere) {
    if (failure && failure.code === 'internal') await db.delete(idempotencyKeys).where(idemWhere);
    else {
      await db.update(idempotencyKeys).set({ status: 200, response: callResult }).where(idemWhere);
    }
  }
  return callResult;
}

export type { ToolDef };
