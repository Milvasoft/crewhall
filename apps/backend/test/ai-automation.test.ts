import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { aiRuns, boardCards } from '@crewhall/db';
import { FakeProvider } from './ai-fake-provider';
import { Client, createTestApp, setupWithOwner, type TestApp } from './helpers';

/** "AI adımı" in automation rules (yol haritası #17 + #18). */

let app: TestApp;
let fake: FakeProvider;
let owner: Client;
let spaceId: string;
let boardId: string;
let todo: string;
let done: string;

beforeAll(async () => {
  fake = await new FakeProvider().start();
  app = await createTestApp();
  ({ owner } = await setupWithOwner(app));
  spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!.id;
  boardId = (
    await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Destek', template: 'sprint' },
    })
  ).id;
  const detail = await owner.api.call('getBoard', { params: { boardId } });
  todo = detail.columns[0]!.id;
  done = detail.columns.at(-1)!.id;
  await owner.api.call('updateAiSettings', {
    body: { enabled: true, provider: 'openai_compatible', baseUrl: `${fake.url}/v1`, model: 'llm' },
  });
});

afterAll(async () => {
  await app?.close();
  await fake?.close();
});

beforeEach(() => fake.reset());

const rule = () =>
  owner.api.call('createAutomationRule', {
    params: { spaceId },
    body: {
      name: 'Biten kartı özetle',
      trigger: { type: 'boards.card_moved', config: { boardId, toColumnId: done } },
      actions: [
        {
          id: 'ozet',
          type: 'ai.step',
          config: { prompt: 'Bu kartı tek cümleyle özetle: {{card.title}}' },
        },
        {
          id: 'kart',
          type: 'boards.create_card',
          config: { boardId, columnId: todo, title: 'Özet: {{steps.ozet.text}}' },
        },
      ],
    },
  });

describe('AI step', () => {
  it('is in the automation catalog', async () => {
    const cat = await owner.api.call('getAutomationCatalog');
    expect(cat.actions.find((a) => a.type === 'ai.step')).toMatchObject({
      module: 'ai',
      available: true,
      fields: [{ key: 'prompt', kind: 'template', required: true }],
    });
  });

  it('gives its answer to the next steps and counts as the owner run', async () => {
    fake.reply = 'Sunucu taşıma tamamlandı.';
    const r = await rule();
    const run = await owner.api.call('testAutomationRule', { params: { ruleId: r.id } });
    expect(run.steps.map((s) => [s.actionId, s.status])).toEqual([
      ['ozet', 'succeeded'],
      ['kart', 'succeeded'],
    ]);
    expect(run.steps[0]!.output).toMatchObject({ text: 'Sunucu taşıma tamamlandı.' });
    const prompt = fake.allPromptText();
    expect(prompt).toContain('<instruction>Bu kartı tek cümleyle özetle:');
    expect(prompt).toContain('<event type="boards.card_moved">');
    const cards = await app.deps.db
      .select()
      .from(boardCards)
      .where(eq(boardCards.boardNodeId, boardId));
    expect(cards.map((c) => c.title)).toContain('Özet: Sunucu taşıma tamamlandı.');
    const runs = await app.deps.db.select().from(aiRuns).where(eq(aiRuns.action, 'automation'));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ targetType: 'automation', targetId: r.id });
  });

  it('fails the step (and skips the rest) while AI is off', async () => {
    await owner.api.call('updateAiSettings', { body: { enabled: false } });
    const r = await rule();
    const run = await owner.api.call('testAutomationRule', { params: { ruleId: r.id } });
    expect(run.steps.map((s) => s.status)).toEqual(['failed', 'skipped']);
    expect(run.steps[0]!.error?.code).toBe('ai_disabled');
    expect(fake.requests).toHaveLength(0);
    await owner.api.call('updateAiSettings', { body: { enabled: true } });
  });
});
