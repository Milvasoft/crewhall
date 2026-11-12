import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { aiRuns } from '@crewhall/db';
import { toolsForIntent } from '../src/services/ai/ask-tools';
import { FakeProvider } from './ai-fake-provider';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * "Crewhall'a sor" with live data: the model picks read-only tools (function calling), they run
 * as the asker, and what they find becomes cited sources. Without function calling the
 * question's words pick them.
 */

let app: TestApp;
let fake: FakeProvider;
let owner: Client;
let elif: Client;
let elifId: string;
let spaceId: string;

const tomorrowAt = (h: number) => {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setUTCHours(h, 0, 0, 0);
  return d.toISOString();
};
const day = (iso: string) => iso.slice(0, 10);

async function ask(who: Client, question: string) {
  return who.api.call('askAi', { body: { question, locale: 'tr', timeZone: 'UTC' } });
}

const answerPrompt = () => fake.allPromptText();
const offered = () =>
  (fake.toolRequests[0]?.body.tools ?? []).map((t) => t.function?.name ?? t.name);

beforeAll(async () => {
  fake = await new FakeProvider().start();
  app = await createTestApp();
  ({ owner } = await setupWithOwner(app));
  spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!.id;
  const e = await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId]);
  elif = e.person;
  elifId = e.me.user.id;
  await owner.api.call('updateAiSettings', {
    body: { enabled: true, provider: 'openai_compatible', baseUrl: `${fake.url}/v1`, model: 'llm' },
  });

  // A meeting Elif is invited to, and one she has nothing to do with.
  await owner.api.call('createMeeting', {
    body: {
      mode: 'scheduled',
      title: 'Sprint planlama',
      startsAt: tomorrowAt(14),
      durationMinutes: 60,
      invitees: { userIds: [elifId], emails: [] },
    },
  });
  await owner.api.call('createMeeting', {
    body: {
      mode: 'scheduled',
      title: 'Bütçe görüşmesi (özel)',
      startsAt: tomorrowAt(10),
      durationMinutes: 30,
      invitees: { userIds: [], emails: [] },
    },
  });

  // Work: a card assigned to Elif, one assigned to the owner, and Elif's home to-do list.
  const board = await owner.api.call('createBoard', {
    params: { spaceId },
    body: { name: 'Altyapı işleri', template: 'sprint' },
  });
  const detail = await owner.api.call('getBoard', { params: { boardId: board.id } });
  await owner.api.call('createBoardCard', {
    params: { boardId: board.id },
    body: {
      columnId: detail.columns[0]!.id,
      title: 'Yedekleme testini yap',
      assigneeIds: [elifId],
      dueAt: tomorrowAt(9),
    },
  });
  await owner.api.call('createBoardCard', {
    params: { boardId: board.id },
    body: { columnId: detail.columns[0]!.id, title: 'Lisansları yenile' },
  });
  const mine = (await elif.api.call('listSurfaces')).items.find((s) => s.owner.type === 'user')!;
  await elif.api.call('createCard', {
    params: { surfaceId: mine.id },
    body: {
      type: 'todo',
      config: {
        title: 'Kişisel',
        items: [
          {
            id: '0190f0a0-0000-7000-8000-00000000a001',
            text: 'Elma al',
            done: false,
            doneAt: null,
          },
          {
            id: '0190f0a0-0000-7000-8000-00000000a002',
            text: 'Faturayı öde',
            done: true,
            doneAt: new Date().toISOString(),
          },
        ],
      },
    },
  });
});

afterAll(async () => {
  await app?.close();
  await fake?.close();
});

beforeEach(() => fake.reset());

