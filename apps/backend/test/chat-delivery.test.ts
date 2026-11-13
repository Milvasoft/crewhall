import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { incomingWebhooks, notifications, organizations, pushDevices } from '@crewhall/db';
import { PushData } from '@crewhall/shared';
import { forgetChatModule } from '../src/services/chat/module';
import { checkReceipts } from '../src/services/notifications/push';
import { runDigest } from '../src/services/notifications/digest';
import { expoStub, listen, until, uuid, WsClient } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, uploadFile, type TestApp } from './helpers';

let app: TestApp;
let server: Awaited<ReturnType<typeof listen>>;
let expo: Awaited<ReturnType<typeof expoStub>>;
let owner: Client;
let elif: Client;
let elifId: string;
let spaceId: string;
let alertId: string;

beforeAll(async () => {
  expo = await expoStub();
  app = await createTestApp({ EXPO_PUSH_URL: expo.url });
  server = await listen(app);
  const setup = await setupWithOwner(app);
  owner = setup.owner;
  spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Milvasoft')!.id;
  const e = await join(app, owner, 'elif@milvasoft.com', 'member', [spaceId]);
  elif = e.person;
  elifId = (await elif.api.call('me')).user.id;
  const alert = await owner.api.call('createConversation', {
    body: { type: 'alert', name: 'Prod Alarmları', spaceId },
  });
  alertId = alert.id;
});

afterAll(async () => {
  await server.close();
  await app.close();
  await expo.close();
});

const hook = (url: string, body: unknown, raw?: string) =>
  app.app.request(new URL(url).pathname + new URL(url).search, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });

