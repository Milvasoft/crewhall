import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { approvalRequests, auditLogs, cardAssignees, meetings } from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import { localToUtc, nowIn, parsePlan } from '../src/services/ai/actions';
import { FakeProvider } from './ai-fake-provider';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Eylem yapan asistan (yol haritası #18): plan → approval queue → applied as the person. */

let app: TestApp;
let fake: FakeProvider;
let owner: Client;
let guest: Client;
let ownerId: string;
let elifId: string;
let spaceId: string;
let boardId: string;
let boardKey: string;
let cardId: string;

async function expectCode(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(status);
  expect((err as ApiError).code).toBe(code);
}

const tomorrow = () => {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  fake = await new FakeProvider().start();
  app = await createTestApp();
  const setup = await setupWithOwner(app);
  owner = setup.owner;
  ownerId = setup.ownerId;
  spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!.id;
  const e = await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId]);
  elifId = e.me.user.id;
  guest = (await join(app, owner, 'misafir@example.com', 'guest')).person;
  const board = await owner.api.call('createBoard', {
    params: { spaceId },
    body: { name: 'Sürüm işleri', template: 'sprint' },
  });
  boardId = board.id;
  boardKey = (await owner.api.call('listBoards', { params: { spaceId } })).items.find(
    (b) => b.id === boardId,
  )!.key;
  const detail = await owner.api.call('getBoard', { params: { boardId } });
  cardId = (
    await owner.api.call('createBoardCard', {
      params: { boardId },
      body: { columnId: detail.columns[0]!.id, title: 'Yedek jeneratör testi' },
    })
  ).id;
  await owner.api.call('updateAiSettings', {
    body: { enabled: true, provider: 'openai_compatible', baseUrl: `${fake.url}/v1`, model: 'llm' },
  });
});

afterAll(async () => {
  await app?.close();
  await fake?.close();
});

beforeEach(() => fake.reset());

describe('planning', () => {
  it('files each understood action in the approval queue and changes nothing yet', async () => {
    fake.reply = JSON.stringify({
      message: 'Üç işlem hazırladım.',
      actions: [
        { type: 'assign_card', card: `${boardKey}-1`, assignees: ['me', 'elif'] },
        {
          type: 'create_meeting',
          title: 'Sürüm hazırlık',
          start: `${tomorrow()}T10:00`,
          duration_minutes: 45,
          invitees: ['elif'],
        },
        { type: 'create_card', board: boardKey, title: 'Sürüm notlarını yaz', due: tomorrow() },
        { type: 'assign_card', card: `${boardKey}-1`, assignees: ['Hayalet Kişi'] },
        { type: 'delete_everything' },
      ],
    });
    const out = await owner.api.call('planAiActions', {
      body: {
        request: `${boardKey}-1 kartına beni ve Elif'i ata, yarın 10'a toplantı kur`,
        timeZone: 'Europe/Istanbul',
        locale: 'tr',
      },
    });
    // About a plan, the server says what really came of it, not the model.
    expect(out.message).toBe('3 işlem hazırlandı, onayını bekliyor. Henüz hiçbir şey değişmedi.');
    expect(out.proposals.map((p) => p.kind)).toEqual([
      'assign_card',
      'create_meeting',
      'create_card',
    ]);
    expect(out.skipped).toEqual(['"Hayalet Kişi" adlı kişiyi bulamadım.']);

    // The model saw who and what it may refer to, and the time in the person's zone.
    const prompt = fake.allPromptText();
    expect(prompt).toContain('(Europe/Istanbul)');
    expect(prompt).toContain(`${boardKey} — Sürüm işleri`);

    const rows = await app.deps.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.action, 'ai.action'));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'pending' && r.viaName === 'Crewhall AI')).toBe(true);
    const meeting = rows.find((r) => r.tool === 'ai_create_meeting')!;
    expect(meeting.payload).toMatchObject({
      starts_at: `${tomorrow()}T07:00:00.000Z`,
      duration_minutes: 45,
      invitee_ids: [elifId],
    });
    expect(
      await app.deps.db.select().from(cardAssignees).where(eq(cardAssignees.cardId, cardId)),
    ).toHaveLength(0);

    // The approvals screen lists them like any other request.
    const queue = await owner.api.call('listMcpApprovals', { query: {} });
    expect(queue.items.filter((x) => x.action === 'ai.action')).toHaveLength(3);
  });

  it('applies an action only after approval, as the person, marked "AI ile"', async () => {
    const rows = await app.deps.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.action, 'ai.action'));
    for (const r of rows) {
      const done = await owner.api.call('approveMcpApproval', { params: { approvalId: r.id } });
      expect(done.status).toBe('applied');
    }
    const assignees = await app.deps.db
      .select()
      .from(cardAssignees)
      .where(eq(cardAssignees.cardId, cardId));
    expect(assignees.map((x) => x.userId).sort()).toEqual([ownerId, elifId].sort());
    const [m] = await app.deps.db
      .select()
      .from(meetings)
      .where(eq(meetings.title, 'Sürüm hazırlık'));
    expect(m).toBeTruthy();
    const detail = await owner.api.call('getBoard', { params: { boardId } });
    expect(detail.cards.map((c) => c.title)).toContain('Sürüm notlarını yaz');

    const applied = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'mcp.approval.apply')));
    expect(applied.every((x) => (x.via as { kind?: string }).kind === 'ai')).toBe(true);
  });

  it('asks back when nothing is clear', async () => {
    fake.reply = 'Hangi kartı kastettin?';
    const out = await owner.api.call('planAiActions', { body: { request: 'şunu hallet' } });
    expect(out).toMatchObject({ message: 'Hangi kartı kastettin?', proposals: [], skipped: [] });
  });
});

