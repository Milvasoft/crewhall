import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeProvider } from './ai-fake-provider';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * The newer "Yap" kinds: each one is only a proposal until the person approves it, then it runs
 * as them through the module's own service.
 */

let app: TestApp;
let fake: FakeProvider;
let owner: Client;
let elif: Client;
let elifId: string;
let canId: string;
let spaceId: string;

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function plan(who: Client, actions: unknown[], request = 'yap') {
  fake.reply = JSON.stringify({ message: 'Hazırladım.', actions });
  return who.api.call('planAiActions', { body: { request, locale: 'tr', timeZone: 'UTC' } });
}

const approve = (who: Client, approvalId: string) =>
  who.api.call('approveMcpApproval', { params: { approvalId } });

beforeAll(async () => {
  fake = await new FakeProvider().start();
  app = await createTestApp();
  ({ owner } = await setupWithOwner(app));
  spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!.id;
  const e = await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId]);
  elif = e.person;
  elifId = e.me.user.id;
  canId = (await join(app, owner, 'can@milvasoft.com', 'member')).me.user.id;
  await owner.api.call('updateAiSettings', {
    body: { enabled: true, provider: 'openai_compatible', baseUrl: `${fake.url}/v1`, model: 'llm' },
  });
});

afterAll(async () => {
  await app?.close();
  await fake?.close();
});

beforeEach(() => fake.reset());

describe('create_event', () => {
  it("adds a timed entry to the person's own calendar after approval, with attendees", async () => {
    const out = await plan(owner, [
      {
        type: 'create_event',
        title: 'Diş randevusu',
        start: `${day(2)}T14:00`,
        duration_minutes: 45,
        location: 'Kadıköy',
        attendees: ['Elif'],
      },
    ]);
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]).toMatchObject({ kind: 'create_event', title: 'Diş randevusu' });
    expect(out.proposals[0]!.detail).toMatch(/elif/i);
    expect(answerPrompt()).toContain('create_event');

    const done = await approve(owner, out.proposals[0]!.approvalId);
    expect(done.status).toBe('applied');
    const eventId = String(done.result?.event_id);
    expect(done.result?.path).toBe(`/calendar?event=${eventId}&date=${day(2)}`);
    const event = await owner.api.call('getCalendarEvent', {
      params: { eventId },
      query: {},
    });
    expect(event).toMatchObject({
      title: 'Diş randevusu',
      location: 'Kadıköy',
      allDay: false,
      start: `${day(2)}T14:00:00.000Z`,
      end: `${day(2)}T14:45:00.000Z`,
    });
    expect(event.attendees.map((x) => x.user?.id)).toContain(elifId);
  });

  it('takes all-day entries as dates and skips times in the past', async () => {
    const out = await plan(elif, [
      { type: 'create_event', title: 'İzin', start: day(3) },
      { type: 'create_event', title: 'Geçmiş', start: '2001-01-01T10:00' },
    ]);
    expect(out.proposals.map((p) => p.title)).toEqual(['İzin']);
    expect(out.skipped[0]).toContain('2001-01-01T10:00');
    const done = await approve(elif, out.proposals[0]!.approvalId);
    const event = await elif.api.call('getCalendarEvent', {
      params: { eventId: String(done.result?.event_id) },
      query: {},
    });
    expect(event).toMatchObject({ allDay: true, start: day(3), end: day(4) });
  });

  it('says so when the calendar module is off', async () => {
    await owner.api.call('updateOrg', { body: { settings: { modules: { calendar: false } } } });
    try {
      const out = await plan(owner, [{ type: 'create_event', title: 'X', start: day(2) }]);
      expect(out.proposals).toEqual([]);
      expect(out.skipped[0]).toMatch(/modül/);
    } finally {
      await owner.api.call('updateOrg', { body: { settings: { modules: { calendar: true } } } });
    }
  });
});

