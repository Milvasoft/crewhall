import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@crewhall/db';
import { utcDay } from './activity';

/**
 * stats.rollup (hourly, roadmap 21): turns activity_daily and the storage counters into one
 * row per org, day, metric and dimension in org_stats_daily. Yesterday and today are recomputed
 * on every run (yesterday so its last hours are counted), storage is a snapshot taken for today.
 * Upserts only, so a rerun or two workers at once give the same result. The dashboard never
 * touches raw activity.
 */

const DAY_MS = 86_400_000;
/** Raw activity is kept long enough for the 30-day window of the oldest rollup that may rerun. */
export const ACTIVITY_KEEP_DAYS = 60;
/** Per-person storage is the largest metric; it is kept for a quarter. */
export const USER_BYTES_KEEP_DAYS = 90;
export const STATS_KEEP_DAYS = 800;

const upsert = sql`on conflict (org_id, day, metric, dim)
  do update set value = excluded.value, computed_at = now()`;

/** `and <col> = orgId` when rolling up one org (refresh), nothing for the hourly job. */
const only = (col: SQL, orgId?: string) => (orgId ? sql`and ${col} = ${orgId}` : sql``);

async function activity(db: DbOrTx, day: string, orgId?: string) {
  const window = (days: number, metric: string) =>
    db.execute(sql`
    insert into org_stats_daily (org_id, day, metric, dim, value)
    select org_id, ${day}::date, ${metric}, '', count(distinct user_id)
    from activity_daily
    where day between ${day}::date - ${days - 1}::int and ${day}::date ${only(sql`org_id`, orgId)}
    group by org_id
    ${upsert}`);
  await window(1, 'dau');
  await window(7, 'wau');
  await window(30, 'mau');
  await db.execute(sql`
    insert into org_stats_daily (org_id, day, metric, dim, value)
    select org_id, ${day}::date, 'module_users', area, count(distinct user_id)
    from activity_daily where day = ${day}::date ${only(sql`org_id`, orgId)}
    group by org_id, area
    ${upsert}`);
  await db.execute(sql`
    insert into org_stats_daily (org_id, day, metric, dim, value)
    select org_id, ${day}::date, 'module_actions', area, sum(writes)
    from activity_daily where day = ${day}::date ${only(sql`org_id`, orgId)}
    group by org_id, area
    ${upsert}`);
}

async function storage(db: DbOrTx, day: string, orgId?: string) {
  await db.execute(sql`
    insert into org_stats_daily (org_id, day, metric, dim, value)
    select o.id, ${day}::date, 'storage_bytes', '', coalesce(sum(s.used_bytes), 0)
    from organizations o left join spaces s on s.org_id = o.id
    where true ${only(sql`o.id`, orgId)}
    group by o.id
    ${upsert}`);
  await db.execute(sql`
    insert into org_stats_daily (org_id, day, metric, dim, value)
    select o.id, ${day}::date, 'members', '', count(m.id)
    from organizations o left join org_members m on m.org_id = o.id and m.status = 'active'
    where true ${only(sql`o.id`, orgId)}
    group by o.id
    ${upsert}`);
  await db.execute(sql`
    insert into org_stats_daily (org_id, day, metric, dim, value)
    select s.org_id, ${day}::date, 'space_bytes', s.id::text, s.used_bytes
    from spaces s where s.deleted_at is null ${only(sql`s.org_id`, orgId)}
    ${upsert}`);
  await db.execute(sql`
    insert into org_stats_daily (org_id, day, metric, dim, value)
    select s.org_id, ${day}::date, 'space_items', s.id::text,
      (select count(*) from nodes n
        where n.space_id = s.id and n.deleted_at is null and n.type <> 'folder')
    from spaces s where s.deleted_at is null ${only(sql`s.org_id`, orgId)}
    ${upsert}`);
  // What each person uploaded and still takes space (every version, the trash included, as
  // the quota counts it).
  await db.execute(sql`
    insert into org_stats_daily (org_id, day, metric, dim, value)
    select v.org_id, ${day}::date, 'user_bytes', v.created_by::text, sum(v.size_bytes)
    from node_versions v
    where v.created_by is not null ${only(sql`v.org_id`, orgId)}
    group by v.org_id, v.created_by
    ${upsert}`);
}

async function prune(db: DbOrTx, today: string) {
  await db.execute(
    sql`delete from activity_daily where day < ${today}::date - ${ACTIVITY_KEEP_DAYS}::int`,
  );
  await db.execute(sql`delete from org_stats_daily
    where (metric = 'user_bytes' and day < ${today}::date - ${USER_BYTES_KEEP_DAYS}::int)
       or day < ${today}::date - ${STATS_KEEP_DAYS}::int`);
}

export async function rollupStats(db: DbOrTx, now = new Date(), orgId?: string) {
  const today = utcDay(now);
  const yesterday = utcDay(new Date(now.getTime() - DAY_MS));
  await activity(db, yesterday, orgId);
  await activity(db, today, orgId);
  await storage(db, today, orgId);
  if (!orgId) await prune(db, today);
}
