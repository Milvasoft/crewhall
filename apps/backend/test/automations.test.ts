import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { automationRuns, boardCards, notifications, organizations } from '@crewhall/db';
import { conditionHolds, renderTemplate, type AutomationRule } from '@crewhall/shared';
import { invalidateModules } from '../src/services/identity/modules';
import { resetRates } from '../src/services/automations/rate';
import { Client, createTestApp, join, setupWithOwner, uploadFile, type TestApp } from './helpers';

interface Hit {
  headers: IncomingMessage['headers'];
  body: string;
}

describe('automations', () => {
  let app: TestApp;
  let owner: Client;
  let spaceId: string;
  let mert: Awaited<ReturnType<typeof join>>;
  let selin: Awaited<ReturnType<typeof join>>;
  let can: Awaited<ReturnType<typeof join>>;
  let boardId: string;
  let todo: string;
  let done: string;
  let groupId: string;
  let server: Server;
  let serverUrl: string;
  const hits: Hit[] = [];
  let answer = 200;

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    mert = await join(app, owner, 'mert@milvasoft.com', 'member');
    selin = await join(app, owner, 'selin@milvasoft.com', 'member');
    can = await join(app, owner, 'can@milvasoft.com', 'member');
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId: mert.me.user.id },
      body: { role: 'editor' },
    });
    await owner.api.call('removeSpaceMember', { params: { spaceId, userId: can.me.user.id } });
    const board = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Destek', template: 'empty', key: 'DST' },
    });
    boardId = board.id;
    const detail = await owner.api.call('getBoard', { params: { boardId } });
    todo = detail.columns[0]!.id;
    done = detail.columns.at(-1)!.id;
    const g = await owner.api.call('createConversation', {
      body: { type: 'group', userIds: [mert.me.user.id, selin.me.user.id] },
    });
    groupId = g.id;
    await owner.api.call('sendMessage', {
      params: { conversationId: groupId },
      body: { clientMsgId: crypto.randomUUID(), text: 'Merhaba' },
    });
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        hits.push({ headers: req.headers, body });
        res.statusCode = answer;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    serverUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/hook`;
  });
  afterAll(async () => {
    server.close();
    await app.close();
  });

  const runsOf = (ruleId: string) =>
    app.deps.db.select().from(automationRuns).where(eq(automationRuns.ruleId, ruleId));

  it('describes its triggers and actions, calendar not available yet', async () => {
    const cat = await owner.api.call('getAutomationCatalog');
    expect(cat.triggers.map((t) => t.type)).toEqual(
      expect.arrayContaining([
        'boards.card_moved',
        'forms.response_submitted',
        'drive.file_uploaded',
        'webhook.received',
      ]),
    );
    // Registered by the calendar module (roadmap 14).
    expect(cat.triggers.find((t) => t.type === 'calendar.event_upcoming')).toMatchObject({
      module: 'calendar',
      available: true,
      unavailableReason: null,
    });
    expect(cat.actions.map((a) => a.type)).toEqual(
      expect.arrayContaining(['chat.post', 'boards.create_card', 'notify.users', 'webhook.send']),
    );
    expect(cat.triggers.find((t) => t.type === 'boards.card_moved')!.variables).toContain(
      'card.title',
    );
  });

  it('lets space admins manage rules, editors read them, others nothing', async () => {
    const body = {
      name: 'Bitti olunca yaz',
      trigger: { type: 'boards.card_moved', config: { boardId, toColumnId: done } },
      actions: [
        { id: 'a1', type: 'notify.users', config: { userIds: [mert.me.user.id], text: 'x' } },
      ],
    };
    await expect(
      mert.person.api.call('createAutomationRule', { params: { spaceId }, body }),
    ).rejects.toMatchObject({ status: 403 });
    const rule = await owner.api.call('createAutomationRule', { params: { spaceId }, body });
    expect(rule).toMatchObject({ enabled: true, failureStreak: 0, hookUrl: null });
    expect(
      (await mert.person.api.call('listAutomationRules', { params: { spaceId } })).items,
    ).toHaveLength(1);
    await expect(
      selin.person.api.call('listAutomationRules', { params: { spaceId } }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      can.person.api.call('getAutomationRule', { params: { ruleId: rule.id } }),
    ).rejects.toMatchObject({ status: 404 });
    // Targets are checked: a stranger cannot be notified, an unknown action is refused.
    await expect(
      owner.api.call('createAutomationRule', {
        params: { spaceId },
        body: {
          ...body,
          actions: [
            { id: 'a1', type: 'notify.users', config: { userIds: [can.me.user.id], text: 'x' } },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'automation_target_invalid' });
    await expect(
      owner.api.call('createAutomationRule', {
        params: { spaceId },
        body: { ...body, actions: [{ id: 'a1', type: 'mail.send', config: {} }] },
      }),
    ).rejects.toMatchObject({ code: 'automation_action_unknown' });
    await expect(
      owner.api.call('createAutomationRule', {
        params: { spaceId },
        body: { ...body, trigger: { type: 'calendar.later', config: {} } },
      }),
    ).rejects.toMatchObject({ code: 'automation_trigger_unknown' });
    await owner.api.call('deleteAutomationRule', { params: { ruleId: rule.id } });
  });

  it('writes to chat and notifies when a card moves to Done, with conditions', async () => {
    const rule = await owner.api.call('createAutomationRule', {
      params: { spaceId },
      body: {
        name: 'Bitti duyurusu',
        trigger: { type: 'boards.card_moved', config: { boardId, toColumnId: done } },
        conditions: [{ field: 'card.title', op: 'contains', value: 'p1' }],
        actions: [
          {
            id: 'chat',
            type: 'chat.post',
            config: {
              conversationId: groupId,
              text: '{{card.ref}} bitti: {{card.title}} ({{actor.name}})',
            },
          },
          {
            id: 'bell',
            type: 'notify.users',
            config: { userIds: [mert.me.user.id], text: '{{card.title}} tamam' },
          },
        ],
      },
    });
    const urgent = await owner.api.call('createBoardCard', {
      params: { boardId },
      body: { columnId: todo, title: 'P1 sunucu düştü' },
    });
    const minor = await owner.api.call('createBoardCard', {
      params: { boardId },
      body: { columnId: todo, title: 'Yazım hatası' },
    });
    await owner.api.call('moveBoardCard', {
      params: { cardId: minor.id },
      body: { columnId: done },
    });
    expect(await runsOf(rule.id)).toHaveLength(0);
    await owner.api.call('moveBoardCard', {
      params: { cardId: urgent.id },
      body: { columnId: done },
    });
    const runs = await runsOf(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'succeeded', triggerType: 'boards.card_moved' });
    expect(runs[0]!.steps.map((s) => s.status)).toEqual(['succeeded', 'succeeded']);

    const page = await mert.person.api.call('listMessages', {
      params: { conversationId: groupId },
      query: { limit: 50 },
    });
    const last = page.items.at(-1)!;
    expect(last.text).toBe(`DST-${urgent.number} bitti: P1 sunucu düştü (Ahmet Buğra Kösen)`);
    // The Otomasyon bot posts it, not the rule's owner.
    expect(last).toMatchObject({
      kind: 'webhook',
      author: null,
      automation: { ruleId: rule.id, ruleName: 'Bitti duyurusu' },
      webhook: { name: 'Bitti duyurusu' },
    });
    expect(last.via ?? null).toBeNull();
    const bell = await app.deps.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, mert.me.user.id),
          eq(notifications.type, 'automations.notify'),
        ),
      );
    expect(bell.at(-1)!.payload).toMatchObject({
      name: 'Bitti duyurusu',
      text: 'P1 sunucu düştü tamam',
    });

    const listed = await owner.api.call('listAutomationRuns', { params: { ruleId: rule.id } });
    expect(listed.items[0]!.event).toMatchObject({
      card: { title: 'P1 sunucu düştü' },
      to: { name: 'Bitti' },
    });
    const fresh = await owner.api.call('getAutomationRule', { params: { ruleId: rule.id } });
    expect(fresh).toMatchObject({ runCount: 1, lastStatus: 'succeeded' });
    await owner.api.call('deleteAutomationRule', { params: { ruleId: rule.id } });
  });

  it('opens a card when a form is answered', async () => {
    const form = await owner.api.call('createForm', {
      params: { spaceId },
      body: {
        title: 'Destek talebi',
        fields: [
          { id: 'konu', type: 'short_text', label: 'Konu', required: true },
          {
            id: 'onem',
            type: 'single_choice',
            label: 'Önem',
            choices: [
              { id: 'yuksek', label: 'Yüksek' },
              { id: 'dusuk', label: 'Düşük' },
            ],
          },
        ],
      },
    });
    await owner.api.call('updateForm', { params: { formId: form.id }, body: { status: 'open' } });
    const rule = await owner.api.call('createAutomationRule', {
      params: { spaceId },
      body: {
        name: 'Talep → kart',
        trigger: { type: 'forms.response_submitted', config: { formId: form.id } },
        conditions: [{ field: 'answers.onem', op: 'equals', value: 'Yüksek' }],
        actions: [
          {
            id: 'card',
            type: 'boards.create_card',
            config: {
              boardId,
              columnId: todo,
              title: 'Talep: {{answers.konu}}',
              description: '{{respondent.name}} gönderdi\n{{answers}}',
            },
          },
        ],
      },
    });
    await selin.person.api.call('submitForm', {
      params: { formId: form.id },
      body: { answers: { konu: 'VPN çalışmıyor', onem: 'yuksek' } },
    });
    await selin.person.api.call('submitForm', {
      params: { formId: form.id },
      body: { answers: { konu: 'Ekran parlak', onem: 'dusuk' } },
    });
    const cards = await app.deps.db
      .select()
      .from(boardCards)
      .where(eq(boardCards.boardNodeId, boardId));
    expect(cards.filter((c) => c.title.startsWith('Talep:')).map((c) => c.title)).toEqual([
      'Talep: VPN çalışmıyor',
    ]);
    const desc = cards.find((c) => c.title === 'Talep: VPN çalışmıyor')!.descText;
    expect(desc).toContain('selin gönderdi');
    // {{answers}} reads as question: answer lines, not JSON.
    expect(desc).toContain('Konu: VPN çalışmıyor');
    expect(desc).toContain('Önem: Yüksek');
    expect(await runsOf(rule.id)).toHaveLength(1);
    await owner.api.call('deleteAutomationRule', { params: { ruleId: rule.id } });
  });

  it('posts signed webhooks on uploads and stops after three failures', async () => {
    const rule = await owner.api.call('createAutomationRule', {
      params: { spaceId },
      body: {
        name: 'PDF yüklenince n8n',
        trigger: { type: 'drive.file_uploaded', config: { extensions: 'pdf' } },
        actions: [{ id: 'hook', type: 'webhook.send', config: { url: serverUrl } }],
      },
    });
    await uploadFile(owner, { spaceId, name: 'notlar.txt', content: Buffer.from('a') });
    expect(hits).toHaveLength(0);
    await uploadFile(owner, { spaceId, name: 'rapor.pdf', content: Buffer.from('%PDF-1.4 x') });
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    const payload = JSON.parse(hit.body) as {
      event: { type: string; data: { file: { name: string } } };
    };
    expect(payload.event).toMatchObject({
      type: 'drive.file_uploaded',
      data: { file: { name: 'rapor.pdf' } },
    });
    const sig = createHmac('sha256', rule.signingSecret!).update(hit.body).digest('hex');
    expect(hit.headers['x-crewhall-signature']).toBe(`sha256=${sig}`);
    expect(hit.headers['x-crewhall-chain']).toBe(rule.id);

    answer = 500;
    for (const n of [1, 2, 3]) {
      await uploadFile(owner, { spaceId, name: `hata-${n}.pdf`, content: Buffer.from('%PDF') });
    }
    const runs = await runsOf(rule.id);
    expect(runs.filter((r) => r.status === 'failed')).toHaveLength(3);
    expect(runs.find((r) => r.status === 'failed')!.steps[0]!.error).toMatchObject({
      code: 'automation_webhook_failed',
    });
    const stopped = await owner.api.call('getAutomationRule', { params: { ruleId: rule.id } });
    expect(stopped).toMatchObject({ enabled: false, disabledReason: 'failures', failureStreak: 3 });
    const bell = await app.deps.db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'automations.disabled'));
    expect(bell.length).toBeGreaterThan(0);
    // Stopped: further uploads do not run it; enabling again clears the stop.
    await uploadFile(owner, { spaceId, name: 'sonra.pdf', content: Buffer.from('%PDF') });
    expect(await runsOf(rule.id)).toHaveLength(4);
    answer = 200;
    const again = await owner.api.call('updateAutomationRule', {
      params: { ruleId: rule.id },
      body: { enabled: true },
    });
    expect(again).toMatchObject({ enabled: true, disabledReason: null, failureStreak: 0 });
    await owner.api.call('deleteAutomationRule', { params: { ruleId: rule.id } });
  });

  it('runs from an incoming webhook and guards against loops', async () => {
    resetRates();
    const rule = await owner.api.call('createAutomationRule', {
      params: { spaceId },
      body: {
        name: 'Gelen deploy',
        trigger: { type: 'webhook.received', config: {} },
        conditions: [{ field: 'body.status', op: 'equals', value: 'failed' }],
        actions: [
          {
            id: 'bell',
            type: 'notify.users',
            config: {
              userIds: [mert.me.user.id],
              text: 'Deploy {{body.status}}: {{body.service}}',
            },
          },
        ],
      },
    });
    expect(rule.hookUrl).toMatch(/\/api\/automations\/hooks\/[\w-]+\?key=[\w-]+$/);
    const path = new URL(rule.hookUrl!).pathname + new URL(rule.hookUrl!).search;
    const anon = new Client(app);
    const ok = await anon.raw<{ accepted: boolean }>('POST', path, {
      status: 'failed',
      service: 'api',
    });
    expect(ok.status).toBe(202);
    expect(ok.body.accepted).toBe(true);
    const skipped = await anon.raw<{ accepted: boolean }>('POST', path, { status: 'ok' });
    expect(skipped.body.accepted).toBe(false);
    const wrong = await anon.raw('POST', path.replace(/key=[\w-]+/, 'key=yanlis'), {
      status: 'failed',
    });
    expect(wrong.status).toBe(404);
    // The same rule already in the chain (a round trip through n8n) does not run again.
    const looped = await anon.raw<{ accepted: boolean }>(
      'POST',
      path,
      { status: 'failed' },
      { 'X-Crewhall-Chain': rule.id },
    );
    expect(looped.body.accepted).toBe(false);
    const runs = await runsOf(rule.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.event).toMatchObject({ body: { status: 'failed', service: 'api' } });

    const regenerated = await owner.api.call('regenerateAutomationHook', {
      params: { ruleId: rule.id },
    });
    expect(regenerated.hookUrl).not.toBe(rule.hookUrl);
    expect((await anon.raw('POST', path, { status: 'failed' })).status).toBe(404);

    const test = await owner.api.call('testAutomationRule', { params: { ruleId: rule.id } });
    expect(test.test).toBe(true);
    const tested = (await runsOf(rule.id)).find((r) => r.id === test.id)!;
    expect(tested.status).toBe('succeeded');
  });

  it('stays silent and answers 403 while the module is off', async () => {
    const [org] = await app.deps.db.select().from(organizations);
    const settings = org!.settings;
    await app.deps.db
      .update(organizations)
      .set({ settings: { ...settings, modules: { automations: false } } as typeof settings })
      .where(eq(organizations.id, org!.id));
    invalidateModules();
    try {
      await expect(
        owner.api.call('listAutomationRules', { params: { spaceId } }),
      ).rejects.toMatchObject({ code: 'module_disabled' });
    } finally {
      await app.deps.db
        .update(organizations)
        .set({ settings })
        .where(eq(organizations.id, org!.id));
      invalidateModules();
    }
  });

  it('evaluates conditions and templates', () => {
    const data = { card: { title: 'İstanbul P1', points: 5 }, tags: ['a', 'B'] };
    expect(conditionHolds({ field: 'card.title', op: 'contains', value: 'istanbul' }, data)).toBe(
      true,
    );
    expect(conditionHolds({ field: 'card.points', op: 'gt', value: '3' }, data)).toBe(true);
    expect(conditionHolds({ field: 'card.missing', op: 'exists', value: null }, data)).toBe(false);
    expect(conditionHolds({ field: 'tags', op: 'contains', value: 'b' }, data)).toBe(true);
    expect(renderTemplate('{{answers}}', { answers: { a: 'x', _text: 'Soru: x' } })).toBe(
      'Soru: x',
    );
    expect(renderTemplate('{{card.title}} · {{ card.points }} · {{nope}}', data)).toBe(
      'İstanbul P1 · 5 · ',
    );
    void ({} as AutomationRule);
  });
});
