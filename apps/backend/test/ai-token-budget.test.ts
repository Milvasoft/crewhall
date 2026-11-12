import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeProvider, type FakeRequest } from './ai-fake-provider';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * Token budget of a typical session (the 11 requests a user reported: meetings and cards
 * created through "Yap", a to-do item, questions through "Sor"), measured on what is sent to the
 * model. Tokens are estimated from characters (Turkish text ≈ 3.5 characters per token); the
 * cacheable part is the byte-identical prefix up to the last `cache_control` mark, counted as a
 * cache read from its second use on (Claude Sonnet 5.5 / Haiku 5.5 cache prefixes from 512
 * tokens). Prices: Sonnet 5.5 $2 in / $10 out / $0.20 cache read / $2.50 cache write per million;
 * Haiku 5.5 $0.10 / $0.50 / $0.01 / $0.125.
 */

let app: TestApp;
let fake: FakeProvider;
let owner: Client;
let elif: Client;
let boardKey: string;

const CHARS_PER_TOKEN = 3.5;
const tok = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);
const PRICE = {
  main: { input: 2, output: 10, read: 0.2, write: 2.5 },
  fast: { input: 0.1, output: 0.5, read: 0.01, write: 0.125 },
};

type Block = { text?: string; cache_control?: unknown };

/** Characters of a request, split into the cached prefix (up to the last mark) and the rest. */
function measure(r: FakeRequest) {
  const tools = r.body.tools ? JSON.stringify(r.body.tools) : '';
  const system = r.body.system as unknown as string | Block[] | undefined;
  const blocks: Block[] = typeof system === 'string' ? [{ text: system }] : (system ?? []);
  const messages = (r.body.messages ?? [])
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('');
  let prefix = 0;
  let marked = false;
  let seen = tools.length;
  for (const b of blocks) {
    seen += b.text?.length ?? 0;
    if (b.cache_control) {
      prefix = seen;
      marked = true;
    }
  }
  const total = seen + messages.length;
  const key = marked ? `${tools}${blocks.map((b) => b.text).join('')}`.slice(0, prefix) : null;
  return { total, prefix: marked ? prefix : 0, key, model: r.body.model ?? '' };
}

function report(requests: FakeRequest[], outputPerAnswer: number, fastModel: string | null) {
  const seen = new Set<string>();
  let input = 0;
  let cachedRead = 0;
  let cachedWrite = 0;
  let cost = 0;
  for (const r of requests) {
    const m = measure(r);
    const t = tok(m.total);
    const pfx = tok(m.prefix);
    const price = fastModel && m.model === fastModel ? PRICE.fast : PRICE.main;
    input += t;
    let read = 0;
    let write = 0;
    if (m.key && pfx >= 512) {
      if (seen.has(m.key)) read = pfx;
      else write = pfx;
      seen.add(m.key);
    }
    cachedRead += read;
    cachedWrite += write;
    const out = r.body.tools ? 15 : outputPerAnswer;
    cost +=
      ((t - read - write) * price.input +
        read * price.read +
        write * price.write +
        out * price.output) /
      1e6;
  }
  return {
    requests: requests.length,
    input,
    cachedRead,
    cachedWrite,
    costUsd: Number(cost.toFixed(5)),
  };
}

beforeAll(async () => {
  fake = await new FakeProvider().start();
  app = await createTestApp();
  ({ owner } = await setupWithOwner(app));
  const spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!.id;
  const e = await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId]);
  elif = e.person;
  // A team of about 25 people, like the org the numbers were reported from.
  for (let i = 1; i <= 23; i++) {
    await join(app, owner, `kisi${i}@milvasoft.com`, 'member', [spaceId]);
  }
  const board = await owner.api.call('createBoard', {
    params: { spaceId },
    body: { name: 'Sürüm işleri', template: 'sprint' },
  });
  boardKey = (await owner.api.call('listBoards', { params: { spaceId } })).items.find(
    (b) => b.id === board.id,
  )!.key;
  const mine = (await elif.api.call('listSurfaces')).items.find((s) => s.owner.type === 'user')!;
  await elif.api.call('createCard', {
    params: { surfaceId: mine.id },
    body: { type: 'todo', config: { title: 'Kişisel', items: [] } },
  });
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

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/** The session: 4 meetings, 2 cards, 1 to-do item through "Yap"; 4 questions through "Sor". */
async function session() {
  const meetings = ['Sprint planlama', 'Müşteri demosu', 'Bütçe gözden geçirme', 'Retro'];
  for (const [i, title] of meetings.entries()) {
    fake.reply = JSON.stringify({
      message: 'Toplantıyı hazırladım.',
      actions: [
        { type: 'create_meeting', title, start: `${tomorrow()}T${10 + i}:00`, invitees: ['Elif'] },
      ],
    });
    await elif.api.call('planAiActions', {
      body: {
        request: `yarın ${10 + i}'da Elif ile ${title} toplantısı kur`,
        timeZone: 'Europe/Istanbul',
        locale: 'tr',
      },
    });
  }
  for (const title of ['Sürüm notlarını yaz', 'Yedekleme testini yap']) {
    fake.reply = JSON.stringify({
      message: 'Kartı hazırladım.',
      actions: [{ type: 'create_card', board: boardKey, title }],
    });
    await elif.api.call('planAiActions', {
      body: { request: `${boardKey} panosuna "${title}" kartı aç`, locale: 'tr' },
    });
  }
  fake.reply = JSON.stringify({
    message: 'Ekliyorum.',
    actions: [{ type: 'add_todo_item', todo_card: null, text: 'Marketten 3 kilo elma al' }],
  });
  await elif.api.call('planAiActions', {
    body: { request: 'yapılacaklarıma marketten 3 kilo elma al ekle', locale: 'tr' },
  });
  const questions: [string, { name: string; args: Record<string, unknown> }[]][] = [
    ['yaklaşan bir toplantım var mı', [{ name: 'upcoming_events', args: {} }]],
    ['bana atanmış açık işler neler', [{ name: 'my_tasks', args: {} }]],
    [
      'bugün ne var',
      [
        { name: 'upcoming_events', args: {} },
        { name: 'my_tasks', args: {} },
      ],
    ],
    ['yedekleme politikamız nedir', []],
  ];
  for (const [question, calls] of questions) {
    fake.toolCalls = calls;
    fake.reply = 'Evet, yarın 10:00 Sprint planlama var [1].';
    await elif.api.call('askAi', { body: { question, locale: 'tr', timeZone: 'Europe/Istanbul' } });
  }
}

async function measured(fastModel: string | null) {
  await owner.api.call('updateAiSettings', { body: { fastModel } });
  fake.reset();
  await session();
  return report([...fake.requests, ...fake.toolRequests], 56, fastModel);
}

describe('token budget', () => {
  it('measures the 11-request session, with and without the fast model', async () => {
    const main = await measured(null);
    const fast = await measured('claude-haiku-5-5');
    console.log(`TOKEN_BUDGET main ${JSON.stringify(main)}`);
    console.log(`TOKEN_BUDGET fast ${JSON.stringify(fast)}`);
    expect(main.requests).toBeGreaterThanOrEqual(11);
    // The fast model only changes the price, not what is sent.
    expect(fast.input).toBe(main.input);
    expect(fast.costUsd).toBeLessThan(main.costUsd);
  });
});
