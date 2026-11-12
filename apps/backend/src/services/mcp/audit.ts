import { isIP } from 'node:net';
import { auditLogs, type DbOrTx } from '@crewhall/db';
import type { RequestInfo } from '../../http/types';
import { auditVia } from '../audit';

/** MCP audit actions; written with the same append-only rules as services/audit.ts. */
export type McpAuditAction =
  | 'mcp.client.register'
  | 'mcp.client.update'
  | 'mcp.grant.create'
  | 'mcp.grant.update'
  | 'mcp.grant.revoke'
  | 'mcp.grant.refresh_reuse'
  | 'mcp.token.create'
  | 'mcp.token.revoke'
  | 'mcp.policy.update'
  | 'mcp.tool.call'
  | 'mcp.approval.request'
  | 'mcp.approval.approve'
  | 'mcp.approval.reject'
  | 'mcp.approval.apply'
  | 'mcp.tool_call.undo';

export interface McpAuditEntry {
  orgId: string | null;
  actorId: string | null;
  action: McpAuditAction;
  targetType?: string;
  targetId?: string;
  meta?: Record<string, unknown>;
  /** Overrides the ambient via (auditVia). */
  via?: Record<string, unknown> | null;
}

export async function mcpAudit(
  db: DbOrTx,
  entry: McpAuditEntry,
  req?: Pick<RequestInfo, 'ip' | 'userAgent'>,
) {
  const ip = req?.ip && isIP(req.ip) ? req.ip : null;
  await db.insert(auditLogs).values({
    orgId: entry.orgId,
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    meta: entry.meta ?? {},
    ip,
    userAgent: req?.userAgent ?? null,
    via: entry.via === undefined ? (auditVia.getStore() ?? null) : entry.via,
  });
}
