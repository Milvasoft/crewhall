import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { aiRuns, aiSettings, auditLogs } from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import { AI_RAW_PATHS, AiStreamEvent } from '@crewhall/shared';
import { FakeProvider } from './ai-fake-provider';
import { uuid } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** AI module A1: settings, runs (JSON and SSE), privacy, quotas, audit. No real model is called. */

const KEY = 'sk-local-0123456789abcd';
const CLAUDE_KEY = 'sk-ant-test-000000000000wxyz';

let app: TestApp;
let fake: FakeProvider;
let owner: Client;
let elif: Client;
let can: Client;
let outsider: Client;
let eceId: string;
let orgId: string;
let ownerId: string;
let elifId: string;
let canId: string;
let spaceId: string;

async function expectCode(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(status);
  expect((err as ApiError).code).toBe(code);
  return err as ApiError;
}

const useOpenAi = (extra: object = {}) =>
  owner.api.call('updateAiSettings', {
    body: {
      enabled: true,
      provider: 'openai_compatible',
      baseUrl: `${fake.url}/v1`,
      model: 'local-llm',
      apiKey: KEY,
      orgMonthlyTokens: null,
      userMonthlyTokens: null,
      ...extra,
    },
  });

const draft = (text: string) => ({ action: 'summarize', text, source: { kind: 'draft' } }) as const;