describe('live data tools', () => {
  it('"yaklaşan toplantım var mı": the model asks for the calendar and cites the meeting', async () => {
    fake.toolCalls = [{ name: 'upcoming_events', args: {} }];
    fake.reply = "Evet, yarın 14:00'te 'Sprint planlama' var [1].";
    const out = await ask(elif, 'yaklaşan bir toplantım var mı');

    expect(offered()).toEqual(
      expect.arrayContaining(['upcoming_events', 'my_tasks', 'recent_meetings', 'unread_summary']),
    );
    expect(out.answer).toBe("Evet, yarın 14:00'te 'Sprint planlama' var [1].");
    expect(out.citations[0]).toMatchObject({
      n: 1,
      kind: 'meeting',
      title: 'Sprint planlama',
      at: tomorrowAt(14),
    });
    expect(out.citations[0]!.path).toMatch(/^\/meetings\/room\//);
    // Only what Elif may see: the owner's own meeting stays out.
    expect(out.citations.map((c) => c.title)).not.toContain('Bütçe görüşmesi (özel)');

    const prompt = answerPrompt();
    expect(prompt).toContain('<checked>');
    expect(prompt).toMatch(/upcoming_events .*: 1 found/);
    expect(prompt).toContain(`Meeting: Sprint planlama · ${day(tomorrowAt(14))} 14:00`);
    expect(prompt).toContain('"sen"');
    expect(prompt).not.toContain('Bütçe görüşmesi');

    // The tool choice counts to the run (and so to the quota).
    const [run] = await app.deps.db
      .select()
      .from(aiRuns)
      .where(eq(aiRuns.action, 'ask'))
      .orderBy(desc(aiRuns.createdAt))
      .limit(1);
    expect(run).toMatchObject({ inputTokens: 120 + 40, outputTokens: 30 + 12 });
  });

  it('"bana atanmış açık işler": cards assigned to the asker and open to-do items only', async () => {
    fake.toolCalls = [{ name: 'my_tasks', args: { due: 'any' } }];
    const out = await ask(elif, 'bana atanmış açık işler neler');
    const titles = out.citations.map((c) => `${c.kind}:${c.title}`);
    expect(titles).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^card:.*Yedekleme testini yap$/),
        'todo:Elma al',
      ]),
    );
    expect(titles.join()).not.toContain('Lisansları yenile');
    expect(titles.join()).not.toContain('Faturayı öde');
    const card = out.citations.find((c) => c.kind === 'card')!;
    expect(card.path).toMatch(new RegExp(`^/b/${card.boardId}/[A-Z0-9]+-\\d+$`));
    expect(out.citations.find((c) => c.kind === 'todo')!.path).toBe('/');
  });

  it('"bugün ne var": several tools at once, with dates in the asker\'s zone', async () => {
    fake.toolCalls = [
      { name: 'upcoming_events', args: { from: day(tomorrowAt(0)), to: day(tomorrowAt(0)) } },
      { name: 'my_tasks', args: { due: 'soon' } },
    ];
    const out = await ask(elif, 'yarın ne var');
    expect(out.citations.map((c) => c.kind)).toEqual(expect.arrayContaining(['meeting', 'card']));
    // Due soon: the to-do list (no dates) is not part of it.
    expect(out.citations.map((c) => c.kind)).not.toContain('todo');
    expect(answerPrompt()).toMatch(/<now>\d{4}-\d{2}-\d{2} \d{2}:\d{2}, \w+ \(UTC\)<\/now>/);
  });

  it('says plainly when a tool found nothing', async () => {
    fake.toolCalls = [{ name: 'unread_summary', args: {} }];
    const out = await ask(owner, 'okunmamış mesajım var mı');
    expect(out.citations.filter((c) => c.kind === 'message')).toEqual([]);
    expect(answerPrompt()).toMatch(/unread_summary: 0 conversations.*: 0 found/);
  });

  it("falls back to the question's intent without function calling", async () => {
    fake.noTools = true;
    const out = await ask(elif, 'yaklaşan toplantım var mı?');
    expect(fake.toolRequests).toHaveLength(1);
    expect(out.citations[0]).toMatchObject({ kind: 'meeting', title: 'Sprint planlama' });
    expect(answerPrompt()).toMatch(/upcoming_events .*: 1 found/);
  });

  it('offers no tool of a module the org turned off', async () => {
    await owner.api.call('updateOrg', {
      body: { settings: { modules: { meet: false, calendar: false } } },
    });
    try {
      fake.toolCalls = [{ name: 'upcoming_events', args: {} }];
      const out = await ask(elif, 'yaklaşan toplantım var mı');
      expect(offered()).not.toContain('upcoming_events');
      expect(offered()).not.toContain('recent_meetings');
      // A call for a tool that was not offered is ignored.
      expect(out.citations.filter((c) => c.kind === 'meeting')).toEqual([]);
    } finally {
      await owner.api.call('updateOrg', {
        body: { settings: { modules: { meet: true, calendar: true } } },
      });
    }
  });
});

describe('Drive files and mail', () => {
  it('finds files and folders by name, only where the asker can see them', async () => {
    await owner.api.call('createFolder', {
      params: { spaceId },
      body: { parentId: null, name: 'Sözleşmeler 2026' },
    });
    const mine = (await owner.api.call('listSpaces')).items.find((s) => s.kind === 'personal')!;
    await owner.api.call('createFolder', {
      params: { spaceId: mine.id },
      body: { parentId: null, name: 'Gizli sözleşmeler' },
    });
    fake.toolCalls = [{ name: 'search_files', args: { query: 'sözleşmeler' } }];
    const out = await ask(elif, 'sözleşmeler klasörü nerede');
    const found = out.citations.filter((c) => c.kind === 'folder');
    expect(found.map((c) => c.title)).toEqual(['Sözleşmeler 2026']);
    expect(found[0]).toMatchObject({ spaceId, nodeId: expect.any(String) });
    expect(answerPrompt()).toContain('Folder: Sözleşmeler 2026 · in Altyapı');
  });

  it('reads no mail without a mailbox and says so', async () => {
    fake.toolCalls = [{ name: 'unread_mail', args: {} }];
    const out = await ask(elif, 'okunmamış maillerimi özetle');
    expect(out.citations.filter((c) => c.kind === 'mail')).toEqual([]);
    expect(answerPrompt()).toMatch(/unread_mail \(no mail account set up\): 0 found/);
    expect(offered()).toContain('unread_mail');
    expect(offered()).toContain('search_files');
  });
});

describe('intent', () => {
  const all = [
    'upcoming_events',
    'my_tasks',
    'recent_meetings',
    'unread_summary',
    'search_people',
    'search_files',
    'unread_mail',
  ].map((name) => ({
    name,
    description: '',
    parameters: { type: 'object' as const, properties: {} },
  }));
  const names = (q: string) => toolsForIntent(q, all).map((c) => c.name);

  it('reads the common questions', () => {
    expect(names('yaklaşan toplantım var mı')).toEqual(['upcoming_events']);
    expect(names('bana atanmış açık işler')).toEqual(['my_tasks']);
    expect(names('bugün ne var')).toEqual(['upcoming_events', 'my_tasks']);
    expect(names('okunmamış mesajlarım')).toContain('unread_summary');
    expect(toolsForIntent('Ahmet Kaya kimdir', all)).toEqual([
      { name: 'search_people', args: { query: 'Ahmet' } },
    ]);
    expect(names('yedekleme politikası nedir')).toEqual([]);
    expect(toolsForIntent('bütçe dosyası nerede', all)).toEqual([
      { name: 'search_files', args: { query: 'bütçe' } },
    ]);
    expect(names('okunmamış maillerim')).toContain('unread_mail');
  });
});