describe('incoming webhooks', () => {
  let url: string;
  let webhookId: string;

  it('creates a webhook whose key is only shown once', async () => {
    const created = await owner.api.call('createIncomingWebhook', {
      params: { conversationId: alertId },
      body: { name: 'Seq' },
    });
    url = created.url;
    webhookId = created.webhook.id;
    expect(url).toMatch(/\/api\/hooks\/[0-9a-f-]{36}\?key=[\w-]{20,}$/);
    expect(created.webhook.maskedUrl).not.toContain(new URL(url).searchParams.get('key')!);
    const [row] = await app.deps.db
      .select()
      .from(incomingWebhooks)
      .where(eq(incomingWebhooks.id, webhookId));
    expect(row!.tokenHash).not.toContain(new URL(url).searchParams.get('key')!);
    // Elif is a viewer in the space: webhooks are for editors and up (doc 17 §5).
    await expect(
      elif.api.call('listIncomingWebhooks', { params: { conversationId: alertId } }),
    ).rejects.toMatchObject({ status: 403 });
    const list = await owner.api.call('listIncomingWebhooks', {
      params: { conversationId: alertId },
    });
    expect(list.items[0]).toMatchObject({ name: 'Seq', health: 'active' });
  });

  it('writes Crewhall cards as bot messages and pushes critical ones', async () => {
    await elif.api.call('registerPushDevice', {
      body: { expoToken: 'ExponentPushToken[elif-phone]', platform: 'ios', appVersion: '1.0.0' },
    });
    const ws = await WsClient.open(server.port, elif);
    await ws.waitFor('ready');
    // A visible session means no push; tell the server the app is in the background.
    ws.send({ type: 'heartbeat', active: false, focused: false });
    await until(() => !app.realtime.presence.hasFocusedSession(elifId));
    const res = await hook(url, {
      text: 'Hata oranı eşiği aştı',
      card: {
        severity: 'critical',
        title: 'Hata oranı %5 üstünde',
        source: 'Seq',
        fields: [{ label: 'Servis', value: 'milvaion-api' }],
        buttons: [{ text: "Seq'te aç", url: 'https://seq.example.com/x' }],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messageId: string; seq: number };
    const ev = await ws.waitFor('message.created', (e) => e.message.id === body.messageId);
    expect(ev.message.kind).toBe('webhook');
    expect(ev.message.webhook?.name).toBe('Seq');
    expect(ev.message.card).toMatchObject({ severity: 'critical', title: 'Hata oranı %5 üstünde' });
    const note = await ws.waitFor('notification', (e) => e.notification.type === 'chat.alert');
    expect(note.notification.source).toBe('alerts');
    expect(expo.sent.at(-1)).toMatchObject({
      to: 'ExponentPushToken[elif-phone]',
      priority: 'high',
    });
    expect(expo.sent.at(-1)!.title).toContain('Prod Alarmları');
    expect(PushData.parse(expo.sent.at(-1)!.data)).toMatchObject({ type: 'chat.alert' });
    await ws.close();
  });

  it('accepts Google Chat text and cardsV2 bodies', async () => {
    const text = await hook(url, { text: 'Deploy tamamlandı' });
    expect(text.status).toBe(200);
    const g = await hook(url, {
      cardsV2: [
        {
          cardId: 'a',
          card: {
            header: { title: '[RESOLVED] Disk dolu', subtitle: 'milva-01' },
            sections: [
              {
                widgets: [
                  { decoratedText: { topLabel: 'Disk', text: '<b>%62</b>' } },
                  { textParagraph: { text: 'Eski imajlar silindi.' } },
                  {
                    buttonList: {
                      buttons: [
                        {
                          text: 'Grafana',
                          onClick: { openLink: { url: 'https://g.example.com' } },
                        },
                      ],
                    },
                  },
                  { columns: { columnItems: [] } },
                ],
              },
            ],
          },
        },
      ],
      thread: { threadKey: 'ignored' },
    });
    expect(g.status).toBe(200);
    const { messageId } = (await g.json()) as { messageId: string };
    const page = await elif.api.call('listMessages', { params: { conversationId: alertId } });
    const m = page.items.find((x) => x.id === messageId)!;
    expect(m.card).toMatchObject({
      severity: 'success',
      title: '[RESOLVED] Disk dolu',
      subtitle: 'milva-01',
      fields: [{ label: 'Disk', value: '%62' }],
      text: 'Eski imajlar silindi.',
      buttons: [{ text: 'Grafana', url: 'https://g.example.com' }],
    });
  });

  it('turns any other JSON into messages: one per array element (a Postiz body)', async () => {
    const post = (id: string, content: string) => ({
      id,
      content,
      publishDate: '2025-02-06T13:09:00.000Z',
      releaseURL: `https://facebook.com/release/${id}`,
      state: 'PUBLISHED',
      integration: {
        id: 'cm6s',
        name: 'Milvasoft Instagram',
        providerIdentifier: 'instagram',
        picture: 'https://cdn.example.com/x.jpeg',
        type: 'social',
      },
    });
    const res = await hook(url, [post('a1', 'İlk paylaşım'), post('a2', 'İkinci paylaşım')]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messageId: string; messages: number };
    expect(body.messages).toBe(2);
    const page = await elif.api.call('listMessages', { params: { conversationId: alertId } });
    const first = page.items.find((x) => x.id === body.messageId)!;
    expect(first.kind).toBe('webhook');
    expect(first.card).toMatchObject({
      severity: 'success',
      title: 'Milvasoft Instagram',
      text: 'İlk paylaşım',
      iconUrl: 'https://cdn.example.com/x.jpeg',
      buttons: [{ url: 'https://facebook.com/release/a1' }],
    });
    expect(first.card!.buttons[0]!.text).toMatch(/Paylaşımı aç|Open post/);
    expect(first.card!.fields).toEqual(
      expect.arrayContaining([
        { label: 'state', value: 'PUBLISHED' },
        { label: 'integration.providerIdentifier', value: 'instagram' },
      ]),
    );
    expect(page.items.some((x) => x.card?.text === 'İkinci paylaşım')).toBe(true);

    // Nothing readable: the JSON itself, as a code block.
    const odd = await hook(url, { a: { b: { c: [1, 2] } } });
    expect(odd.status).toBe(200);
    const { messageId } = (await odd.json()) as { messageId: string };
    const again = await elif.api.call('listMessages', { params: { conversationId: alertId } });
    expect(again.items.find((x) => x.id === messageId)!.text.startsWith('```json\n')).toBe(true);
  });

  it('reads plain-text alerts for their severity (no card), by the chat level', async () => {
    const heard = async (text: string) => {
      const res = await hook(url, { text });
      expect(res.status).toBe(200);
      const { messageId } = (await res.json()) as { messageId: string };
      return app.deps.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.targetId, messageId), eq(notifications.userId, elifId)));
    };
    // An alert chat is at "critical" by default: Milvaion's failure lines used to stay silent.
    const failed = await heard("❌ Job Execution Failed: Job 'NotificationCleanupJob' failed.");
    expect(failed).toEqual([
      expect.objectContaining({ type: 'chat.alert', category: 'alert', urgent: false }),
    ]);
    expect(failed[0]!.payload).toMatchObject({ severity: 'critical' });
    expect(await heard("⚠️ Job misfired: Job 'DataExportJob' missed its scheduled run.")).toEqual(
      [],
    );
    expect(await heard('Gece yedeği alındı')).toEqual([]);

    await elif.api.call('updateMyConversation', {
      params: { conversationId: alertId },
      body: { notify: 'all' },
    });
    expect(await heard('⚠️ Disk %85 dolu')).toEqual([
      expect.objectContaining({ type: 'chat.alert', urgent: false }),
    ]);
    expect(await heard('Gece yedeği alındı')).toEqual([
      expect.objectContaining({ type: 'chat.message' }),
    ]);
    await elif.api.call('updateMyConversation', {
      params: { conversationId: alertId },
      body: { notify: 'critical' },
    });
  });

  it("gives text without a card the webhook's chosen severity (Kartsız mesajın önemi)", async () => {
    const send = async (text: string) => {
      const res = await hook(url, { text });
      expect(res.status).toBe(200);
      const { messageId } = (await res.json()) as { messageId: string };
      const rows = await app.deps.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.targetId, messageId), eq(notifications.userId, elifId)));
      return { messageId, rows };
    };
    const set = (textSeverity: 'critical' | 'info' | null) =>
      owner.api.call('updateIncomingWebhook', { params: { webhookId }, body: { textSeverity } });

    expect((await set('critical')).textSeverity).toBe('critical');
    // Chosen by an admin: a critical line is urgent (breaks quiet hours) like a critical card.
    const chosen = await send('Gece yedeği alınamadı');
    expect(chosen.rows).toEqual([
      expect.objectContaining({ type: 'chat.alert', category: 'alert', urgent: true }),
    ]);
    expect(chosen.rows[0]!.payload).toMatchObject({ severity: 'critical' });
    const page = await elif.api.call('listMessages', { params: { conversationId: alertId } });
    const written = page.items.find((m) => m.id === chosen.messageId);
    expect(written?.severity).toBe('critical');

    // "Bilgi": a red emoji no longer reaches a critical-only chat.
    await set('info');
    expect((await send('❌ Job Execution Failed')).rows).toEqual([]);

    // Back to reading the text.
    expect((await set(null)).textSeverity).toBeNull();
    expect((await send('❌ Job Execution Failed')).rows).toEqual([
      expect.objectContaining({ type: 'chat.alert', urgent: false }),
    ]);
  });

  it('rejects bad keys, bad bodies and big bodies, and logs every request', async () => {
    const wrong = await hook(url.replace(/key=.*/, 'key=wrong'), { text: 'x' });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { code: string }).code).toBe('webhook_key_invalid');
    expect((await hook(url, null, '{nope')).status).toBe(400);
    expect((await hook(url, {})).status).toBe(400);
    expect((await hook(url, [])).status).toBe(400);
    expect((await hook(url, { text: 'x'.repeat(40 * 1024) })).status).toBe(413);
    const log = await owner.api.call('listWebhookDeliveries', {
      params: { webhookId },
      query: {},
    });
    const statuses = log.items.map((d) => d.status);
    expect(statuses).toEqual(expect.arrayContaining([200, 401, 400, 413]));
    expect(log.items.some((d) => d.status === 400 && d.bodyExcerpt === '{nope')).toBe(true);
    expect(log.items.every((d) => !(d.bodyExcerpt ?? '').includes('key='))).toBe(true);
    // Three rejections in an hour tell the creator once.
    const n = await app.deps.db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'chat.webhook_failing'));
    expect(n).toHaveLength(1);
  });

  it('limits to the rate per minute with Retry-After', async () => {
    await app.deps.db
      .update(incomingWebhooks)
      .set({ rateLimit: 2 })
      .where(eq(incomingWebhooks.id, webhookId));
    await app.deps.db.execute(sql`delete from webhook_deliveries`);
    expect((await hook(url, { text: '1' })).status).toBe(200);
    expect((await hook(url, { text: '2' })).status).toBe(200);
    const limited = await hook(url, { text: '3' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    const list = await owner.api.call('listIncomingWebhooks', {
      params: { conversationId: alertId },
    });
    expect(list.items[0]!.health).toBe('limited');
    await app.deps.db
      .update(incomingWebhooks)
      .set({ rateLimit: 60 })
      .where(eq(incomingWebhooks.id, webhookId));
  });

  it('regenerating the key stops the old URL at once; muting keeps messages quiet', async () => {
    const fresh = await owner.api.call('regenerateIncomingWebhookKey', { params: { webhookId } });
    expect((await hook(url, { text: 'eski' })).status).toBe(401);
    expect((await hook(fresh.url, { text: 'yeni' })).status).toBe(200);
    url = fresh.url;

    await owner.api.call('updateIncomingWebhook', {
      params: { webhookId },
      body: { mutedUntil: new Date(Date.now() + 3600_000).toISOString() },
    });
    const before = expo.sent.length;
    const res = await hook(url, { card: { severity: 'critical', title: 'Sessiz' } });
    expect(res.status).toBe(200);
    expect(expo.sent.length).toBe(before);
    const disabled = await owner.api.call('updateIncomingWebhook', {
      params: { webhookId },
      body: { disabled: true, mutedUntil: null },
    });
    expect(disabled.health).toBe('disabled');
    expect((await hook(url, { text: 'x' })).status).toBe(403);
  });
});

