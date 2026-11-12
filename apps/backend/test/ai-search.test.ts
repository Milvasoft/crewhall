import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pages, searchChunks } from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import { AI_RAW_PATHS, AiStreamEvent } from '@crewhall/shared';
import { sweepSearch } from '../src/services/ai/search/indexer';
import { FakeProvider } from './ai-fake-provider';
import { uuid } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, uploadFile, type TestApp } from './helpers';

/** "Crewhall'a sor" (yol haritası #11): index, permission-checked search, answers with sources. */

let app: TestApp;
let fake: FakeProvider;
let owner: Client;
let elif: Client;
let can: Client;
let elifId: string;
let eceId: string;
let spaceId: string;
let pageId: string;
let groupId: string;
let cardId: string;
let boardId: string;

const sweep = () => sweepSearch(app.deps);

async function expectCode(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(status);
  expect((err as ApiError).code).toBe(code);
}

const kindsOf = async (c: Client, q: string) =>
  (await c.api.call('searchAi', { query: { q } })).items.map((h) => `${h.kind}:${h.title}`);

beforeAll(async () => {
  fake = await new FakeProvider().start();
  app = await createTestApp();
  ({ owner } = await setupWithOwner(app));
  spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!.id;
  const e = await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId]);
  elif = e.person;
  elifId = e.me.user.id;
  can = (await join(app, owner, 'can@milvasoft.com', 'member')).person;
  eceId = (await join(app, owner, 'ece@milvasoft.com', 'member')).me.user.id;

  // A page whose body the wiki worker derived from its Yjs state.
  const page = await owner.api.call('createPage', {
    params: { spaceId },
    body: { name: 'Veri merkezi taşıma planı' },
  });
  pageId = page.id;
  await app.deps.db
    .update(pages)
    .set({
      bodyText:
        'Sunucular cuma gecesi Ankara veri merkezine taşınacak. Bakım penceresi 02:00-04:00 arası.',
      derivedRev: 1,
    })
    .where(eq(pages.nodeId, pageId));

  await owner.api.call('createFolder', {
    params: { spaceId },
    body: { parentId: null, name: 'Taşıma tutanakları' },
  });

  const board = await owner.api.call('createBoard', {
    params: { spaceId },
    body: { name: 'Altyapı işleri', template: 'sprint' },
  });
  boardId = board.id;
  const detail = await owner.api.call('getBoard', { params: { boardId } });
  const card = await owner.api.call('createBoardCard', {
    params: { boardId },
    body: {
      columnId: detail.columns[0]!.id,
      title: 'Yedek jeneratör testi',
      description: 'Taşımadan önce jeneratörü dene',
    },
  });
  cardId = card.id;

  const group = await owner.api.call('createConversation', {
    body: { type: 'group', userIds: [elifId, eceId], name: 'Taşıma ekibi' },
  });
  groupId = group.id;
  await owner.api.call('sendMessage', {
    params: { conversationId: groupId },
    body: { clientMsgId: uuid(), text: 'Taşıma için kamyon perşembe 18:00de geliyor' },
  });

  await owner.api.call('updateAiSettings', {
    body: {
      enabled: true,
      provider: 'openai_compatible',
      baseUrl: `${fake.url}/v1`,
      model: 'local-llm',
    },
  });
  await sweep();
});

afterAll(async () => {
  await app?.close();
  await fake?.close();
});

beforeEach(() => fake.reset());

describe('index', () => {
  it('indexes pages, Drive items, cards and messages, never the vault', async () => {
    const rows = await app.deps.db.select().from(searchChunks);
    const kinds = new Set(rows.map((r) => r.kind));
    expect([...kinds].sort()).toEqual(['board', 'card', 'folder', 'message', 'page']);
    expect(rows.find((r) => r.refId === pageId)?.body).toContain('Ankara');
    expect(rows.find((r) => r.refId === cardId)).toMatchObject({ nodeId: boardId, spaceId });
    // A second sweep finds nothing changed.
    expect((await sweep()).indexed).toBe(0);
  });

  it('follows edits and deletions', async () => {
    await app.deps.db
      .update(pages)
      .set({ bodyText: 'Ankara yerine İzmir veri merkezi seçildi.', derivedRev: 2 })
      .where(eq(pages.nodeId, pageId));
    await app.deps.db.execute(sql`update nodes set updated_at = now() where id = ${pageId}`);
    const msg = await owner.api.call('sendMessage', {
      params: { conversationId: groupId },
      body: { clientMsgId: uuid(), text: 'GECICI-MESAJ yanlışlıkla yazıldı' },
    });
    await sweep();
    expect(await kindsOf(elif, 'İzmir')).toContain('page:Veri merkezi taşıma planı');
    expect(await kindsOf(elif, 'GECICI')).toEqual(['message:Taşıma ekibi']);
    await owner.api.call('deleteMessage', { params: { messageId: msg.id } });
    await sweep();
    expect(await kindsOf(elif, 'GECICI')).toEqual([]);
  });
});