describe('to-do cards on the home page', () => {
  let mine: string;
  let todoId: string;

  const todoItems = async (id: string) => {
    const surface = await owner.api.call('getSurface', { params: { surfaceId: mine } });
    const card = surface.cards.find((c) => c.id === id);
    if (!card || card.type !== 'todo') throw new Error('no todo card');
    return card.config.items.map((i) => i.text);
  };

  it('says so when the person has no to-do card', async () => {
    fake.reply = JSON.stringify({
      message: 'Ekliyorum.',
      actions: [{ type: 'add_todo_item', todo_card: null, text: 'Elma al' }],
    });
    const out = await owner.api.call('planAiActions', {
      body: { request: 'yapılacaklarıma elma al ekle', locale: 'tr' },
    });
    expect(out.proposals).toEqual([]);
    expect(out.skipped[0]).toMatch(/yapılacaklar kartı yok/);
  });

  it('adds to the only to-do card after approval, and tells the model the two kinds of card apart', async () => {
    mine = (await owner.api.call('listSurfaces')).items.find((x) => x.owner.type === 'user')!.id;
    const card = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: { type: 'todo', config: { title: 'Ev işleri', items: [] } },
    });
    todoId = card.id;
    fake.reply = JSON.stringify({
      message: 'Yapılacaklarına ekliyorum.',
      actions: [
        {
          type: 'add_todo_item',
          todo_card: null,
          text: 'Marketten 3 kilo elma al',
          due: tomorrow(),
        },
      ],
    });
    const out = await owner.api.call('planAiActions', {
      body: {
        request: 'ana sayfadaki yapılacaklar kartına marketten 3 kilo elma al ekle',
        locale: 'tr',
      },
    });
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]).toMatchObject({
      kind: 'add_todo_item',
      detail: 'Yapılacaklar: Ev işleri',
    });
    expect(out.proposals[0]!.title).toMatch(/^Marketten 3 kilo elma al \(\d+ \S+\)$/);
    const prompt = fake.allPromptText();
    expect(prompt).toContain('<todo_cards>\nEv işleri (0 open)\n</todo_cards>');
    expect(prompt).toContain('never create_card');

    // Nothing changes before approval.
    expect(await todoItems(todoId)).toEqual([]);
    const done = await owner.api.call('approveMcpApproval', {
      params: { approvalId: out.proposals[0]!.approvalId },
    });
    expect(done).toMatchObject({ status: 'applied', result: { card_id: todoId } });
    expect(await todoItems(todoId)).toEqual([out.proposals[0]!.title]);
  });

  it('picks a card by title when there are several, and asks when it cannot tell', async () => {
    const work = await owner.api.call('createCard', {
      params: { surfaceId: mine },
      body: { type: 'todo', config: { title: 'İş', items: [] } },
    });
    fake.reply = JSON.stringify({
      message: '',
      actions: [
        { type: 'add_todo_item', todo_card: 'iş', text: 'Raporu gönder' },
        { type: 'add_todo_item', todo_card: null, text: 'Ekmek al' },
      ],
    });
    const out = await owner.api.call('planAiActions', {
      body: { request: 'iş listeme raporu gönder ekle, bir de ekmek al', locale: 'tr' },
    });
    expect(out.proposals.map((p) => p.detail)).toEqual(['Yapılacaklar: İş']);
    expect(out.skipped).toEqual([
      'Hangi yapılacaklar kartına ekleyeyim? Kartların: Ev işleri, İş.',
    ]);
    const row = (
      await app.deps.db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, out.proposals[0]!.approvalId))
    )[0]!;
    expect(row.payload).toEqual({ card_id: work.id, text: 'Raporu gönder' });
  });

  it("never writes on someone else's card, even with a forged payload", async () => {
    const [row] = await app.deps.db
      .insert(approvalRequests)
      .values({
        orgId: (await owner.api.call('getOrg')).id,
        userId: elifId,
        viaName: 'Crewhall AI',
        action: 'ai.action',
        tool: 'ai_add_todo_item',
        payload: { card_id: todoId, text: 'Sızma' },
        payloadHash: 'x',
        preview: { title: 'x', target: 'x', items: [] },
        targetRevs: {},
        expiresAt: new Date(Date.now() + 60_000),
        status: 'approved',
      })
      .returning();
    // The worker job that runs approved requests (inline in tests).
    await app.deps.jobs.send('approval.apply', { approvalId: row!.id });
    const [after] = await app.deps.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, row!.id));
    expect(after).toMatchObject({ status: 'failed', errorCode: 'not_found' });
    expect(await todoItems(todoId)).not.toContain('Sızma');
  });
});

