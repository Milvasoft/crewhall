import { randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, lt, or } from 'drizzle-orm';
import { automationRuns, automationRules, type DbOrTx } from '@crewhall/db';
import {
  AUTOMATION_LIMITS,
  can,
  type AutomationRule,
  type AutomationRun,
  CreateAutomationRule,
  type SpaceAction,
  type SpaceRole,
} from '@crewhall/shared';
import type { z } from 'zod';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import { usersById } from '../chat/views';
import { decryptShareToken, encryptShareToken } from '../drive/share-token';
import { loadSpace, type DriveActor } from '../drive/access';
import { orgContext } from '../membership';
import { actionDef, triggerDef } from './registry';
import { hashHookKey } from './webhook';

/** Rules of a space and their history (roadmap 17). */

export type RuleRow = typeof automationRules.$inferSelect;
type RuleInput = z.output<typeof CreateAutomationRule>;

const newSecret = () => randomBytes(24).toString('base64url');

function canRules(a: DriveActor, role: SpaceRole | null, action: SpaceAction) {
  return can(a.actor, action, { type: 'space', org: orgContext(a.org), myRole: role });
}

/** Space editors read rules, space admins change them; others do not see them. */
function requireRules(a: DriveActor, role: SpaceRole | null, action: SpaceAction) {
  if (!canRules(a, role, action)) {
    throw new AppError(canRules(a, role, 'space.view') ? 'forbidden' : 'not_found');
  }
}

export async function loadRule(db: DbOrTx, a: DriveActor, ruleId: string) {
  const [rule] = await db
    .select()
    .from(automationRules)
    .where(and(eq(automationRules.id, ruleId), eq(automationRules.orgId, a.org.id)));
  if (!rule) throw new AppError('not_found');
  const { space, role } = await loadSpace(db, a, rule.spaceId);
  return { rule, space, role };
}

const hookUrl = (apiUrl: string, id: string, key: string) =>
  `${apiUrl.replace(/\/$/, '')}/api/automations/hooks/${id}?key=${key}`;

