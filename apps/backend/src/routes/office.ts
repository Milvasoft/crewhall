import { can } from '@crewhall/shared';
import { AppError } from '../http/errors';
import type { Router } from '../http/route';
import type { OrgCtx } from '../http/types';
import { orgContext } from '../services/membership';
import { createOfficeDocument, openOfficeSession } from '../services/office/session';
import {
  loadOfficeSettings,
  officeCapabilities,
  testOfficeSettings,
  toOfficeSettingsView,
  updateOfficeSettings,
} from '../services/office/settings';
import { driveActor } from './drive';

function requireAdmin(ctx: Pick<OrgCtx<never>, 'actor' | 'org'>) {
  if (!can(ctx.actor, 'org.update_settings', { type: 'org', org: orgContext(ctx.org) })) {
    throw new AppError('forbidden');
  }
}

/** Office module (WOPI document editing); the WOPI endpoints are in services/office/wopi.ts. */
export function registerOffice(r: Router) {
  r.org('getOfficeSettings', async (ctx) => {
    requireAdmin(ctx);
    return toOfficeSettingsView(await loadOfficeSettings(ctx.deps.db, ctx.org.id));
  });
  r.org('updateOfficeSettings', async (ctx) => {
    requireAdmin(ctx);
    return updateOfficeSettings(
      ctx.deps,
      { orgId: ctx.org.id, userId: ctx.user.id },
      ctx.body,
      ctx.req,
    );
  });
  r.org('testOfficeSettings', async (ctx) => {
    requireAdmin(ctx);
    return testOfficeSettings(ctx.deps.db, ctx.org.id);
  });
  r.org('getOfficeCapabilities', async (ctx) => officeCapabilities(ctx.deps, ctx.org));
  r.org('openOfficeSession', async (ctx) =>
    openOfficeSession(ctx.deps, driveActor(ctx), ctx.params.nodeId, ctx.body.mode, ctx.req.locale),
  );
  r.org(
    'createOfficeDocument',
    async (ctx) => createOfficeDocument(ctx.deps, driveActor(ctx), ctx.body, ctx.req.locale),
    { status: 201 },
  );
}
