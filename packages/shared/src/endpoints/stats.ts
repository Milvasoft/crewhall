import { def, type EndpointDef } from '../endpoint-def';
import { AdminStats, AdminStatsQuery } from '../schemas/stats';

/**
 * Admin statistics (roadmap 21). Org owners and admins (can(actor, 'org.view_stats')). Core,
 * not a switchable module: it covers every module.
 */
export const statsEndpoints = {
  adminStats: def({
    method: 'GET',
    path: '/api/v1/org/stats',
    auth: 'session',
    query: AdminStatsQuery,
    response: AdminStats,
  }),
  /** Rolls today up now (the job also runs hourly) and returns the fresh numbers. */
  adminStatsRefresh: def({
    method: 'POST',
    path: '/api/v1/org/stats/refresh',
    auth: 'session',
    query: AdminStatsQuery,
    response: AdminStats,
  }),
} as const satisfies Record<string, EndpointDef>;
