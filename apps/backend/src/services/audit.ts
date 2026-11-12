import { AsyncLocalStorage } from 'node:async_hooks';
import { isIP } from 'node:net';
import { auditLogs, type DbOrTx } from '@crewhall/db';
import type { RequestInfo } from '../http/types';

/** Audit actions written in phase 0. Names follow `<area>.<object>.<verb>` (design doc 17 §4). */
export type AuditAction =
  | 'setup.complete'
  | 'org.update'
  | 'org.branding.update'
  | 'org.theme.publish'
  | 'org.member.join'
  | 'org.member.role'
  | 'org.member.status'
  | 'org.member.permissions'
  | 'org.invitation.create'
  | 'org.invitation.revoke'
  | 'space.create'
  | 'space.update'
  | 'space.archive'
  | 'space.delete'
  | 'space.restore'
  | 'space.member.add'
  | 'space.member.self_add'
  | 'space.member.role'
  | 'space.member.remove'
  | 'session.revoke'
  | 'auth.account.locked'
  | 'auth.account.unlocked'
  | 'auth.session.new_device'
  | 'mobile.connect.create'
  | 'mobile.connect.use'
  | 'node.move'
  | 'node.purge'
  | 'share.user.create'
  | 'share.link.create'
  | 'share.update'
  | 'share.delete'
  | 'share.link.regenerate'
  | 'share.link.open'
  | 'share.link.password_failed'
  | 'share.link.locked'
  | 'chat.conversation.delete'
  | 'plugin.install'
  | 'plugin.upgrade'
  | 'plugin.enable'
  | 'plugin.disable'
  | 'plugin.uninstall'
  | 'plugin.permissions'
  | 'plugin.notify'
  | 'plugin.command'
  | 'plugin.offline_grant'
  | 'plugin.offline_revoke'
  | 'federation.update'
  | 'federation.peer.add'
  | 'federation.peer.remove'
  | 'federation.share'
  | 'federation.share.invite'
  | 'federation.folder.share'
  | 'federation.folder.end'
  | 'federation.meeting.join'
  | 'federation.share.accept'
  | 'federation.share.accepted'
  | 'federation.share.decline'
  | 'federation.share.remove'
  | 'federation.share.leave'
  | 'federation.member.block'
  | 'federation.member.unblock'
  | 'portal.site.create'
  | 'portal.site.update'
  | 'portal.token.rotate'
  | 'portal.publish'
  | 'portal.revert'
  | 'portal.version.freeze'
  | 'portal.doc.delete'
  | 'portal.post.delete'
  | 'portal.media.delete'
  | 'portal.redirect.create'
  | 'portal.import'
  | 'meet.recording.start'
  | 'meet.remote_control.granted'
  | 'meet.remote_control.revoked'
  | 'meet.recording.stop'
  | 'meet.participant.remove'
  | 'board.create'
  | 'board.settings.update'
  | 'board.card.delete'
  | 'board.card.restore'
  | 'drawing.create'
  | 'announcement.publish'
  | 'announcement.update'
  | 'announcement.delete'
  | 'kudos.badge_create'
  | 'kudos.badge_update'
  | 'kudos.delete'
  | 'celebrations.settings_update'
  | 'org.member.expiry'
  | 'form.create'
  | 'form.delete'
  | 'form.publish'
  | 'form.link.regenerate'
  | 'form.response.delete'
  | 'automation.create'
  | 'automation.update'
  | 'automation.delete'
  | 'table.create'
  | 'table.delete'
  | 'table.import'
  | 'mail.settings.update'
  | 'mail.account.connect'
  | 'mail.account.disconnect'
  | 'mail.inbox.create'
  | 'mail.inbox.update'
  | 'mail.inbox.delete'
  | 'calendar.integration.update'
  | 'directory.import'
  | 'calendar.account.connect'
  | 'calendar.account.disconnect'
  | 'org.delivery.update'
  | 'org.gif.update'
  | 'org.delivery.test'
  | 'org.delivery.auth_failed'
  | 'desktop.release.upload'
  | 'desktop.release.publish'
  | 'desktop.release.delete'
  | 'office.settings.update'
  | 'oauth.handoff.create'
  | 'oauth.handoff.open';

export interface AuditEntry {
  orgId: string | null;
  actorId: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  meta?: Record<string, unknown>;
}

/**
 * Set while a call runs on someone's behalf (MCP tool, API token): every audit row
 * written inside gets `via`, e.g. { kind: 'mcp', client, grant } (doc 17 §13).
 */
export const auditVia = new AsyncLocalStorage<Record<string, unknown>>();

/** Append-only: rows are inserted here and never updated. */
export async function audit(
  db: DbOrTx,
  entry: AuditEntry,
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
    via: auditVia.getStore() ?? null,
  });
}