describe('push devices', () => {
  it('moves a token between people, disables dead ones from receipts', async () => {
    const devices = await elif.api.call('listPushDevices');
    expect(devices.items).toHaveLength(1);
    // Receipts: Expo says the device is gone.
    expo.receiptsDead.add('ExponentPushToken[elif-phone]');
    await checkReceipts({ ...app.deps }, 0);
    const [row] = await app.deps.db
      .select()
      .from(pushDevices)
      .where(eq(pushDevices.expoToken, 'ExponentPushToken[elif-phone]'));
    expect(row!.disabledAt).not.toBeNull();
    // Registering again (new install) turns it back on.
    const again = await elif.api.call('registerPushDevice', {
      body: { expoToken: 'ExponentPushToken[elif-phone]', platform: 'ios' },
    });
    expect(again.disabledAt).toBeNull();
    await elif.api.call('unregisterPushDevice', {
      body: { expoToken: 'ExponentPushToken[elif-phone]' },
    });
    expect((await elif.api.call('listPushDevices')).items).toHaveLength(0);
  });

  it('skips push while the person has a focused session', async () => {
    await elif.api.call('registerPushDevice', {
      body: { expoToken: 'ExponentPushToken[elif-2]', platform: 'android' },
    });
    const direct = await owner.api.call('createConversation', {
      body: { type: 'direct', userId: elifId },
    });
    const ws = await WsClient.open(server.port, elif);
    await ws.waitFor('ready');
    ws.send({ type: 'heartbeat', active: true, focused: true });
    await until(() => app.realtime.presence.hasFocusedSession(elifId));
    const before = expo.sent.length;
    await owner.api.call('sendMessage', {
      params: { conversationId: direct.id },
      body: { clientMsgId: uuid(), text: 'görüyor musun' },
    });
    await ws.waitFor('notification');
    expect(expo.sent.length).toBe(before);
    await ws.close();
    // Not connected: push goes.
    await owner.api.call('sendMessage', {
      params: { conversationId: direct.id },
      body: { clientMsgId: uuid(), text: 'şimdi push' },
    });
    expect(expo.sent.length).toBeGreaterThan(before);
  });
});