export async function toRules(
  deps: Pick<Deps, 'db' | 'env'>,
  rows: RuleRow[],
): Promise<AutomationRule[]> {
  const people = await usersById(
    deps.db,
    rows.map((r) => r.ownerId).filter((v): v is string => !!v),
  );
  return rows.map((r) => {
    const key = r.hookKeyEnc ? decryptShareToken(deps.env.AUTH_SECRET, r.hookKeyEnc) : null;
    return {
      id: r.id,
      spaceId: r.spaceId,
      name: r.name,
      enabled: r.enabled,
      trigger: r.trigger,
      conditions: r.conditions,
      actions: r.actions,
      owner: r.ownerId ? (people.get(r.ownerId) ?? null) : null,
      hookUrl:
        r.triggerType === 'webhook.received' && key ? hookUrl(deps.env.API_URL, r.id, key) : null,
      signingSecret: decryptShareToken(deps.env.AUTH_SECRET, r.signingSecretEnc),
      disabledReason: r.disabledReason,
      failureStreak: r.failureStreak,
      runCount: r.runCount,
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
      lastStatus: r.lastStatus,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

const one = async (deps: Pick<Deps, 'db' | 'env'>, row: RuleRow) =>
  (await toRules(deps, [row]))[0]!;

/**
 * Checks the trigger and every action against the registry, parses their configs (defaults
 * filled in) and lets each check its targets as the saver.
 */
async function checked(db: DbOrTx, a: DriveActor, spaceId: string, input: RuleInput) {
  const tdef = triggerDef(input.trigger.type);
  if (!tdef || tdef.planned)
    throw new AppError('automation_trigger_unknown', { type: input.trigger.type });
  const tconf = tdef.config.safeParse(input.trigger.config);
  if (!tconf.success) {
    throw new AppError('automation_config_invalid', {
      at: 'trigger',
      issues: tconf.error.issues.map((i) => i.path.join('.')),
    });
  }
  await tdef.validate?.(db, a, spaceId, tconf.data);
  const ids = new Set<string>();
  const actions = [];
  for (const [i, act] of input.actions.entries()) {
    const adef = actionDef(act.type);
    if (!adef) throw new AppError('automation_action_unknown', { type: act.type });
    if (ids.has(act.id)) throw new AppError('automation_config_invalid', { at: `actions.${i}.id` });
    ids.add(act.id);
    const conf = adef.config.safeParse(act.config);
    if (!conf.success) {
      throw new AppError('automation_config_invalid', {
        at: `actions.${i}`,
        issues: conf.error.issues.map((x) => x.path.join('.')),
      });
    }
    await adef.validate?.(db, a, spaceId, conf.data);
    actions.push({ id: act.id, type: act.type, config: conf.data as Record<string, unknown> });
  }
  return {
    trigger: { type: input.trigger.type, config: tconf.data as Record<string, unknown> },
    actions,
  };
}

export async function listRules(deps: Pick<Deps, 'db' | 'env'>, a: DriveActor, spaceId: string) {
  const { role } = await loadSpace(deps.db, a, spaceId);
  requireRules(a, role, 'automations.view');
  const rows = await deps.db
    .select()
    .from(automationRules)
    .where(and(eq(automationRules.spaceId, spaceId), eq(automationRules.orgId, a.org.id)))
    .orderBy(asc(automationRules.createdAt));
  return { items: await toRules(deps, rows) };
}

export async function getRule(deps: Pick<Deps, 'db' | 'env'>, a: DriveActor, ruleId: string) {
  const { rule, role } = await loadRule(deps.db, a, ruleId);
  requireRules(a, role, 'automations.view');
  return one(deps, rule);
}

export async function createRule(
  deps: Pick<Deps, 'db' | 'env'>,
  a: DriveActor,
  spaceId: string,
  input: RuleInput,
  req: RequestInfo,
) {
  const { db, env } = deps;
  const { role, space } = await loadSpace(db, a, spaceId);
  requireRules(a, role, 'automations.manage');
  if (space.archivedAt) throw new AppError('forbidden', { reason: 'space_archived' });
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(automationRules)
    .where(eq(automationRules.spaceId, spaceId));
  if (Number(n) >= AUTOMATION_LIMITS.rulesPerSpace) {
    throw new AppError('automation_limit_reached', { rules: AUTOMATION_LIMITS.rulesPerSpace });
  }
  const ok = await checked(db, a, spaceId, input);
  const key = newSecret();
  const [row] = await db
    .insert(automationRules)
    .values({
      orgId: a.org.id,
      spaceId,
      name: input.name,
      enabled: input.enabled,
      triggerType: ok.trigger.type,
      trigger: ok.trigger,
      conditions: input.conditions,
      actions: ok.actions,
      ownerId: a.userId,
      createdBy: a.userId,
      hookKeyHash: hashHookKey(key),
      hookKeyEnc: encryptShareToken(env.AUTH_SECRET, key),
      signingSecretEnc: encryptShareToken(env.AUTH_SECRET, newSecret()),
    })
    .returning();
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'automation.create',
      targetType: 'automation',
      targetId: row!.id,
      meta: { trigger: ok.trigger.type },
    },
    req,
  );
  return one(deps, row!);
}

export async function updateRule(
  deps: Pick<Deps, 'db' | 'env'>,
  a: DriveActor,
  ruleId: string,
  input: Partial<RuleInput>,
  req: RequestInfo,
) {
  const { db } = deps;
  const { rule, role } = await loadRule(db, a, ruleId);
  requireRules(a, role, 'automations.manage');
  const merged: RuleInput = {
    name: input.name ?? rule.name,
    enabled: input.enabled ?? rule.enabled,
    trigger: input.trigger ?? rule.trigger,
    conditions: input.conditions ?? rule.conditions,
    actions: input.actions ?? rule.actions,
  };
  // Every save re-checks the targets as the saver, who becomes the owner the actions run as.
  const ok = await checked(db, a, rule.spaceId, merged);
  const reenabled = input.enabled === true && (!rule.enabled || rule.disabledReason !== null);
  const [row] = await db
    .update(automationRules)
    .set({
      name: merged.name,
      enabled: merged.enabled,
      triggerType: ok.trigger.type,
      trigger: ok.trigger,
      conditions: merged.conditions,
      actions: ok.actions,
      ownerId: a.userId,
      ...(reenabled || merged.enabled === false ? { failureStreak: 0, disabledReason: null } : {}),
    })
    .where(eq(automationRules.id, ruleId))
    .returning();
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'automation.update',
      targetType: 'automation',
      targetId: ruleId,
      meta: { enabled: merged.enabled },
    },
    req,
  );
  return one(deps, row!);
}

