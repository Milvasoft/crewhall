import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { toolCalls, type DbOrTx } from '@crewhall/db';
import { MCP_LIMITS, type McpScope, type McpToolCatalog, type McpUsage } from '@crewhall/shared';
import { z } from 'zod';
import { toolsOfOrg } from './executor';
import { RESOURCES } from './tools';

/** Design 18.11: generated from the same zod schemas tools/list uses, never by hand. */
export function toolCatalog(
  myScopes: ReadonlySet<McpScope>,
  org: Parameters<typeof toolsOfOrg>[0],
): McpToolCatalog {
  return {
    tools: toolsOfOrg(org).map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      scope: t.scope,
      approval: t.approval,
      readOnly: t.annotations.readOnly,
      destructive: t.annotations.destructive,
      idempotent: t.annotations.idempotent,
      inputSchema: z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>,
      example: t.example ?? null,
      available: myScopes.has(t.scope),
    })),
    resources: RESOURCES.map((r) => ({
      uriTemplate: r.uriTemplate,
      name: r.name,
      description: r.description,
    })),
    limits: {
      requestsPerMinute: MCP_LIMITS.requestsPerMinute,
      writesPerMinute: MCP_LIMITS.writesPerMinute,
      responseBytes: MCP_LIMITS.responseBytes,
    },
  };
}

/** Org usage (18.10 "Kullanım"): calls per day and the busiest tools. */
export async function orgUsage(db: DbOrTx, orgId: string, days: number): Promise<McpUsage> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const where = and(eq(toolCalls.orgId, orgId), gte(toolCalls.createdAt, since));
  const perDay = await db
    .select({
      date: sql<string>`to_char(date_trunc('day', ${toolCalls.createdAt}), 'YYYY-MM-DD')`,
      calls: sql<number>`count(*)::int`,
      writes: sql<number>`count(*) filter (where ${toolCalls.write})::int`,
      errors: sql<number>`count(*) filter (where ${toolCalls.result} = 'error')::int`,
    })
    .from(toolCalls)
    .where(where)
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const tools = await db
    .select({ tool: toolCalls.tool, calls: sql<number>`count(*)::int` })
    .from(toolCalls)
    .where(where)
    .groupBy(toolCalls.tool)
    .orderBy(desc(sql`2`))
    .limit(10);
  const [people] = await db
    .select({ n: sql<number>`count(distinct ${toolCalls.userId})::int` })
    .from(toolCalls)
    .where(where);
  return { days: perDay, tools, people: people?.n ?? 0 };
}
