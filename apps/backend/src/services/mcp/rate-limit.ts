import { sql } from 'drizzle-orm';
import { mcpRateBuckets, type DbOrTx } from '@crewhall/db';

export interface Bucket {
  /** e.g. "req", "write", "oauth_token". */
  kind: string;
  /** Tokens per minute; also the burst size. */
  perMinute: number;
}

export interface TakeResult {
  allowed: boolean;
  /** Seconds until one token is back (0 when allowed). */
  retryAfter: number;
}

/**
 * Token bucket in Postgres (doc 17 §13: single node; Valkey when there are several).
 * Refill and take happen in one statement, so concurrent requests cannot overspend.
 */
export async function take(
  db: DbOrTx,
  subject: string,
  bucket: Bucket,
  orgId: string | null = null,
): Promise<TakeResult> {
  const cap = bucket.perMinute;
  const rate = bucket.perMinute / 60;
  const refilled = sql`least(${cap}::float8, ${mcpRateBuckets.tokens} + extract(epoch from (now() - ${mcpRateBuckets.updatedAt})) * ${rate}::float8)`;
  const result = await db.execute<{ tokens: number; allowed: boolean }>(sql`
    insert into ${mcpRateBuckets} (org_id, subject, kind, tokens, allowed, updated_at)
    values (${orgId}, ${subject}, ${bucket.kind}, ${cap - 1}::float8, true, now())
    on conflict (subject, kind) do update set
      tokens = case when ${refilled} >= 1 then ${refilled} - 1 else ${refilled} end,
      allowed = ${refilled} >= 1,
      updated_at = now()
    returning tokens, allowed`);
  const row = result.rows[0];
  if (!row || row.allowed) return { allowed: true, retryAfter: 0 };
  return { allowed: false, retryAfter: Math.max(1, Math.ceil((1 - Number(row.tokens)) / rate)) };
}