describe('attachments', () => {
  it('uploads into the conversation folder and serves by membership', async () => {
    const conv = await owner.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Milvaion Ekibi' },
    });
    // A viewer can't add to the space: her files go to her personal folder.
    const viewerFolder = await elif.api.call('getChatAttachmentFolder', {
      params: { conversationId: conv.id },
    });
    expect(viewerFolder.spaceId).toBe((await elif.api.call('me')).personalSpaceId);
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId: elifId },
      body: { role: 'editor' },
    });
    const folder = await elif.api.call('getChatAttachmentFolder', {
      params: { conversationId: conv.id },
    });
    expect(folder.spaceId).toBe(spaceId);
    const parent = await owner.api.call('getNode', { params: { nodeId: folder.folderId } });
    expect(parent.name).toBe('Milvaion Ekibi');
    expect(parent.path.map((p) => p.name)).toEqual(['Ekler']);
    const done = await uploadFile(elif, {
      spaceId,
      parentId: folder.folderId,
      name: 'rapor.txt',
      content: Buffer.from('merhaba'),
      mime: 'text/plain',
    });
    const msg = await elif.api.call('sendMessage', {
      params: { conversationId: conv.id },
      body: { clientMsgId: uuid(), text: '', attachmentNodeIds: [done.node.id] },
    });
    expect(msg.attachments).toEqual([
      expect.objectContaining({ nodeId: done.node.id, name: 'rapor.txt', removed: false }),
    ]);
    const files = await owner.api.call('listChatFiles', {
      params: { conversationId: conv.id },
      query: {},
    });
    expect(files.totalCount).toBe(1);
    expect(files.totalBytes).toBe(7);
    const link = await owner.api.call('getChatAttachmentUrl', {
      params: { messageId: msg.id, nodeId: done.node.id },
      query: {},
    });
    expect(await (await fetch(link.url)).text()).toBe('merhaba');

    // Someone else's file can't be attached.
    await expect(
      owner.api.call('sendMessage', {
        params: { conversationId: conv.id },
        body: { clientMsgId: uuid(), text: 'x', attachmentNodeIds: [done.node.id] },
      }),
    ).rejects.toMatchObject({ code: 'invalid_target' });

    // Deleting the message trashes the file; the link answers 410.
    await elif.api.call('deleteMessage', { params: { messageId: msg.id } });
    await expect(
      owner.api.call('getChatAttachmentUrl', {
        params: { messageId: msg.id, nodeId: done.node.id },
        query: {},
      }),
    ).rejects.toMatchObject({ status: 410, code: 'chat_attachment_removed' });
  });

  it('puts direct-message files in the sender\'s personal "Chat ekleri"', async () => {
    const direct = await elif.api.call('createConversation', {
      body: { type: 'direct', userId: (await owner.api.call('me')).user.id },
    });
    const folder = await elif.api.call('getChatAttachmentFolder', {
      params: { conversationId: direct.id },
    });
    const me = await elif.api.call('me');
    expect(folder.spaceId).toBe(me.personalSpaceId);
    const node = await elif.api.call('getNode', { params: { nodeId: folder.folderId } });
    expect(node.name).toBe('Chat ekleri');
  });
});