describe('file contents (roadmap 10)', () => {
  it('indexes the extracted text of a file', async () => {
    const up = await uploadFile(owner, {
      spaceId,
      name: 'kira-sozlesmesi.txt',
      content: Buffer.from('Kira bedeli her yıl TÜFE oranında artırılır.'),
      mime: 'text/plain',
    });
    await sweep();
    const { items } = await elif.api.call('searchAi', { query: { q: 'TÜFE oranı' } });
    expect(items.map((h) => h.refId)).toContain(up.node.id);
    expect(items.find((h) => h.refId === up.node.id)?.snippet).toContain('TÜFE');
    expect(await kindsOf(can, 'TÜFE')).toEqual([]);
  });
});

describe('search', () => {
  it('returns only what the caller may open', async () => {
    const forElif = await kindsOf(elif, 'taşıma');
    expect(forElif).toEqual(
      expect.arrayContaining([
        'page:Veri merkezi taşıma planı',
        'folder:Taşıma tutanakları',
        'message:Taşıma ekibi',
        'card:Yedek jeneratör testi',
      ]),
    );
    // Can is neither in the Altyapı space nor in the conversation.
    expect(await kindsOf(can, 'taşıma')).toEqual([]);
  });

  it('gives what a client needs to open each hit', async () => {
    const { items } = await elif.api.call('searchAi', { query: { q: 'jeneratör' } });
    expect(items[0]).toMatchObject({
      kind: 'card',
      boardId,
      cardNumber: expect.any(Number),
      snippet: expect.stringContaining('jeneratör'),
    });
    const msg = (await elif.api.call('searchAi', { query: { q: 'kamyon', kinds: 'message' } }))
      .items[0];
    expect(msg).toMatchObject({
      kind: 'message',
      conversationId: groupId,
      seq: expect.any(Number),
    });
  });

  it('drops a module the org turned off', async () => {
    await owner.api.call('updateOrg', { body: { settings: { modules: { chat: false } } } });
    expect((await kindsOf(elif, 'taşıma')).some((k) => k.startsWith('message:'))).toBe(false);
    await owner.api.call('updateOrg', { body: { settings: { modules: { chat: true } } } });
  });
});

