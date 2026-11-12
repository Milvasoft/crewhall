import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { aiRuns, users, type DbOrTx } from '@crewhall/db';
import { AiAction, type AiStatus, type AiUsageReport } from '@crewhall/shared';
import type { SettingsRow } from './settings';

/** Monthly quotas count input + output tokens of every run in the calendar month (UTC). */

export function monthRange(month?: string, now = new Date()) {
  const [y, m] = month
    ? month.split('-').map(Number)
    : [now.getUTCFullYear(), now.getUTCMonth() + 1];
  const from = new Date(Date.UTC(y!, m! - 1, 1));
  const to = new Date(Date.UTC(y!, m!, 1));
  return { month: from.toISOString().slice(0, 7), from, to };
}

const tokens = sql<number>`coalesce(sum(${aiRuns.inputTokens} + ${aiRuns.outputTokens}), 0)::bigint`;

async function usedSince(db: DbOrTx, orgId: string, from: Date, userId?: string) {
  const [row] = await db
    .select({ tokens })
    .from(aiRuns)
    .where(
      and(
        eq(aiRuns.orgId, orgId),
        gte(aiRuns.createdAt, from),
        userId ? eq(aiRuns.userId, userId) : undefined,
      ),
    );
  return Number(row?.tokens ?? 0);
}

export async function quotaOf(
  db: DbOrTx,
  settings: SettingsRow | null,
  orgId: string,
  userId: string,
): Promise<AiStatus['quota']> {
  const { month, from, to } = monthRange();
  const [org, user] = await Promise.all([
    usedSince(db, orgId, from),
    usedSince(db, orgId, from, userId),
  ]);
  return {
    month,
    resetsAt: to.toISOString(),
    user: { usedTokens: user, limitTokens: settings?.userMonthlyTokens ?? null },
    org: { usedTokens: org, limitTokens: settings?.orgMonthlyTokens ?? null },
  };
}

/** Which bucket is used up, if any. */
export function exhausted(q: AiStatus['quota']): 'user' | 'org' | null {
  if (q.org.limitTokens !== null && q.org.usedTokens >= q.org.limitTokens) return 'org';
  if (q.user.limitTokens !== null && q.user.usedTokens >= q.user.limitTokens) return 'user';
  return null;
}

const totals = {
  runs: sql<number>`count(*)::int`,
  inputTokens: sql<number>`coalesce(sum(${aiRuns.inputTokens}), 0)::bigint`,
  cachedInputTokens: sql<number>`coalesce(sum(${aiRuns.cachedInputTokens}), 0)::bigint`,
  outputTokens: sql<number>`coalesce(sum(${aiRuns.outputTokens}), 0)::bigint`,
};

const num = <
  T extends { runs: number; inputTokens: number; cachedInputTokens: number; outputTokens: number },
>(
  r: T,
) => ({
  ...r,
  runs: Number(r.runs),
  inputTokens: Number(r.inputTokens),
  cachedInputTokens: Number(r.cachedInputTokens),
  outputTokens: Number(r.outputTokens),
});

export async function usageReport(
  db: DbOrTx,
  orgId: string,
  monthParam?: string,
): Promise<AiUsageReport> {
  const { month, from, to } = monthRange(monthParam);
  const where = and(eq(aiRuns.orgId, orgId), gte(aiRuns.createdAt, from), lt(aiRuns.createdAt, to));
  const day = sql<string>`to_char(${aiRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;

  const [sum] = await db.select(totals).from(aiRuns).where(where);
  const days = await db
    .select({ date: day, ...totals })
    .from(aiRuns)
    .where(where)
    .groupBy(day)
    .orderBy(day);
  const byAction = await db
    .select({ action: aiRuns.action, ...totals })
    .from(aiRuns)
    .where(where)
    .groupBy(aiRuns.action);
  const byUserRows = await db
    .select({ userId: aiRuns.userId, ...totals })
    .from(aiRuns)
    .where(where)
    .groupBy(aiRuns.userId)
    .orderBy(desc(sql`sum(${aiRuns.inputTokens} + ${aiRuns.outputTokens})`))
    .limit(20);
  const ids = byUserRows.flatMap((r) => (r.userId ? [r.userId] : []));
  const people = ids.length
    ? await db
        .select({ id: users.id, name: users.name, image: users.image })
        .from(users)
        .where(inArray(users.id, ids))
    : [];

  return {
    month,
    totals: num(sum ?? { runs: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }),
    days: days.map(num),
    byAction: byAction.flatMap((r) => {
      const action = AiAction.safeParse(r.action);
      return action.success ? [{ ...num(r), action: action.data }] : [];
    }),
    byUser: byUserRows.flatMap((r) => {
      const p = people.find((x) => x.id === r.userId);
      if (!p) return [];
      const { userId: _userId, ...rest } = num(r);
      return [{ ...rest, user: { id: p.id, name: p.name, imageUrl: p.image } }];
    }),
  };
}
