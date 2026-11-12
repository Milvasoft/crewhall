import { can, type EndpointName } from '@crewhall/shared';
import { AppError } from '../http/errors';
import type { Router } from '../http/route';
import type { OrgCtx } from '../http/types';
import { orgContext } from '../services/membership';
import { flushActivity } from '../services/stats/activity';
import { readStats } from '../services/stats/read';
import { rollupStats } from '../services/stats/rollup';

/** Yönetim › İstatistikler (roadmap 21): org owners and admins. */

function requireStats<N extends EndpointName>(ctx: OrgCtx<N>) {
  if (!can(ctx.actor, 'org.view_stats', { type: 'org', org: orgContext(ctx.org) })) {
    throw new AppError('forbidden', { action: 'org.view_stats' });
  }
}

export function registerStats(r: Router): void {
  r.org('adminStats', async (ctx) => {
    requireStats(ctx);
    return readStats(ctx.deps.db, ctx.org, ctx.query.days);
  });
  r.org('adminStatsRefresh', async (ctx) => {
    requireStats(ctx);
    await flushActivity(ctx.deps.db);
    await rollupStats(ctx.deps.db, new Date(), ctx.org.id);
    return readStats(ctx.deps.db, ctx.org, ctx.query.days);
  });
}
