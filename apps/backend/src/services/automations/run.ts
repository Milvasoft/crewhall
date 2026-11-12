import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { automationRuns, automationRules, spaceMembers } from '@crewhall/db';
import { AUTOMATION_LIMITS, renderTemplate, type AutomationStep, paths } from '@crewhall/shared';
import type { JobDeps } from '../../jobs/handlers';
import { AppError } from '../../http/errors';
import { actorFor } from '../boards/collab';
import { decryptShareToken } from '../drive/share-token';
import { isModuleEnabled } from '../identity/modules';
import { notify } from '../notifications/notify';
import { serviceDeps } from '../../jobs/service-deps';
import './builtin';
// The AI module's "AI adımı" registers itself here (yol haritası #18).
import '../ai/automation';
import { withOrigin } from './emit';
import { actionDef } from './registry';

/**
 * The `automation.run` job (roadmap 17): claims a queued run, runs the rule's actions in order
 * as the rule's owner and records each step. The first failing step stops the run. Three
 * failed runs in a row turn the rule off and tell its owner and the space admins (design 6.6).
 */

const errorOf = (err: unknown): { code: string; message: string } =>
  err instanceof AppError
    ? {
        code: err.code,
        message: err.details ? JSON.stringify(err.details).slice(0, 300) : err.code,
      }
    : { code: 'internal', message: err instanceof Error ? err.message.slice(0, 300) : String(err) };

export async function runAutomation(deps: JobDeps, runId: string) {
  const { db } = deps;
  const [run] = await db
    .update(automationRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.status, 'queued')))
    .returning();
  if (!run) return;
  const [rule] = await db.select().from(automationRules).where(eq(automationRules.id, run.ruleId));
  const finish = async (
    status: 'succeeded' | 'failed' | 'skipped',
    steps: AutomationStep[],
    error: string | null,
  ) => {
    await db
      .update(automationRuns)
      .set({ status, steps, error, finishedAt: new Date() })
      .where(eq(automationRuns.id, run.id));
    if (rule) await settle(deps, rule, status, run.test);
  };
  if (!rule || (!rule.enabled && !run.test)) return finish('skipped', [], 'rule_disabled');
  if (!(await isModuleEnabled(db, rule.orgId, 'automations'))) {
    return finish('skipped', [], 'module_disabled');
  }
  const actor = rule.ownerId ? await actorFor(db, rule.ownerId, rule.orgId) : null;
  if (!actor) return finish('failed', [], 'automation_owner_inactive');

  const services = serviceDeps(deps);
  const signingSecret = decryptShareToken(deps.env.AUTH_SECRET, rule.signingSecretEnc) ?? '';
  const outputs: Record<string, AutomationStep['output']> = {};
  const steps: AutomationStep[] = [];
  let failed = false;
  for (const action of rule.actions) {
    if (failed) {
      steps.push({
        actionId: action.id,
        type: action.type,
        status: 'skipped',
        error: null,
        output: {},
        ms: 0,
      });
      continue;
    }
    const started = Date.now();
    try {
      const def = actionDef(action.type);
      if (!def) throw new AppError('automation_action_unknown', { type: action.type });
      if (def.module && !(await isModuleEnabled(db, rule.orgId, def.module))) {
        throw new AppError('module_disabled', { module: def.module });
      }
      const config = def.config.parse(action.config);
      const scope = { ...run.event, steps: outputs };
      const output = await withOrigin(
        { chain: [...run.chain, rule.id], depth: run.depth + 1 },
        () =>
          def.run(
            {
              deps: services,
              actor,
              rule: { id: rule.id, name: rule.name, spaceId: rule.spaceId, signingSecret },
              run: { id: run.id, chain: run.chain, depth: run.depth },
              event: { type: run.triggerType, data: run.event },
              steps: outputs,
              render: (text) => renderTemplate(text, scope),
            },
            config,
          ),
      );
      outputs[action.id] = output;
      steps.push({
        actionId: action.id,
        type: action.type,
        status: 'succeeded',
        error: null,
        output,
        ms: Date.now() - started,
      });
    } catch (err) {
      failed = true;
      deps.logger.warn({ err, ruleId: rule.id, action: action.type }, 'automation step failed');
      steps.push({
        actionId: action.id,
        type: action.type,
        status: 'failed',
        error: errorOf(err),
        output: {},
        ms: Date.now() - started,
      });
    }
  }
  return finish(failed ? 'failed' : 'succeeded', steps, failed ? 'step_failed' : null);
}

/** Counters, the failure streak and the automatic stop. Test runs leave the streak alone. */
async function settle(
  deps: JobDeps,
  rule: typeof automationRules.$inferSelect,
  status: 'succeeded' | 'failed' | 'skipped',
  test: boolean,
) {
  const counted = status !== 'skipped';
  const streak =
    test || !counted ? rule.failureStreak : status === 'failed' ? rule.failureStreak + 1 : 0;
  const stop =
    !test && status === 'failed' && streak >= AUTOMATION_LIMITS.failuresToDisable && rule.enabled;
  await deps.db
    .update(automationRules)
    .set({
      lastRunAt: new Date(),
      lastStatus: status,
      runCount: counted ? sql`${automationRules.runCount} + 1` : automationRules.runCount,
      failureStreak: streak,
      ...(stop ? { enabled: false, disabledReason: 'failures' as const } : {}),
      updatedAt: sql`${automationRules.updatedAt}`,
    })
    .where(eq(automationRules.id, rule.id));
  if (!stop) return;
  const admins = await deps.db
    .select({ userId: spaceMembers.userId })
    .from(spaceMembers)
    .where(
      and(eq(spaceMembers.spaceId, rule.spaceId), inArray(spaceMembers.role, ['owner', 'admin'])),
    );
  const people = new Set([...admins.map((a) => a.userId), ...(rule.ownerId ? [rule.ownerId] : [])]);
  await notify(
    deps,
    [...people].map((userId) => ({
      orgId: rule.orgId,
      userId,
      type: 'automations.disabled',
      category: 'alert' as const,
      actorId: null,
      target: { type: 'space' as const, id: rule.spaceId, spaceId: rule.spaceId },
      data: { name: rule.name, count: AUTOMATION_LIMITS.failuresToDisable },
      url: paths.automationRule(rule.id),
    })),
  ).catch((err) =>
    deps.logger.warn({ err, ruleId: rule.id }, 'automation stop notification failed'),
  );
}

/** Nightly: run history older than the retention goes. */
export async function sweepAutomations(deps: Pick<JobDeps, 'db'>) {
  const gone = await deps.db
    .delete(automationRuns)
    .where(
      lt(
        automationRuns.createdAt,
        sql`now() - make_interval(days => ${AUTOMATION_LIMITS.runRetentionDays})`,
      ),
    )
    .returning({ id: automationRuns.id });
  return { removed: gone.length };
}