export async function deleteRule(
  deps: Pick<Deps, 'db'>,
  a: DriveActor,
  ruleId: string,
  req: RequestInfo,
) {
  const { rule, role } = await loadRule(deps.db, a, ruleId);
  requireRules(a, role, 'automations.manage');
  await deps.db.delete(automationRules).where(eq(automationRules.id, ruleId));
  await audit(
    deps.db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'automation.delete',
      targetType: 'automation',
      targetId: ruleId,
      meta: { name: rule.name },
    },
    req,
  );
  return {};
}

export async function regenerateHook(
  deps: Pick<Deps, 'db' | 'env'>,
  a: DriveActor,
  ruleId: string,
) {
  const { rule, role } = await loadRule(deps.db, a, ruleId);
  requireRules(a, role, 'automations.manage');
  const key = newSecret();
  const [row] = await deps.db
    .update(automationRules)
    .set({
      hookKeyHash: hashHookKey(key),
      hookKeyEnc: encryptShareToken(deps.env.AUTH_SECRET, key),
    })
    .where(eq(automationRules.id, rule.id))
    .returning();
  return one(deps, row!);
}

type RunRow = typeof automationRuns.$inferSelect;

export function toRun(r: RunRow): AutomationRun {
  return {
    id: r.id,
    ruleId: r.ruleId,
    status: r.status,
    triggerType: r.triggerType,
    event: r.event,
    steps: r.steps,
    error: r.error,
    test: r.test,
    depth: r.depth,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

const encodeCursor = (r: RunRow) =>
  Buffer.from(`${r.createdAt.toISOString()}|${r.id}`).toString('base64url');

export async function listRuns(
  db: DbOrTx,
  a: DriveActor,
  ruleId: string,
  q: { cursor?: string; limit: number },
) {
  const { role } = await loadRule(db, a, ruleId);
  requireRules(a, role, 'automations.view');
  let after: { at: Date; id: string } | null = null;
  if (q.cursor) {
    const [at, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    const date = new Date(at ?? '');
    if (!id || Number.isNaN(date.getTime()))
      throw new AppError('bad_request', { reason: 'cursor' });
    after = { at: date, id };
  }
  const rows = await db
    .select()
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.ruleId, ruleId),
        after
          ? or(
              lt(automationRuns.createdAt, after.at),
              and(eq(automationRuns.createdAt, after.at), lt(automationRuns.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
    .limit(q.limit + 1);
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  return { items: page.map(toRun), nextCursor: more ? encodeCursor(page[page.length - 1]!) : null };
}

/** "Şimdi dene": a run with the trigger's sample event, conditions not applied. */
export async function testRule(
  deps: Pick<Deps, 'db' | 'jobs' | 'logger'>,
  a: DriveActor,
  ruleId: string,
) {
  const { rule, role } = await loadRule(deps.db, a, ruleId);
  requireRules(a, role, 'automations.manage');
  const def = triggerDef(rule.triggerType);
  if (!def) throw new AppError('automation_trigger_unknown', { type: rule.triggerType });
  const config = def.config.parse(rule.trigger.config);
  const [run] = await deps.db
    .insert(automationRuns)
    .values({
      orgId: rule.orgId,
      ruleId: rule.id,
      triggerType: rule.triggerType,
      event: def.sample(config),
      test: true,
    })
    .returning();
  await deps.jobs.send('automation.run', { runId: run!.id });
  const [fresh] = await deps.db.select().from(automationRuns).where(eq(automationRuns.id, run!.id));
  return toRun(fresh ?? run!);
}