describe("Crewhall'a sor", () => {
  it('answers from numbered sources the asker can see', async () => {
    fake.reply = 'Taşıma cuma gecesi yapılacak [1].';
    const out = await elif.api.call('askAi', {
      body: { question: 'Sunucular ne zaman taşınıyor?', locale: 'tr' },
    });
    expect(out.answer).toBe('Taşıma cuma gecesi yapılacak [1].');
    expect(out.citations[0]).toMatchObject({ n: 1 });
    expect(out.citations.map((c) => c.kind)).toContain('page');
    const prompt = fake.allPromptText();
    expect(prompt).toContain('<source n="1"');
    expect(prompt).toContain('Sunucular ne zaman taşınıyor?');
    expect(prompt).toContain('in Turkish');
  });

  it('sends nothing the asker cannot open to the model', async () => {
    await can.api.call('askAi', { body: { question: 'Taşıma planı nedir?' } });
    const prompt = fake.allPromptText();
    expect(prompt).toContain('<sources>\n(none)\n</sources>');
    expect(prompt).not.toContain('İzmir');
    expect(prompt).not.toContain('kamyon');
  });

  it('streams citations first, then the answer', async () => {
    fake.reply = 'Kamyon perşembe geliyor [1].';
    const res = await elif.fetch(`http://localhost:3000${AI_RAW_PATHS.ask}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Kamyon ne zaman geliyor?' }),
    });
    const events = (await res.text())
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => AiStreamEvent.parse(JSON.parse(l.slice(5))));
    expect(events[0]?.type).toBe('citations');
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['citations', 'start', 'delta', 'done']),
    );
    const text = events.map((e) => (e.type === 'delta' ? e.text : '')).join('');
    expect(text).toBe('Kamyon perşembe geliyor [1].');
  });

  it('needs a configured model; search does not', async () => {
    await owner.api.call('updateAiSettings', { body: { enabled: false } });
    await expectCode(elif.api.call('askAi', { body: { question: 'x' } }), 409, 'ai_disabled');
    await expect(elif.api.call('searchAi', { query: { q: 'taşıma' } })).resolves.toBeTruthy();
    await owner.api.call('updateAiSettings', { body: { enabled: true } });
  });
});

describe('with the ai module off', () => {
  const plain = async (c: Client, q: string) =>
    (await c.api.call('searchContent', { query: { q } })).items.map((h) => `${h.kind}:${h.title}`);
  const modules = (settings: { ai?: boolean; chat?: boolean }) =>
    owner.api.call('updateOrg', { body: { settings: { modules: settings } } });

  beforeAll(() => modules({ ai: false }));
  afterAll(() => modules({ ai: true }));

  it('closes ai search and questions', async () => {
    await expectCode(elif.api.call('searchAi', { query: { q: 'taşıma' } }), 403, 'module_disabled');
    await expectCode(elif.api.call('askAi', { body: { question: 'x' } }), 403, 'module_disabled');
  });

  it('plain search stays open and the index keeps following', async () => {
    await owner.api.call('sendMessage', {
      params: { conversationId: groupId },
      body: { clientMsgId: uuid(), text: 'YAPAYZEKASIZ arama da bunu bulmalı' },
    });
    await sweep();
    expect(await plain(elif, 'YAPAYZEKASIZ')).toEqual(['message:Taşıma ekibi']);
    expect(await plain(elif, 'taşıma')).toEqual(
      expect.arrayContaining(['page:Veri merkezi taşıma planı', 'card:Yedek jeneratör testi']),
    );
  });

  it('plain search keeps the same limits on what one may see', async () => {
    expect(await plain(can, 'taşıma')).toEqual([]);
    await modules({ ai: false, chat: false });
    expect((await plain(elif, 'taşıma')).some((k) => k.startsWith('message:'))).toBe(false);
    await modules({ ai: false, chat: true });
  });
});

describe('semantic search', () => {
  it('embeds chunks with the org model and searches by similarity', async () => {
    await owner.api.call('updateAiSettings', { body: { embeddingModel: 'bge-m3' } });
    const status = await owner.api.call('rebuildAiIndex', { body: {} });
    expect(status).toMatchObject({
      embeddings: true,
      vector: expect.stringMatching(/pgvector|array/),
    });
    expect(status.embedded).toBe(status.chunks);
    expect(fake.requests.some((r) => r.path.endsWith('/embeddings'))).toBe(true);

    fake.reset();
    const { items } = await elif.api.call('searchAi', { query: { q: 'jeneratörün denemesi' } });
    expect(items[0]?.kind).toBe('card');
    expect(fake.requests.some((r) => r.path.endsWith('/embeddings'))).toBe(true);
    // Can still sees nothing, semantic or not.
    expect(await kindsOf(can, 'jeneratörün denemesi')).toEqual([]);
  });

  it('plain search never reaches the model, even when one is set up', async () => {
    fake.reset();
    const { items } = await elif.api.call('searchContent', { query: { q: 'jeneratör' } });
    expect(items[0]?.kind).toBe('card');
    expect(fake.requests).toEqual([]);
  });

  it('drops vectors when the embedding model changes', async () => {
    await owner.api.call('updateAiSettings', { body: { embeddingModel: null } });
    const status = await owner.api.call('getAiIndexStatus');
    expect(status).toMatchObject({ embedded: 0, embeddings: false, vector: 'off' });
  });

  it('is for admins only', async () => {
    await expectCode(elif.api.call('getAiIndexStatus'), 403, 'forbidden');
    await expectCode(elif.api.call('rebuildAiIndex', { body: {} }), 403, 'forbidden');
  });
});
