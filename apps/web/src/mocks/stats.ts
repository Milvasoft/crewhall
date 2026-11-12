import {
  can,
  MODULE_KEYS,
  moduleOn,
  STATS_AREAS,
  type AdminStats,
  type ModuleKey,
  type OrgSettings,
  type StatsArea,
} from '@crewhall/shared';
import { actorOf, MockApiError, requireUser, summary, type Resolvers } from './core';
import { type MockState } from './seed';

/**
 * Admin statistics (roadmap 21) in the contract mock: a plausible, deterministic history derived
 * from the seed (members, spaces), so the dashboard has something to draw in dev mock mode.
 */

const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Small deterministic noise (no Math.random: screenshots and tests stay stable). */
const wave = (i: number, seed: number) =>
  (Math.sin(i * 1.7 + seed) + Math.sin(i * 0.37 + seed * 2)) / 4;

const SHARE: Partial<Record<StatsArea, number>> = {
  drive: 0.7,
  quick: 0.55,
  chat: 0.8,
  meet: 0.3,
  wiki: 0.45,
  boards: 0.35,
  vault: 0.25,
  portal: 0.08,
  mcp: 0.05,
  core: 0.95,
};

function statsOf(s: MockState, days: number): AdminStats {
  const u = requireUser(s);
  const actor = actorOf(s, u);
  const settings: Partial<OrgSettings> = s.org?.settings ?? {};
  const org = {
    settings: {
      membersCanCreateSpaces: settings.membersCanCreateSpaces ?? false,
      publicLinksEnabled: settings.publicLinksEnabled ?? true,
    },
  };
  if (!can(actor, 'org.view_stats', { type: 'org', org })) {
    throw new MockApiError('forbidden');
  }
  const members = s.members.filter((m) => m.status === 'active').length || 1;
  const now = Date.now();
  const range = Array.from({ length: days }, (_, i) => now - (days - 1 - i) * DAY);
  const dauOf = (ms: number, i: number) => {
    const weekend = [0, 6].includes(new Date(ms).getUTCDay());
    return Math.max(1, Math.round(members * ((weekend ? 0.25 : 0.7) + wave(i, 1) * 0.3)));
  };
  const activeUsers = range.map((ms, i) => ({
    day: day(ms),
    dau: dauOf(ms, i),
    wau: Math.min(members, Math.round(members * (0.85 + wave(i, 2) * 0.2))),
    mau: members,
  }));
  const total = s.spaces.reduce((n, x) => n + x.usedBytes, 0);
  const storage = range.map((ms, i) => ({
    day: day(ms),
    bytes: Math.round(total * (0.8 + (0.2 * (i + 1)) / days)),
  }));
  const isModule = (a: StatsArea): a is ModuleKey => (MODULE_KEYS as readonly string[]).includes(a);
  const modules = STATS_AREAS.filter((a) => !isModule(a) || moduleOn(settings, a))
    .map((area, k) => {
      const series = activeUsers.map((p, i) => ({
        day: p.day,
        users: Math.max(0, Math.round(p.dau * (SHARE[area] ?? 0.1) * (1 + wave(i, k + 3) * 0.4))),
      }));
      const sum = series.reduce((n, p) => n + p.users, 0);
      return {
        area,
        avgDailyUsers: Math.round((sum / days) * 10) / 10,
        peakUsers: Math.max(...series.map((p) => p.users)),
        actions: Math.round(sum * (area === 'chat' ? 14 : area === 'core' ? 1 : 4)),
        series,
      };
    })
    .sort((a, b) => b.avgDailyUsers - a.avgDailyUsers);
  const growingSpaces = s.spaces
    .filter((x) => x.kind === 'shared' && x.usedBytes > 0)
    .map((x, i) => ({
      space: { id: x.id, name: x.name, color: x.color, icon: x.icon, kind: x.kind },
      bytes: x.usedBytes,
      growthBytes: Math.round(x.usedBytes * (0.05 + (i % 4) * 0.06)),
      items: 40 + i * 13,
      growthItems: 3 + (i % 5) * 4,
    }))
    .sort((a, b) => b.growthBytes - a.growthBytes)
    .slice(0, 10);
  const topUsers = s.users
    .filter((x) => s.members.some((m) => m.userId === x.id))
    .map((x, i) => ({ user: summary(x), bytes: Math.round((total / (i + 2)) * 0.6) }))
    .slice(0, 10);
  const last = activeUsers.at(-1)!;
  return {
    days,
    computedAt: new Date(now - 17 * 60_000).toISOString(),
    totals: {
      members,
      dau: last.dau,
      wau: last.wau,
      mau: last.mau,
      storageBytes: total,
      quotaBytes: settings.storageQuotaBytes ?? null,
    },
    activeUsers,
    storage,
    modules,
    growingSpaces,
    topUsers,
  };
}

export const statsResolvers: Resolvers<'adminStats' | 'adminStatsRefresh'> = {
  adminStats: ({ s, query }) => statsOf(s, query.days),
  adminStatsRefresh: ({ s, query }) => statsOf(s, query.days),
};