describe('e-mail digest', () => {
  it('mails unread notifications older than 30 minutes, once', async () => {
    await elif.api.call('updateNotificationPrefs', { body: { digest: 'hourly' } });
    await app.deps.db.execute(
      sql`update notifications set created_at = now() - interval '45 minutes', read_at = null, dismissed_at = null, emailed_at = null where user_id = ${elifId}::uuid`,
    );
    await app.deps.db.execute(
      sql`update notifications set wants_email = true where user_id = ${elifId}::uuid and type = 'chat.direct'`,
    );
    const before = app.mailer.outbox.length;
    expect(await runDigest(app.deps)).toBe(1);
    const mail = app.mailer.outbox.at(-1)!;
    expect(mail.to).toBe('elif@milvasoft.com');
    expect(mail.subject).toMatch(/okunmamış/);
    expect(mail.text).toContain('/chat/c/');
    expect(app.mailer.outbox.length).toBe(before + 1);
    expect(await runDigest(app.deps)).toBe(0);
  });
});

describe('phase 1 events on the WebSocket', () => {
  it('sends node.updated to space members when Drive changes', async () => {
    const ws = await WsClient.open(server.port, elif);
    await ws.waitFor('ready');
    const folder = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { parentId: null, name: 'Sözleşmeler' },
    });
    const created = await ws.waitFor('node.updated', (e) => e.nodeId === folder.id);
    expect(created).toMatchObject({ spaceId, parentId: null, change: 'created' });
    await owner.api.call('trashNodes', { body: { nodeIds: [folder.id] } });
    await ws.waitFor('node.updated', (e) => e.nodeId === folder.id && e.change === 'trashed');
    await ws.close();
  });

  it('sends link.status and a link.down notification when a link goes down', async () => {
    const site = createServer((_req, res) => {
      res.statusCode = 503;
      res.end('down');
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
    const port = (site.address() as AddressInfo).port;
    const surfaceId = (await owner.api.call('listSurfaces')).items[0]!.id;
    const card = await owner.api.call('createCard', {
      params: { surfaceId },
      body: { type: 'link', link: { url: `http://127.0.0.1:${port}/health`, title: 'API' } },
    });
    if (card.type !== 'link') throw new Error('type');
    const linkId = card.config.item.linkId;
    const ws = await WsClient.open(server.port, owner);
    await ws.waitFor('ready');
    for (let i = 0; i < 3; i++) await owner.api.call('checkLinkNow', { params: { linkId } });
    const ev = await ws.waitFor('link.status', (e) => e.linkId === linkId);
    expect(ev.health.status).toBe('down');
    const n = await ws.waitFor('notification', (e) => e.notification.type === 'link.down');
    expect(n.notification.source).toBe('alerts');
    await ws.close();
    await new Promise<void>((r) => site.close(() => r()));
  });
});

