import { and, between, desc, eq, inArray, isNull, lte, max, sql } from 'drizzle-orm';
import { orgStatsDaily, spaces, users as usersTable, type DbOrTx } from '@crewhall/db';
import {
  MODULE_KEYS,
  STATS_AREAS,
  type AdminStats,
  type ModuleKey,
  type ModuleUsage,
  type SpaceGrowth,
  type StatsArea,
  type UserSummary,
} from '@crewhall/shared';
import type { OrgRow } from '../../http/types';
import { utcDay } from './activity';

/**
 * The dashboard (roadmap 21): everything comes from org_stats_daily, a few hundred rows per
 * range at most. Days without a row count as zero people; storage shows the days it was measured.
 */

const DAY_MS = 86_400_000;
const TOP = 10;

type Row = { day: string; metric: string; dim: string; value: number };

function daysOf(from: string, count: number): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => utcDay(new Date(start + i * DAY_MS)));
}

async function userSummaries(db: DbOrTx, ids: string[]) {
  const map = new Map<string, UserSummary>();
  if (!ids.length) return map;
  const rows = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      image: usersTable.image,
    })
    .from(usersTable)
    .where(inArray(usersTable.id, ids));
  for (const u of rows)
    map.set(u.id, { id: u.id, name: u.name, email: u.email, imageUrl: u.image });
  return map;
}

const isModule = (a: StatsArea): a is ModuleKey => (MODULE_KEYS as readonly string[]).includes(a);

export async function readStats(
  db: DbOrTx,
  org: OrgRow,
  days: number,
  now = new Date(),
): Promise<AdminStats> {
  const today = utcDay(now);
  const from = utcDay(new Date(now.getTime() - (days - 1) * DAY_MS));
  const range = daysOf(from, days);
  const where = (metrics: string[]) =>
    and(
      eq(orgStatsDaily.orgId, org.id),
      inArray(orgStatsDaily.metric, metrics),
      between(orgStatsDaily.day, from, today),
    );
  const rows: Row[] = await db
    .select({
      day: orgStatsDaily.day,
      metric: orgStatsDaily.metric,
      dim: orgStatsDaily.dim,
      value: orgStatsDaily.value,
    })
    .from(orgStatsDaily)
    .where(
      where([
        'dau',
        'wau',
        'mau',
        'members',
        'storage_bytes',
        'module_users',
        'module_actions',
        'space_bytes',
        'space_items',
      ]),
    );
  const [last] = await db
    .select({ at: max(orgStatsDaily.computedAt) })
    .from(orgStatsDaily)
    .where(eq(orgStatsDaily.orgId, org.id));

  const value = (metric: string, day: string, dim = '') =>
    rows.find((r) => r.metric === metric && r.day === day && r.dim === dim)?.value ?? 0;
  const byMetric = (metric: string) => rows.filter((r) => r.metric === metric);
  const latest = (metric: string) =>
    byMetric(metric)
      .filter((r) => r.dim === '')
      .sort((a, b) => b.day.localeCompare(a.day))[0]?.value ?? 0;

  const activeUsers = range.map((day) => ({
    day,
    dau: value('dau', day),
    wau: value('wau', day),
    mau: value('mau', day),
  }));
  const storage = byMetric('storage_bytes')
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((r) => ({ day: r.day, bytes: r.value }));

  const switches = org.settings.modules ?? {};
  const modules: ModuleUsage[] = STATS_AREAS.filter(
    (a) => !isModule(a) || switches[a] !== false,
  ).map((area) => {
    const series = range.map((day) => ({ day, users: value('module_users', day, area) }));
    const total = series.reduce((n, p) => n + p.users, 0);
    return {
      area,
      avgDailyUsers: Math.round((total / days) * 10) / 10,
      peakUsers: Math.max(0, ...series.map((p) => p.users)),
      actions: byMetric('module_actions')
        .filter((r) => r.dim === area)
        .reduce((n, r) => n + r.value, 0),
      series,
    };
  });
  modules.sort((a, b) => b.avgDailyUsers - a.avgDailyUsers || b.actions - a.actions);

  // Growth: newest measurement in the range minus the oldest one, per live space.
  const live = await db
    .select({ id: spaces.id, name: spaces.name, color: spaces.color,
      icon: spaces.icon, kind: spaces.kind })
    .from(spaces)
    // Shared spaces only: personal spaces are summarized, never listed (design 9.9); their
    // owners show up under per-person storage instead.
    .where(and(eq(spaces.orgId, org.id), eq(spaces.kind, 'shared'), isNull(spaces.deletedAt)));
  const edge = (metric: string, id: string) => {
    const list = byMetric(metric)
      .filter((r) => r.dim === id)
      .sort((a, b) => a.day.localeCompare(b.day));
    return { first: list[0]?.value ?? 0, last: list.at(-1)?.value ?? 0, seen: list.length > 0 };
  };
  const growingSpaces: SpaceGrowth[] = live
    .map((s) => {
      const b = edge('space_bytes', s.id);
      const n = edge('space_items', s.id);
      return {
        seen: b.seen,
        row: {
          space: s,
          bytes: b.last,
          growthBytes: b.last - b.first,
          items: n.last,
          growthItems: n.last - n.first,
        },
      };
    })
    .filter((x) => x.seen)
    .map((x) => x.row)
    .sort(
      (a, b) => b.growthBytes - a.growthBytes || b.growthItems - a.growthItems || b.bytes - a.bytes,
    )
    .slice(0, TOP);

  // Per person: the newest day measured (the metric is a snapshot).
  const [newest] = await db
    .select({ day: max(orgStatsDaily.day) })
    .from(orgStatsDaily)
    .where(
      and(
        eq(orgStatsDaily.orgId, org.id),
        eq(orgStatsDaily.metric, 'user_bytes'),
        lte(orgStatsDaily.day, today),
      ),
    );
  const people = newest?.day
    ? await db
        .select({ dim: orgStatsDaily.dim, value: orgStatsDaily.value })
        .from(orgStatsDaily)
        .where(
          and(
            eq(orgStatsDaily.orgId, org.id),
            eq(orgStatsDaily.metric, 'user_bytes'),
            eq(orgStatsDaily.day, newest.day),
            sql`${orgStatsDaily.value} > 0`,
          ),
        )
        .orderBy(desc(orgStatsDaily.value))
        .limit(TOP)
    : [];
  const users = await userSummaries(
    db,
    people.map((p) => p.dim),
  );
  const topUsers = people.flatMap((p) => {
    const user = users.get(p.dim);
    return user ? [{ user, bytes: p.value }] : [];
  });

  return {
    days,
    computedAt: last?.at ? last.at.toISOString() : null,
    totals: {
      members: latest('members'),
      dau: latest('dau'),
      wau: latest('wau'),
      mau: latest('mau'),
      storageBytes: latest('storage_bytes'),
      quotaBytes: org.settings.storageQuotaBytes ?? null,
    },
    activeUsers,
    storage,
    modules,
    growingSpaces,
    topUsers,
  };
}