describe('send_message', () => {
  it('writes to a colleague after approval, opening the direct conversation then', async () => {
    const before = await owner.api.call('listConversations', { query: { filter: 'direct' } });
    const out = await plan(owner, [
      { type: 'send_message', to: 'Elif', text: 'Merhaba Elif, yarınki sunum ertelendi.' },
    ]);
    expect(out.proposals[0]).toMatchObject({
      kind: 'send_message',
      title: 'Merhaba Elif, yarınki sunum ertelendi.',
    });
    expect(out.proposals[0]!.detail).toMatch(/Kime: elif/i);
    // Nothing opened or sent yet.
    const still = await owner.api.call('listConversations', { query: { filter: 'direct' } });
    expect(still.items.length).toBe(before.items.length);

    const done = await approve(owner, out.proposals[0]!.approvalId);
    expect(done.status).toBe('applied');
    const conversationId = String(done.result?.conversation_id);
    expect(done.result?.path).toBe(`/chat/c/${conversationId}`);
    const page = await elif.api.call('listMessages', {
      params: { conversationId },
      query: {},
    });
    expect(page.items.at(-1)).toMatchObject({
      text: 'Merhaba Elif, yarınki sunum ertelendi.',
      author: { name: expect.stringMatching(/./) },
    });
    expect(answerPrompt()).toContain('<conversations>');
  });

  it('writes to a group the person is in, and not to one they cannot write in', async () => {
    const group = await owner.api.call('createConversation', {
      body: { type: 'group', name: 'Sürüm ekibi', userIds: [elifId, canId] },
    });
    // An empty group someone else opened is not listed to members yet.
    await owner.api.call('sendMessage', {
      params: { conversationId: group.id },
      body: { clientMsgId: '0190f0a0-0000-7000-8000-00000000c001', text: 'Hoş geldiniz' },
    });
    const out = await plan(elif, [
      { type: 'send_message', to: 'sürüm ekibi', text: 'Testler bitti.' },
      { type: 'send_message', to: 'Olmayan kanal', text: 'x' },
    ]);
    expect(out.proposals).toHaveLength(1);
    expect(out.proposals[0]!.detail).toBe('Kime: Sürüm ekibi');
    expect(out.skipped[0]).toContain('Olmayan kanal');
    expect(answerPrompt()).toContain('Sürüm ekibi');
    const done = await approve(elif, out.proposals[0]!.approvalId);
    expect(done.result?.conversation_id).toBe(group.id);
  });
});

describe('pages', () => {
  it("creates a page in a named space, or in the person's own space", async () => {
    const out = await plan(owner, [
      {
        type: 'create_page',
        space: 'altyapı',
        title: 'Sunucu envanteri',
        text: '# Envanter\n\n- web-1',
      },
      { type: 'create_page', space: null, title: 'Kişisel notlar', text: 'Bugün: rapor' },
      { type: 'create_page', space: 'Olmayan alan', title: 'X', text: 'y' },
    ]);
    expect(out.proposals.map((p) => [p.kind, p.title])).toEqual([
      ['create_page', 'Sunucu envanteri'],
      ['create_page', 'Kişisel notlar'],
    ]);
    expect(out.skipped[0]).toContain('Olmayan alan');
    expect(answerPrompt()).toContain('<spaces>\nAltyapı');

    const done = await approve(owner, out.proposals[0]!.approvalId);
    expect(done.status).toBe('applied');
    expect(String(done.result?.path)).toMatch(/^\/p\/.+-/);
    const content = await owner.api.call('getPageContent', {
      params: { nodeId: String(done.result?.node_id) },
      query: {},
    });
    expect(content.markdown).toContain('web-1');
    const page = await owner.api.call('getPage', {
      params: { nodeId: String(done.result?.node_id) },
    });
    expect(page.space.id).toBe(spaceId);
  });

  it('adds a note at the end of a page the person may edit', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Toplantı notları', markdown: '# Notlar\n\nİlk madde' },
    });
    // A viewer of the space cannot add to it: no proposal.
    const viewer = await plan(elif, [
      { type: 'append_page', page: 'toplantı notları', text: 'x' },
      { type: 'create_page', space: 'Altyapı', title: 'X', text: 'y' },
    ]);
    expect(viewer.proposals).toEqual([]);
    expect(viewer.skipped).toHaveLength(2);
    const out = await plan(owner, [
      { type: 'append_page', page: 'toplantı notları', text: '- Sürüm cuma çıkıyor.' },
      { type: 'append_page', page: 'Olmayan sayfa', text: 'x' },
    ]);
    expect(out.proposals[0]).toMatchObject({ kind: 'append_page', title: 'Toplantı notları' });
    expect(out.skipped[0]).toContain('Olmayan sayfa');
    const done = await approve(owner, out.proposals[0]!.approvalId);
    expect(done.status).toBe('applied');
    const content = await owner.api.call('getPageContent', {
      params: { nodeId: page.id },
      query: {},
    });
    expect(content.markdown).toMatch(/İlk madde[\s\S]*Sürüm cuma çıkıyor/);
  });
});