describe('chat module turned off for the org', () => {
  it('drops chat WS events, rejects webhooks and keeps core events', async () => {
    const created = await owner.api.call('createIncomingWebhook', {
      params: { conversationId: alertId },
      body: { name: 'Kapalı' },
    });
    const direct = await owner.api.call('createConversation', {
      body: { type: 'direct', userId: elifId },
    });
    const [org] = await app.deps.db.select().from(organizations);
    const settings = org!.settings;
    await app.deps.db
      .update(organizations)
      .set({ settings: { ...settings, modules: { chat: false } } as typeof settings })
      .where(eq(organizations.id, org!.id));
    forgetChatModule();

    const res = await hook(created.url, { text: 'x' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('module_disabled');

    const ws = await WsClient.open(server.port, elif);
    await ws.waitFor('ready');
    // The endpoint itself is blocked centrally (platform module guard).
    await expect(
      owner.api.call('sendMessage', {
        params: { conversationId: direct.id },
        body: { clientMsgId: uuid(), text: 'görünmemeli' },
      }),
    ).rejects.toMatchObject({ status: 403, code: 'module_disabled' });
    const folder = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { parentId: null, name: 'Modül kapalıyken' },
    });
    await ws.waitFor('node.updated', (e) => e.nodeId === folder.id);
    expect(ws.of('message.created')).toEqual([]);
    await ws.close();

    await app.deps.db
      .update(organizations)
      .set({ settings: org!.settings })
      .where(eq(organizations.id, org!.id));
    forgetChatModule();
    expect((await hook(created.url, { text: 'açık' })).status).toBe(200);
  });
});
