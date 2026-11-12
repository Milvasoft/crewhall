import { sql } from 'drizzle-orm';
import { mcpAccessTokens, mcpAuthCodes, mcpRateBuckets, toolCalls, type Db } from '@crewhall/db';
import { MCP_LIMITS } from '@crewhall/shared';
import { expireApprovals } from './approvals';

/** Hourly housekeeping (worker job mcp.cleanup): retention and dead credentials. */
export async function mcpCleanup(db: Db) {
  await expireApprovals(db);
  await db.execute(
    sql`delete from ${toolCalls} where created_at < now() - make_interval(days => ${MCP_LIMITS.activityRetentionDays})`,
  );
  await db.execute(sql`delete from ${mcpAuthCodes} where expires_at < now() - interval '1 hour'`);
  await db.execute(sql`delete from ${mcpAccessTokens} where expires_at < now() - interval '1 day'`);
  await db.execute(sql`delete from ${mcpRateBuckets} where updated_at < now() - interval '1 hour'`);
}