describe('extract_tasks', () => {
  it('reads the conversation as the person and proposes its tasks', async () => {
    const group = await owner.api.call('createConversation', {
      body: { type: 'group', name: 'Ops ekibi', userIds: [elifId, canId] },
    });
    for (const [i, text] of [
      'Yarın yedekleri kontrol eder misin Elif?',
      'Tamam, ben bakarım. Bir de sertifikayı yenilemek lazım.',
    ].entries()) {
      await owner.api.call('sendMessage', {
        params: { conversationId: group.id },
        body: { clientMsgId: `0190f0a0-0000-7000-8000-00000000d00${i}`, text },
      });
    }
    fake.replies = [
      JSON.stringify({
        message: 'Sohbeti okuyorum.',
        actions: [{ type: 'extract_tasks', conversation: 'ops ekibi', target: 'todo' }],
      }),
      JSON.stringify({
        summary: 'Ekip yedekleri ve sertifikayı konuştu.',
        tasks: [
          { title: 'Yedekleri kontrol et', owner: 'Elif', due: null },
          { title: 'Sertifikayı yenile', owner: null, due: null },
        ],
      }),
    ];
    const mine = (await elif.api.call('listSurfaces')).items.find((s) => s.owner.type === 'user')!;
    await elif.api.call('createCard', {
      params: { surfaceId: mine.id },
      body: { type: 'todo', config: { title: 'İşlerim', items: [] } },
    });
    const out = await elif.api.call('planAiActions', {
      body: { request: 'ops ekibi sohbetini özetle, görevleri ekle', locale: 'tr' },
    });
    expect(out.message).toContain('Ekip yedekleri ve sertifikayı konuştu.');
    expect(out.proposals.map((p) => [p.kind, p.title])).toEqual([
      ['add_todo_item', 'Yedekleri kontrol et (Elif)'],
      ['add_todo_item', 'Sertifikayı yenile'],
    ]);
    // The extraction saw the messages; the plan step did not.
    const prompts = fake.requests.map((r) => JSON.stringify(r.body));
    expect(prompts[0]).not.toContain('sertifikayı yenilemek');
    expect(prompts[1]).toContain('sertifikayı yenilemek');
  });

  it('skips a conversation it cannot find among the person’s own', async () => {
    const other = await owner.api.call('createConversation', {
      body: { type: 'group', name: 'Yönetim kurulu', userIds: [canId, elifId] },
    });
    await owner.api.call('sendMessage', {
      params: { conversationId: other.id },
      body: { clientMsgId: '0190f0a0-0000-7000-8000-00000000d0aa', text: 'Gizli' },
    });
    await owner.api
      .call('removeConversationMember', {
        params: { conversationId: other.id, userId: elifId },
      })
      .catch(() => undefined);
    fake.replies = [
      JSON.stringify({
        message: '',
        actions: [{ type: 'extract_tasks', conversation: 'Muhasebe gizli', target: 'todo' }],
      }),
    ];
    const out = await elif.api.call('planAiActions', { body: { request: 'x', locale: 'tr' } });
    expect(out.proposals).toEqual([]);
    expect(out.skipped[0]).toContain('Muhasebe gizli');
    expect(fake.requests).toHaveLength(1);
  });
});

function answerPrompt() {
  return fake.allPromptText();
}
