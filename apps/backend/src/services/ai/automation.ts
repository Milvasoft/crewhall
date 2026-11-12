import { eq } from 'drizzle-orm';
import { users } from '@crewhall/db';
import { resolveLocale } from '@crewhall/i18n';
import type { OrgSettings } from '@crewhall/shared';
import { z } from 'zod';
import { registerAction } from '../automations/registry';
import { automationPrompt } from './prompts';
import { executeRun, usableSettings, type AiCaller } from './run';
import { modelConfigOf } from './settings';

/**
 * "AI adımı" for automation rules (yol haritası #17 and #18). The rule's instruction, with the
 * event filled into its `{{…}}` placeholders, goes to the org model; the answer is the step's
 * `text` output, so the next steps can use it (`{{steps.<step id>.text}}`, e.g. "summarize the
 * form answer, then post it to the chat"). It runs as the rule's owner: their quota, and only
 * the event the rule already saw with their rights. Vault content is never part of an event.
 */

/** Longest answer kept in the run history and given to the next steps. */
const OUTPUT_CHARS = 4_000;

registerAction({
  type: 'ai.step',
  module: 'ai',
  config: z.object({ prompt: z.string().trim().min(1).max(4_000) }),
  fields: [{ key: 'prompt', kind: 'template', required: true, options: [], dependsOn: null }],
  async run(ctx, c) {
    const [person] = await ctx.deps.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, ctx.actor.userId));
    const caller: AiCaller = { ...ctx.actor, userName: person?.name ?? '' };
    const settings = await usableSettings(ctx.deps, caller);
    const locale = resolveLocale(
      (ctx.actor.org.settings as Partial<OrgSettings>).defaultLocale ?? null,
    );
    const out = await executeRun(
      ctx.deps,
      caller,
      {
        kind: 'model',
        action: 'automation',
        config: modelConfigOf(ctx.deps, settings),
        prompt: automationPrompt(ctx.render(c.prompt), ctx.event, locale),
        target: { type: 'automation', id: ctx.rule.id },
      },
      { ip: null, userAgent: 'automation', locale },
      {},
    );
    return { text: out.text.trim().slice(0, OUTPUT_CHARS), runId: out.runId };
  },
});