async function readStream(c: Client, body: unknown) {
  const res = await c.fetch(`http://localhost:3000${AI_RAW_PATHS.stream}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    return { status: res.status, json: JSON.parse(text) as { code: string }, events: [] };
  }
  const events = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => AiStreamEvent.parse(JSON.parse(l.slice(5))));
  return { status: res.status, json: null, events };
}

beforeAll(async () => {
  fake = await new FakeProvider().start();
  app = await createTestApp();
  const setup = await setupWithOwner(app);
  owner = setup.owner;
  orgId = setup.orgId;
  ownerId = setup.ownerId;
  spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!.id;
  const e = await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId]);
  elif = e.person;
  elifId = e.me.user.id;
  const c = await join(app, owner, 'can@milvasoft.com', 'member');
  can = c.person;
  canId = c.me.user.id;
  outsider = (await join(app, owner, 'deniz@milvasoft.com', 'member')).person;
  eceId = (await join(app, owner, 'ece@milvasoft.com', 'member')).me.user.id;
});

afterAll(async () => {
  await app?.close();
  await fake?.close();
});

beforeEach(() => {
  fake.reset();
  fake.apiKey = null;
});

describe('settings', () => {
  it('starts switched off and not configured', async () => {
    const status = await elif.api.call('getAiStatus');
    expect(status).toMatchObject({ available: false, reason: 'disabled', provider: null });
    await expectCode(elif.api.call('runAi', { body: draft('Merhaba') }), 409, 'ai_disabled');
    const settings = await owner.api.call('getAiSettings');
    expect(settings).toMatchObject({
      enabled: false,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      configured: false,
      apiKey: { set: false, hint: null },
    });
  });

  it('is for owners and admins only', async () => {
    await expectCode(elif.api.call('getAiSettings'), 403, 'forbidden');
    await expectCode(
      elif.api.call('updateAiSettings', { body: { enabled: true } }),
      403,
      'forbidden',
    );
    await expectCode(elif.api.call('getAiUsage', { query: {} }), 403, 'forbidden');
    await expectCode(elif.api.call('testAiSettings', { body: {} }), 403, 'forbidden');
  });

  it('stores the key encrypted and never returns it', async () => {
    const saved = await useOpenAi();
    expect(saved).toMatchObject({
      enabled: true,
      provider: 'openai_compatible',
      model: 'local-llm',
      baseUrl: `${fake.url}/v1`,
      configured: true,
      apiKey: { set: true, hint: 'abcd' },
    });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(JSON.stringify(await owner.api.call('getAiSettings'))).not.toContain(KEY);

    const [row] = await app.deps.db.select().from(aiSettings).where(eq(aiSettings.orgId, orgId));
    expect(row!.apiKeyEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(KEY);

    const audits = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, 'ai.settings.update')));
    expect(audits.at(-1)!.meta).toMatchObject({ key: 'set', provider: 'openai_compatible' });
    expect(JSON.stringify(audits)).not.toContain(KEY);
  });

  it('tests the connection with the stored key and with unsaved values', async () => {
    fake.apiKey = KEY;
    const ok = await owner.api.call('testAiSettings', { body: {} });
    expect(ok).toMatchObject({ ok: true, error: null });
    expect(fake.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(fake.requests[0]!.body.model).toBe('local-llm');
    expect((await owner.api.call('getAiSettings')).lastTest).toMatchObject({ ok: true });

    const wrong = await owner.api.call('testAiSettings', { body: { apiKey: 'sk-wrong-key-123' } });
    expect(wrong).toMatchObject({ ok: false, error: 'Invalid API key' });
    // A test with form values does not overwrite the stored result.
    expect((await owner.api.call('getAiSettings')).lastTest).toMatchObject({ ok: true });
  });

  it('drops the stored key when the endpoint changes without a new key', async () => {
    const moved = await owner.api.call('updateAiSettings', {
      body: { baseUrl: 'http://127.0.0.1:9/v1' },
    });
    expect(moved.apiKey.set).toBe(false);
    // The test does not send the old key to the new URL either.
    await useOpenAi();
    fake.apiKey = KEY;
    const elsewhere = await owner.api.call('testAiSettings', {
      body: { provider: 'anthropic', baseUrl: fake.url },
    });
    expect(elsewhere).toMatchObject({ ok: false, error: 'missing api key' });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('running actions', () => {
  beforeAll(() => useOpenAi());

  it('summarizes a draft, records the run and audits it "AI ile"', async () => {
    fake.reply = 'Toplantı perşembeye alındı.';
    const out = await elif.api.call('runAi', {
      body: draft('Toplantıyı salıdan perşembeye aldık, herkes takvimini güncellesin.'),
    });
    expect(out).toMatchObject({
      text: 'Toplantı perşembeye alındı.',
      usage: { inputTokens: 120, outputTokens: 30 },
      truncated: false,
    });
    const sent = fake.requests[0]!.body;
    expect(sent.model).toBe('local-llm');
    expect(sent.messages![0]!.role).toBe('system');
    expect(sent.messages![1]!.content).toContain('salıdan perşembeye');

    const [run] = await app.deps.db.select().from(aiRuns).where(eq(aiRuns.id, out.runId!));
    expect(run).toMatchObject({
      userId: elifId,
      action: 'summarize',
      targetType: 'draft',
      status: 'ok',
      inputTokens: 120,
      outputTokens: 30,
    });
    // Run rows never hold the text.
    expect(JSON.stringify(run)).not.toContain('perşembe');

    const [audit] = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'ai.run'), eq(auditLogs.actorId, elifId)));
    expect(audit!.via).toMatchObject({
      kind: 'ai',
      provider: 'openai_compatible',
      model: 'local-llm',
      runId: out.runId,
    });
  });

  it('builds each action prompt (rewrite tone, translate, continue)', async () => {
    const node = { kind: 'draft' } as const;
    await elif.api.call('runAi', {
      body: { action: 'rewrite', tone: 'formal', text: 'selam, yarın gel', source: node },
    });
    await elif.api.call('runAi', {
      body: { action: 'translate', targetLang: 'en', text: 'Merhaba dünya', source: node },
    });
    await elif.api.call('runAi', {
      body: { action: 'continue', text: 'Bu çeyrekte üç hedefimiz var:', source: node },
    });
    const systems = fake.requests.map((r) => r.body.messages![0]!.content);
    expect(systems[0]).toContain('formal');
    expect(systems[1]).toContain('into English');
    expect(systems[2]).toContain('Continue writing');
  });

  it('reports a length cut and estimates tokens when the server reports none', async () => {
    fake.mode = 'length';
    const cut = await elif.api.call('runAi', { body: draft('uzun metin') });
    expect(cut.truncated).toBe(true);
    fake.mode = 'no_usage';
    fake.reply = 'x'.repeat(40);
    const est = await elif.api.call('runAi', { body: draft('başka metin') });
    expect(est.usage.outputTokens).toBe(10);
    expect(est.usage.inputTokens).toBeGreaterThan(0);
  });

  it('maps provider failures and refusals to their codes and records them', async () => {
    fake.mode = 'unauthorized';
    const err = await expectCode(
      elif.api.call('runAi', { body: draft('metin') }),
      409,
      'ai_not_configured',
    );
    expect(err.details).toMatchObject({ reason: 'provider_auth', message: 'Invalid API key' });
    fake.mode = 'rate_limit';
    await expectCode(elif.api.call('runAi', { body: draft('metin') }), 429, 'rate_limited');
    fake.mode = 'quota';
    const quota = await expectCode(
      elif.api.call('runAi', { body: draft('metin') }),
      429,
      'ai_quota_exceeded',
    );
    expect(quota.details).toMatchObject({ scope: 'provider' });
    fake.mode = 'refuse';
    await expectCode(elif.api.call('runAi', { body: draft('metin') }), 422, 'ai_refused');
    const failed = await app.deps.db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.userId, elifId), eq(aiRuns.status, 'error')));
    expect(failed.length).toBeGreaterThan(0);
  });

  it('rejects sources that are not a node or a draft (no vault)', async () => {
    const res = await elif.raw('POST', '/api/v1/ai/run', {
      action: 'summarize',
      text: 'parola',
      source: { kind: 'vault', itemId: uuid() },
    });
    expect(res.status).toBe(422);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('privacy: only what the caller can see', () => {
  let pageId: string;

  beforeAll(async () => {
    await useOpenAi();
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Altyapı planı' },
    });
    pageId = page.id;
  });

  it('runs on a page the caller can view and records it as the target', async () => {
    const out = await elif.api.call('runAi', {
      body: { action: 'summarize', text: 'Plan metni', source: { kind: 'node', nodeId: pageId } },
    });
    const [run] = await app.deps.db.select().from(aiRuns).where(eq(aiRuns.id, out.runId!));
    expect(run).toMatchObject({ targetType: 'node', targetId: pageId });
  });

  it('refuses a page the caller cannot see, before calling the model', async () => {
    await expectCode(
      can.api.call('runAi', {
        body: {
          action: 'summarize',
          text: 'Plan metni',
          source: { kind: 'node', nodeId: pageId },
        },
      }),
      404,
      'not_found',
    );
    expect(fake.requests).toHaveLength(0);
  });

  it('accepting a result writes "AI ile" on the page, once, only for its author', async () => {
    const out = await elif.api.call('runAi', {
      body: {
        action: 'rewrite',
        tone: 'concise',
        text: 'Plan metni',
        source: { kind: 'node', nodeId: pageId },
      },
    });
    await expectCode(
      owner.api.call('acceptAiRun', { params: { runId: out.runId! }, body: {} }),
      404,
      'ai_run_not_found',
    );
    await elif.api.call('acceptAiRun', { params: { runId: out.runId! }, body: {} });
    await expectCode(
      elif.api.call('acceptAiRun', { params: { runId: out.runId! }, body: {} }),
      404,
      'ai_run_not_found',
    );
    const rows = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'ai.suggestion.accept'), eq(auditLogs.targetId, pageId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: elifId, targetType: 'node' });
    expect(rows[0]!.via).toMatchObject({ kind: 'ai', runId: out.runId });
  });
});

describe('chat: summarize unread', () => {
  let groupId: string;
  const send = (c: Client, text: string) =>
    c.api.call('sendMessage', {
      params: { conversationId: groupId },
      body: { clientMsgId: uuid(), text },
    });

  beforeAll(async () => {
    await useOpenAi();
    const group = await owner.api.call('createConversation', {
      body: { type: 'group', userIds: [elifId, eceId], name: 'Sürüm ekibi' },
    });
    groupId = group.id;
    await send(owner, 'GIZLI-ESKI: Can katılmadan önce konuşulan maaş konusu');
    await owner.api.call('addConversationMembers', {
      params: { conversationId: groupId },
      body: { userIds: [canId], history: 'none' },
    });
    await send(owner, 'Sürüm cuma 17:00 da çıkıyor.');
    await send(elif, `<@${canId}> test raporunu perşembeye yetiştirebilir misin?`);
    const wrong = await send(elif, 'SILINEN: yanlış kanala yazdım');
    await elif.api.call('deleteMessage', { params: { messageId: wrong.id } });
  });

  it('sends only the unread messages the caller may see', async () => {
    fake.reply = '- Sürüm cuma 17:00.\n- Elif test raporunu soruyor.';
    const out = await can.api.call('runAi', {
      body: { action: 'summarize_unread', conversationId: groupId, locale: 'tr' },
    });
    expect(out.text).toContain('Sürüm cuma');
    expect(out.messages).toBe(2);
    const prompt = fake.allPromptText();
    expect(prompt).toContain('Sürüm cuma 17:00 da çıkıyor.');
    expect(prompt).toContain('@can test raporunu');
    expect(prompt).toContain('in Turkish');
    expect(prompt).not.toContain('GIZLI-ESKI');
    expect(prompt).not.toContain('SILINEN');
    const [run] = await app.deps.db.select().from(aiRuns).where(eq(aiRuns.id, out.runId!));
    expect(run).toMatchObject({ targetType: 'conversation', targetId: groupId });
  });

  it('calls no model when nothing is unread', async () => {
    const msgs = await can.api.call('listMessages', {
      params: { conversationId: groupId },
      query: {},
    });
    await can.api.call('markConversationRead', {
      params: { conversationId: groupId },
      body: { seq: msgs.lastSeq },
    });
    const out = await can.api.call('runAi', {
      body: { action: 'summarize_unread', conversationId: groupId },
    });
    expect(out).toMatchObject({ runId: null, text: '', messages: 0 });
    expect(fake.requests).toHaveLength(0);

    // The client's divider (read position when the chat was opened) still works, but never
    // reaches history from before Can joined.
    const again = await can.api.call('runAi', {
      body: { action: 'summarize_unread', conversationId: groupId, afterSeq: 0 },
    });
    expect(again.messages).toBe(2);
    expect(fake.allPromptText()).not.toContain('GIZLI-ESKI');
  });

  it('is 404 for someone outside the conversation', async () => {
    await expectCode(
      outsider.api.call('runAi', { body: { action: 'summarize_unread', conversationId: groupId } }),
      404,
      'not_found',
    );
    expect(fake.requests).toHaveLength(0);
  });
});

describe('streaming (SSE)', () => {
  beforeAll(() => useOpenAi());

  it('streams start, deltas and done', async () => {
    fake.reply = 'Akışla gelen bir cevap.';
    const { status, events } = await readStream(elif, draft('akış metni'));
    expect(status).toBe(200);
    expect(events[0]).toMatchObject({ type: 'start' });
    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => (d.type === 'delta' ? d.text : '')).join('')).toBe(
      'Akışla gelen bir cevap.',
    );
    const done = events.at(-1)!;
    expect(done).toMatchObject({ type: 'done', usage: { inputTokens: 120, outputTokens: 30 } });
    const start = events[0]!;
    expect(start.type === 'start' && done.type === 'done' && start.runId === done.runId).toBe(true);
  });

  it('reports provider failures as an error event', async () => {
    fake.mode = 'unauthorized';
    const { events } = await readStream(elif, draft('akış metni'));
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'ai_not_configured' });
  });

  it('answers checks that fail before the stream with a JSON error', async () => {
    const bad = await readStream(elif, { action: 'summarize', text: '' });
    expect(bad.status).toBe(422);
    const anon = new Client(app);
    const res = await readStream(anon, draft('x'));
    expect(res.status).toBe(401);
  });
});

describe('Claude API provider', () => {
  it('uses the SDK with the stored key and the default model', async () => {
    const saved = await owner.api.call('updateAiSettings', {
      body: { provider: 'anthropic', baseUrl: fake.url, apiKey: CLAUDE_KEY },
    });
    expect(saved).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      apiKey: { hint: 'wxyz' },
    });
    fake.apiKey = CLAUDE_KEY;
    fake.reply = 'Claude cevabı.';
    const out = await elif.api.call('runAi', { body: draft('Claude ile özetle') });
    expect(out).toMatchObject({
      text: 'Claude cevabı.',
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    const req = fake.requests[0]!;
    expect(req.path).toBe('/v1/messages');
    expect(req.headers.authorization ?? req.headers['x-api-key']).toMatch(CLAUDE_KEY);
    expect(req.body).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      output_config: { effort: 'low' },
    });
    // The fixed instructions go as a cached block (prompt caching).
    expect(req.body.system).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('Summarize'),
        cache_control: { type: 'ephemeral' },
      }),
    ]);

    fake.mode = 'refuse';
    await expectCode(elif.api.call('runAi', { body: draft('x') }), 422, 'ai_refused');
    fake.mode = 'unauthorized';
    const err = await expectCode(
      elif.api.call('runAi', { body: draft('x') }),
      409,
      'ai_not_configured',
    );
    expect(err.details).toMatchObject({ message: 'invalid api key', kind: 'auth' });
  });
});

describe('quotas, usage and the module switch', () => {
  beforeAll(() => useOpenAi());

  it('stops a person at their monthly quota', async () => {
    await useOpenAi({ userMonthlyTokens: 1 });
    // Elif already used tokens this month.
    const status = await elif.api.call('getAiStatus');
    expect(status).toMatchObject({ available: false, reason: 'quota' });
    expect(status.quota.user.usedTokens).toBeGreaterThan(1);
    const err = await expectCode(
      elif.api.call('runAi', { body: draft('x') }),
      429,
      'ai_quota_exceeded',
    );
    expect(err.details).toMatchObject({ scope: 'user' });
    // Others still have theirs.
    await expect(outsider.api.call('runAi', { body: draft('x') })).resolves.toBeTruthy();
  });

  it('stops everyone at the org quota', async () => {
    await useOpenAi({ orgMonthlyTokens: 100 });
    const err = await expectCode(
      outsider.api.call('runAi', { body: draft('x') }),
      429,
      'ai_quota_exceeded',
    );
    expect(err.details).toMatchObject({ scope: 'org' });
    await useOpenAi();
  });

  it('reports usage by person and action', async () => {
    const report = await owner.api.call('getAiUsage', { query: {} });
    expect(report.totals.runs).toBeGreaterThan(5);
    expect(report.byUser.find((u) => u.user.id === elifId)?.runs).toBeGreaterThan(3);
    expect(report.byAction.map((a) => a.action)).toEqual(
      expect.arrayContaining(['summarize', 'rewrite', 'summarize_unread']),
    );
    expect(report.days).toHaveLength(1);
    const empty = await owner.api.call('getAiUsage', { query: { month: '2020-01' } });
    expect(empty.totals.runs).toBe(0);
  });

  it('answers module_disabled when the org turns the ai module off', async () => {
    await owner.api.call('updateOrg', { body: { settings: { modules: { ai: false } } } });
    expect((await elif.api.call('me')).modules).not.toContain('ai');
    await expectCode(elif.api.call('runAi', { body: draft('x') }), 403, 'module_disabled');
    await expectCode(elif.api.call('getAiStatus'), 403, 'module_disabled');
    const stream = await readStream(elif, draft('x'));
    expect(stream.status).toBe(403);
    expect(stream.json).toMatchObject({ code: 'module_disabled' });
    await owner.api.call('updateOrg', { body: { settings: { modules: { ai: true } } } });
    await expect(elif.api.call('getAiStatus')).resolves.toBeTruthy();
    expect(ownerId).toBeTruthy();
  });
});
