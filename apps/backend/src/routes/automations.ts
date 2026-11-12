import { AUTOMATION_RAW_PATHS } from '@crewhall/shared';
import type { Router } from '../http/route';
import { catalog } from '../services/automations/registry';
import * as rules from '../services/automations/rules';
import { receiveHook } from '../services/automations/webhook';
import '../services/automations/builtin';
import '../services/ai/automation';
import { driveActor } from './drive';

/** Automations module routes (roadmap 17); endpoints come from packages/shared/src/endpoints/automations.ts. */
export function registerAutomations(r: Router) {
  r.org('getAutomationCatalog', async (ctx) => catalog(ctx.org.settings));
  r.org('listAutomationRules', async (ctx) =>
    rules.listRules(ctx.deps, driveActor(ctx), ctx.params.spaceId),
  );
  r.org(
    'createAutomationRule',
    async (ctx) =>
      rules.createRule(ctx.deps, driveActor(ctx), ctx.params.spaceId, ctx.body, ctx.req),
    { status: 201 },
  );
  r.org('getAutomationRule', async (ctx) =>
    rules.getRule(ctx.deps, driveActor(ctx), ctx.params.ruleId),
  );
  r.org('updateAutomationRule', async (ctx) =>
    rules.updateRule(ctx.deps, driveActor(ctx), ctx.params.ruleId, ctx.body, ctx.req),
  );
  r.org('deleteAutomationRule', async (ctx) =>
    rules.deleteRule(ctx.deps, driveActor(ctx), ctx.params.ruleId, ctx.req),
  );
  r.org(
    'testAutomationRule',
    async (ctx) => rules.testRule(ctx.deps, driveActor(ctx), ctx.params.ruleId),
    {
      status: 201,
    },
  );
  r.org('regenerateAutomationHook', async (ctx) =>
    rules.regenerateHook(ctx.deps, driveActor(ctx), ctx.params.ruleId),
  );
  r.org('listAutomationRuns', async (ctx) =>
    rules.listRuns(ctx.deps.db, driveActor(ctx), ctx.params.ruleId, ctx.query),
  );
  // Incoming webhook trigger: key in the URL, no session.
  r.rawPublic('POST', AUTOMATION_RAW_PATHS.hook, ({ c, deps }) => receiveHook(deps, c));
}
