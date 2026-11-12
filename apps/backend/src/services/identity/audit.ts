import { isIP } from 'node:net';
import { auditLogs, type DbOrTx } from '@crewhall/db';
import type { RequestInfo } from '../../http/types';
import { auditVia } from '../audit';

/** Identity audit actions; same append-only rules as services/audit.ts. */
export type IdentityAuditAction =
  | 'org.modules.update'
  | 'identity.policy.update'
  | 'identity.reauth'
  | 'identity.device_key.create'
  | 'identity.device_key.delete'
  | 'identity.provider.create'
  | 'identity.provider.update'
  | 'identity.provider.delete'
  | 'identity.provider.sync'
  | 'identity.sso.login'
  | 'identity.sso.login_failed'
  | 'identity.ldap.login'
  | 'identity.user.provision'
  | 'identity.user.link'
  | 'identity.user.suspend'
  | 'identity.user.reactivate'
  | 'identity.role.sync'
  | 'oidc.client.create'
  | 'oidc.client.update'
  | 'oidc.client.delete'
  | 'oidc.client.secret_rotate'
  | 'oidc.settings.update'
  | 'oidc.key.rotate'
  | 'oidc.login'
  | 'oidc.consent'
  | 'oidc.refresh_reuse'
  | 'oidc.logout'
  | 'backup.settings.update'
  | 'backup.start'
  | 'backup.tools_outdated'
  | 'compliance.policy.update'
  | 'compliance.hold.create'
  | 'compliance.hold.release'
  | 'compliance.export.create'
  | 'compliance.export.download'
  | 'compliance.dlp.blocked'
  | 'compliance.dlp.warned'
  | 'compliance.dlp.sent'
  | 'microsoft.app.update'
  | 'microsoft.integration.update'
  | 'microsoft.scim_token.create'
  | 'microsoft.scim_token.revoke'
  | 'microsoft.mount.create'
  | 'microsoft.mount.update'
  | 'microsoft.mount.delete'
  | 'microsoft.import.start'
  | 'microsoft.upload_request.create'
  | 'microsoft.upload_request.revoke'
  | 'microsoft.upload_request.upload'
  | 'microsoft.teams.link'
  | 'identity.scim.group';

export interface IdentityAuditEntry {
  orgId: string | null;
  actorId: string | null;
  action: IdentityAuditAction;
  targetType?: string;
  targetId?: string;
  meta?: Record<string, unknown>;
}

export async function identityAudit(
  db: DbOrTx,
  entry: IdentityAuditEntry,
  req?: Pick<RequestInfo, 'ip' | 'userAgent'> | null,
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
    via: auditVia.getStore() ?? null,
  });
}
