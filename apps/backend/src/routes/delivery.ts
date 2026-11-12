import { can } from '@crewhall/shared';
import { AppError } from '../http/errors';
import type { Router } from '../http/route';
import type { OrgCtx } from '../http/types';
import { getDeliverySettings, updateDeliverySettings } from '../services/delivery/settings';
import { testDelivery } from '../services/delivery/test';
import { orgContext } from '../services/membership';
import { pushDiagnostics } from '../services/notifications/diagnostics';

/** Yönetim › Bildirim gönderimi (owner, admin). */
function requireAdmin(ctx: Pick<OrgCtx<never>, 'actor' | 'org'>) {
  if (!can(ctx.actor, 'org.update_settings', { type: 'org', org: orgContext(ctx.org) })) {
    throw new AppError('forbidden');
  }
}

export function registerDelivery(r: Router): void {
  r.org('getPushDiagnostics', (ctx) => {
    if (!can(ctx.actor, 'org.manage_members', { type: 'org', org: orgContext(ctx.org) })) {
      throw new AppError('forbidden');
    }
    return pushDiagnostics(ctx.deps, ctx.org, ctx.params.userId, ctx.query.conversationId);
  });
  r.org('getDeliverySettings', (ctx) => {
    requireAdmin(ctx);
    return getDeliverySettings(ctx.deps, ctx.org.id);
  });
  r.org('updateDeliverySettings', (ctx) => {
    requireAdmin(ctx);
    return updateDeliverySettings(
      ctx.deps,
      { orgId: ctx.org.id, userId: ctx.user.id },
      ctx.body,
      ctx.req,
    );
  });
  r.org('testDelivery', (ctx) => {
    requireAdmin(ctx);
    return testDelivery(ctx.deps, { orgId: ctx.org.id, userId: ctx.user.id }, ctx.body, ctx.req);
  });
}
