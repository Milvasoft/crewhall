import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { aiRuns } from '@crewhall/db';
import { FakeProvider, systemOf } from './ai-fake-provider';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * Token economy: byte-stable cached prefixes (Claude prompt caching), cache hits in the usage
 * report, and the optional "Hızlı model" for short structured steps.
 */

let app: TestApp;
let fake: FakeProvider;
let owner: Client;
let elif: Client;

beforeAll(async () => {
  fake = await new FakeProvider().start();
  app = await createTestApp();
  ({ owner } = await setupWithOwner(app));
  elif = (await join(app, owner, 'elif@milvasoft.com', 'member')).person;
  await owner.api.call('updateAiSettings', {
    body: {
      enabled: true,
      provider: 'anthropic',
      baseUrl: fake.url,
      apiKey: 'sk-ant-test-0123456789',
      model: 'claude-sonnet-5-5',
    },
  });
});

afterAll(async () => {
  await app?.close();
  await fake?.close();
});

beforeEach(() => fake.reset());

const plan = (who: Client, request: string) =>
  who.api.call('planAiActions', { body: { request, locale: 'tr', timeZone: 'Europe/Istanbul' } });

describe('prompt caching', () => {
  it('sends fixed rules and the org context as cached blocks, the person and time in the message', async () => {
    fake.reply = JSON.stringify({ message: 'Tamam.', actions: [] });
    await plan(elif, 'yarın 10da toplantı kur');
    await plan(owner, 'bir kart aç');
    const [a, b] = fake.requests;
    // Byte-identical prefix for different people at different moments: cacheable.
    expect(a!.body.system).toEqual(b!.body.system);
    expect(a!.body.system).toEqual([
      expect.objectContaining({ cache_control: { type: 'ephemeral' } }),
      expect.objectContaining({
        text: expect.stringContaining('<people>'),
        cache_control: { type: 'ephemeral' },
      }),
    ]);
    // No current date in the cached part (the examples use a fixed, made-up one).
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(
      new Date(),
    );
    expect(systemOf(a!)).not.toContain(today);
    const message = a!.body.messages!.at(-1)!.content;
    expect(message).toMatch(/<now>\d{4}-\d{2}-\d{2} \d{2}:\d{2}, \w+ \(Europe\/Istanbul\)<\/now>/);
    expect(message).toContain('<me>');
  });

  it('records cache hits and shows them in the usage report', async () => {
    fake.usage = { input: 900, output: 20, cached: 700 };
    fake.reply = 'Kısa bir özet.';
    await elif.api.call('runAi', {
      body: { action: 'summarize', text: 'Sürüm cuma çıkıyor.', source: { kind: 'draft' } },
    });
    const [run] = await app.deps.db
      .select()
      .from(aiRuns)
      .where(eq(aiRuns.action, 'summarize'))
      .orderBy(desc(aiRuns.createdAt))
      .limit(1);
    expect(run).toMatchObject({ inputTokens: 900, cachedInputTokens: 700, outputTokens: 20 });
    const usage = await owner.api.call('getAiUsage', { query: {} });
    expect(usage.totals.cachedInputTokens).toBeGreaterThanOrEqual(700);
    expect(usage.byAction.find((x) => x.action === 'summarize')?.cachedInputTokens).toBe(700);
  });
});

describe('fast model', () => {
  it('picks Ask tools with it; plans and answers stay on the main model', async () => {
    const saved = await owner.api.call('updateAiSettings', {
      body: { fastModel: 'claude-haiku-5-5' },
    });
    expect(saved.fastModel).toBe('claude-haiku-5-5');

    fake.reply = JSON.stringify({ message: 'Tamam.', actions: [] });
    await plan(elif, 'yarın toplantı kur');
    // A plan decides what the person is asked to approve.
    expect(fake.requests[0]!.body.model).toBe('claude-sonnet-5-5');

    fake.reset();
    fake.toolCalls = [{ name: 'my_tasks', args: {} }];
    await elif.api.call('askAi', { body: { question: 'açık işlerim', locale: 'tr' } });
    expect(fake.toolRequests[0]!.body.model).toBe('claude-haiku-5-5');
    expect(fake.requests[0]!.body.model).toBe('claude-sonnet-5-5');
  });

  it('is cleared with a provider change and can be switched off', async () => {
    const off = await owner.api.call('updateAiSettings', { body: { fastModel: null } });
    expect(off.fastModel).toBeNull();
    await owner.api.call('updateAiSettings', { body: { fastModel: 'claude-haiku-5-5' } });
    const moved = await owner.api.call('updateAiSettings', {
      body: { provider: 'openai', apiKey: 'sk-openai-0123456789' },
    });
    expect(moved.fastModel).toBeNull();
  });
});