describe('limits', () => {
  it('needs the mcp module (the approval queue) and is not for guests', async () => {
    await expectCode(
      guest.api.call('planAiActions', { body: { request: 'karta beni ata' } }),
      403,
      'forbidden',
    );
    await owner.api.call('updateOrg', { body: { settings: { modules: { mcp: false } } } });
    await expectCode(
      owner.api.call('planAiActions', { body: { request: 'karta beni ata' } }),
      403,
      'module_disabled',
    );
    await owner.api.call('updateOrg', { body: { settings: { modules: { mcp: true } } } });
  });
});

describe('helpers', () => {
  it('reads local times in the person zone', () => {
    expect(localToUtc('2026-10-23T10:00', 'Europe/Istanbul')?.toISOString()).toBe(
      '2026-10-23T07:00:00.000Z',
    );
    expect(localToUtc('2026-07-01 09:30', 'Europe/Berlin')?.toISOString()).toBe(
      '2026-07-01T07:30:00.000Z',
    );
    expect(localToUtc('yarın', 'UTC')).toBeNull();
    expect(nowIn('Europe/Istanbul', new Date('2026-10-22T20:40:00Z'))).toBe(
      '2026-10-22 23:40, Thursday (Europe/Istanbul)',
    );
  });

  it('keeps known actions only', () => {
    const plan = parsePlan(
      '```json\n{"message":"ok","actions":[{"type":"assign_card","card":"A-1","assignees":["me"]},{"type":"rm"}]}\n```',
    );
    expect(plan.actions).toHaveLength(1);
    expect(parsePlan('düz metin')).toEqual({
      message: 'düz metin',
      actions: [],
      reads: [],
      replacesLast: false,
    });
  });
});
