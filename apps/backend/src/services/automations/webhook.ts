import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { automationRules } from '@crewhall/db';
import { AUTOMATION_LIMITS } from '@crewhall/shared';
import type { Context } from 'hono';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { BlockedAddressError, outboundFetch } from '../../net/outbound';
import type { AppEnv } from '../../http/types';
import { emitAutomationEvent } from './emit';
import type { ActionContext } from './registry';
import { allowRate } from './rate';

/**
 * Webhooks of the automations module (roadmap 17): the incoming trigger
 * (`POST /api/automations/hooks/<ruleId>?key=…`) and the outgoing action, signed with the
 * rule's secret. Loop guard across systems: outgoing calls carry X-Crewhall-Chain, and an
 * incoming call that sends it back continues that chain.
 */

export const hashHookKey = (key: string) => createHash('sha256').update(key).digest('hex');

/* --------------------------------- outgoing --------------------------------- */

/** POSTs the event as JSON; non-2xx fails the step. Returns the HTTP status. */
export async function postWebhook(target: string, ctx: ActionContext) {
  const url = new URL(target);
  const body = JSON.stringify({
    rule: { id: ctx.rule.id, name: ctx.rule.name },
    run: { id: ctx.run.id },
    event: { type: ctx.event.type, data: ctx.event.data },
    steps: ctx.steps,
    sentAt: new Date().toISOString(),
  });
  const signature = createHmac('sha256', ctx.rule.signingSecret).update(body).digest('hex');
  let res: Response;
  try {
    // Private and loopback receivers only through PRIVATE_FETCH_ALLOWLIST (intranet n8n);
    // the receiver must answer directly, without a redirect.
    res = await outboundFetch(url, {
      method: 'POST',
      redirect: 'manual',
      timeoutMs: AUTOMATION_LIMITS.webhookTimeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Crewhall-Automations/1',
        'X-Crewhall-Event': ctx.event.type,
        'X-Crewhall-Run': ctx.run.id,
        'X-Crewhall-Chain': [...ctx.run.chain, ctx.rule.id].join(','),
        'X-Crewhall-Signature': `sha256=${signature}`,
      },
      body,
    });
  } catch (err) {
    if (err instanceof BlockedAddressError) {
      throw new AppError('automation_webhook_blocked', { host: err.host });
    }
    throw new AppError('automation_webhook_failed', {
      reason: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network',
    });
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.status < 200 || res.status >= 300) {
    throw new AppError('automation_webhook_failed', { status: res.status });
  }
  return res.status;
}

/* --------------------------------- incoming --------------------------------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The incoming webhook: JSON body (or text) becomes the event's `body`. */
export async function receiveHook(deps: Deps, c: Context<AppEnv>) {
  const ruleId = c.req.param('ruleId') ?? '';
  const key = c.req.query('key') ?? '';
  if (!UUID.test(ruleId) || !key) throw new AppError('not_found');
  const [rule] = await deps.db.select().from(automationRules).where(eq(automationRules.id, ruleId));
  const expected = rule?.hookKeyHash ? Buffer.from(rule.hookKeyHash, 'hex') : null;
  const given = Buffer.from(hashHookKey(key), 'hex');
  if (!rule || !expected || expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new AppError('not_found');
  }
  if (rule.triggerType !== 'webhook.received') throw new AppError('not_found');
  if (!allowRate(`hook:${rule.id}`, AUTOMATION_LIMITS.hookPerMinute, 60_000)) {
    c.header('Retry-After', '60');
    throw new AppError('rate_limited');
  }
  const raw = await c.req.text();
  if (Buffer.byteLength(raw) > AUTOMATION_LIMITS.hookBodyBytes) {
    return c.json({ code: 'payload_too_large' }, 413);
  }
  const contentType = c.req.header('content-type') ?? '';
  let body: unknown = raw;
  if (/json/i.test(contentType) || /^[[{]/.test(raw.trim())) {
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      throw new AppError('bad_request', { reason: 'invalid_json' });
    }
  }
  const chain = (c.req.header('x-crewhall-chain') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => UUID.test(s))
    .slice(0, AUTOMATION_LIMITS.maxDepth + 1);
  const queued = await emitAutomationEvent(
    deps,
    {
      orgId: rule.orgId,
      spaceId: rule.spaceId,
      type: 'webhook.received',
      data: { body, contentType },
      match: { ruleId: rule.id },
    },
    { origin: { chain, depth: chain.length }, ruleId: rule.id },
  );
  return c.json({ accepted: queued.length > 0, runs: queued }, 202);
}
