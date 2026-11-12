import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq } from 'drizzle-orm';
import { automationRuns, automationRules, type Db } from '@crewhall/db';
import { AUTOMATION_LIMITS, conditionHolds } from '@crewhall/shared';
import type { Jobs } from '../../jobs/queue';
import type { Logger } from '../../logger';
import { isModuleEnabled } from '../identity/modules';
import { allowRate } from './rate';
import { triggerDef, type AutomationEvent } from './registry';

/**
 * Events into rules (roadmap 17). Callers emit after their write committed; every enabled rule
 * of the space with that trigger type, a matching config and holding conditions gets a queued
 * run and an `automation.run` job. Never throws: an automation problem must not fail the
 * card move or the upload that caused it.
 *
 * Loop guard (design 6.6): while a rule's actions run, the rule's id is in the async context;
 * events those actions cause skip every rule already in the chain, and chains stop at
 * AUTOMATION_LIMITS.maxDepth. A storm guard caps runs per rule per minute.
 */

export interface Origin {
  chain: string[];
  depth: number;
}

const origin = new AsyncLocalStorage<Origin>();

/** Runs `fn` as part of a rule's chain (the runner wraps every action with it). */
export function withOrigin<T>(o: Origin, fn: () => Promise<T>) {
  return origin.run(o, fn);
}

type EmitDeps = { db: Db; jobs: Jobs; logger: Logger };

const MAX_EVENT_CHARS = 16_000;

/** The event data as stored with the run: JSON-safe and at most ~16 KB. */
function trimmed(data: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(data);
  if (json.length <= MAX_EVENT_CHARS) return JSON.parse(json) as Record<string, unknown>;
  return { truncated: true, preview: json.slice(0, MAX_EVENT_CHARS) };
}

export async function emitAutomationEvent(
  deps: EmitDeps,
  event: AutomationEvent,
  opts: { origin?: Origin; ruleId?: string } = {},
): Promise<string[]> {
  try {
    if (!(await isModuleEnabled(deps.db, event.orgId, 'automations'))) return [];
    const from = opts.origin ?? origin.getStore() ?? { chain: [], depth: 0 };
    if (from.depth >= AUTOMATION_LIMITS.maxDepth) return [];
    const rules = await deps.db
      .select()
      .from(automationRules)
      .where(
        and(
          eq(automationRules.orgId, event.orgId),
          eq(automationRules.spaceId, event.spaceId),
          eq(automationRules.triggerType, event.type),
          eq(automationRules.enabled, true),
          opts.ruleId ? eq(automationRules.id, opts.ruleId) : undefined,
        ),
      );
    const def = triggerDef(event.type);
    if (!def || rules.length === 0) return [];
    const queued: string[] = [];
    for (const rule of rules) {
      if (from.chain.includes(rule.id)) continue;
      const config = def.config.safeParse(rule.trigger.config);
      if (!config.success || !def.matches(config.data, event)) continue;
      if (!rule.conditions.every((c) => conditionHolds(c, event.data))) continue;
      if (!allowRate(`rule:${rule.id}`, AUTOMATION_LIMITS.runsPerMinute, 60_000)) {
        deps.logger.warn({ ruleId: rule.id }, 'automation rule over its run rate; event skipped');
        continue;
      }
      const [run] = await deps.db
        .insert(automationRuns)
        .values({
          orgId: rule.orgId,
          ruleId: rule.id,
          triggerType: event.type,
          event: trimmed(event.data),
          chain: from.chain,
          depth: from.depth,
        })
        .returning({ id: automationRuns.id });
      await deps.jobs.send('automation.run', { runId: run!.id });
      queued.push(run!.id);
    }
    return queued;
  } catch (err) {
    deps.logger.warn({ err, type: event.type }, 'automation event not processed');
    return [];
  }
}
