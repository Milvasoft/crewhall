import { isIP } from 'node:net';
import { auditLogs, type DbOrTx } from '@crewhall/db';
import type { RequestInfo } from '../../http/types';
import { auditVia } from '../audit';

/** AI audit actions; same append-only rules as services/audit.ts. */
export type AiAuditAction =
  'ai.settings.update' | 'ai.run' | 'ai.suggestion.accept' | 'ai.action.propose';

export interface AiAuditEntry {
  orgId: string;
  actorId: string | null;
  action: AiAuditAction;
  targetType?: string | null;
  targetId?: string | null;
  meta?: Record<string, unknown>;
  /**
   * "AI ile": rows about model output carry `{ kind: 'ai', provider, model, runId }` (doc 17 §13
   * `via`, like MCP and API tokens).
   */
  via?: Record<string, unknown>;
}

export async function aiAudit(
  db: DbOrTx,
  entry: AiAuditEntry,
  req?: Pick<RequestInfo, 'ip' | 'userAgent'> | null,
) {
  const ip = req?.ip && isIP(req.ip) ? req.ip : null;
  const outer = auditVia.getStore();
  await db.insert(auditLogs).values({
    orgId: entry.orgId,
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    meta: entry.meta ?? {},
    ip,
    userAgent: req?.userAgent ?? null,
    via: entry.via ? { ...entry.via, ...(outer ? { outer } : {}) } : (outer ?? null),
  });
}
