import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLogs, deliverySettings, notifications, pushDevices, pushTickets } from '@crewhall/db';
import { resetFcmCache } from '../src/services/notifications/fcm';
import { checkReceipts, pushCallEnd, sendPush } from '../src/services/notifications/push';
import { uuid } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

// A ringing call needs a live call row; the ring itself is what these tests look at.
vi.mock('../src/services/meet/calls', async (original) => ({
  ...(await original<typeof import('../src/services/meet/calls')>()),
  stillRinging: async () => true,
}));

interface Hit {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

/** One stand-in for Notifike, Google (token + FCM) and Expo; records every request. */
async function providerStub() {
  const hits: Hit[] = [];
  /** Next Notifike answers, first in first out; default: accepted. */
  const notifikeAnswers: { status: number; body: unknown }[] = [];
  let messages = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const path = req.url ?? '';
      const body: unknown = raw && path !== '/token' ? JSON.parse(raw) : raw;
      hits.push({ method: req.method ?? '', path, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      const send = (status: number, payload: unknown) => {
        res.statusCode = status;
        res.end(JSON.stringify(payload));
      };
      if (path === '/token') return send(200, { access_token: 'org-access', expires_in: 3600 });
      if (path.startsWith('/v1/projects/')) return send(200, { name: 'projects/x/messages/1' });
      if (path === '/expo/send') {
        const list = body as { to: string }[];
        return send(200, { data: list.map((_, i) => ({ status: 'ok', id: `expo-${i}` })) });
      }
      if (path === '/notifike/api/v1.0/notifications/send') {
        const next = notifikeAnswers.shift();
        if (next) return send(next.status, next.body);
        const req = body as { recipients: { to: string; externalId?: string }[] };
        return send(200, {
          isSuccess: true,
          statusCode: 200,
          messages: [],
          data: req.recipients.map((r) => ({
            messageId: `00000000-0000-4000-8000-${String(++messages).padStart(12, '0')}`,
            to: r.to,
            externalId: r.externalId ?? null,
            status: 2,
            isDuplicate: false,
          })),
        });
      }
      if (path === '/notifike/api/v1.0/notifications/statuses') {
        const { messageIds } = body as { messageIds: string[] };
        return send(200, {
          isSuccess: true,
          data: messageIds.map((id, i) => ({
            messageId: id,
            status: i === 0 ? 6 : 4,
            to: 'x',
            lastError: i === 0 ? 'Fcm: Requested entity was not found.' : null,
          })),
        });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    hits,
    notifikeAnswers,
    notifike: () => hits.filter((h) => h.path.startsWith('/notifike/')),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A minimal SMTP server: EHLO, AUTH PLAIN, MAIL, RCPT, DATA. */
async function smtpStub(password: string) {
  const mails: { from: string; to: string[]; data: string; auth: string | null }[] = [];
  const server = createTcpServer((sock) => {
    let buf = '';
    let inData = false;
    let cur = { from: '', to: [] as string[], data: '', auth: null as string | null };
    sock.write('220 stub ESMTP\r\n');
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      for (let i = buf.indexOf('\r\n'); i >= 0; i = buf.indexOf('\r\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            mails.push(cur);
            cur = { from: '', to: [], data: '', auth: cur.auth };
            sock.write('250 OK queued\r\n');
          } else {
            cur.data += `${line}\n`;
          }
          continue;
        }
        const cmd = line.split(' ')[0]!.toUpperCase();
        if (cmd === 'EHLO') sock.write('250-stub\r\n250-AUTH PLAIN\r\n250 OK\r\n');
        else if (cmd === 'AUTH') {
          const plain = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8');
          cur.auth = plain;
          sock.write(
            plain.endsWith(`\0${password}`) ? '235 OK\r\n' : '535 Authentication failed\r\n',
          );
        } else if (cmd === 'MAIL') {
          cur.from = line;
          sock.write('250 OK\r\n');
        } else if (cmd === 'RCPT') {
          cur.to.push(line);
          sock.write('250 OK\r\n');
        } else if (cmd === 'DATA') {
          inData = true;
          sock.write('354 go\r\n');
        } else if (cmd === 'QUIT') {
          sock.end('221 bye\r\n');
        } else sock.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    mails,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const SMTP_PASSWORD = 's3cret-smtp-pass';
const NOTIFIKE_KEY = 'nfk_live_0123456789abcdef';
const EXPO_TOKEN = 'expo-org-access-token';

let app: TestApp;
let stub: Awaited<ReturnType<typeof providerStub>>;
let smtp: Awaited<ReturnType<typeof smtpStub>>;
let owner: Client;
let elif: Client;
let orgId: string;
let elifId: string;
let directId: string;
let serviceAccount: string;

const settings = () => owner.api.call('getDeliverySettings');
const update = (body: Parameters<typeof owner.api.call<'updateDeliverySettings'>>[1]['body']) =>
  owner.api.call('updateDeliverySettings', { body });
const testEmail = (to?: string) =>
  owner.api.call('testDelivery', { body: { channel: 'email', ...(to ? { to } : {}) } });

const dm = async (text: string) => {
  const m = await owner.api.call('sendMessage', {
    params: { conversationId: directId },
    body: { clientMsgId: uuid(), text },
  });
  const [n] = await app.deps.db
    .select()
    .from(notifications)
    .where(eq(notifications.targetId, m.id));
  return n!;
};

beforeAll(async () => {
  stub = await providerStub();
  smtp = await smtpStub(SMTP_PASSWORD);
  resetFcmCache();
  // No FIREBASE_* here: FCM only works through an org's own service account.
  app = await createTestApp({ EXPO_PUSH_URL: `${stub.url}/expo`, FCM_API_URL: stub.url });
  ({ owner, orgId } = await setupWithOwner(app));
  const e = await join(app, owner, 'elif@milvasoft.com', 'member');
  elif = e.person;
  elifId = (await elif.api.call('me')).user.id;
  directId = (
    await owner.api.call('createConversation', { body: { type: 'direct', userId: elifId } })
  ).id;
  await elif.api.call('registerPushDevice', {
    body: { expoToken: 'fcm-elif-phone', platform: 'android', appVersion: '1.0.0' },
  });
  await elif.api.call('registerPushDevice', {
    body: { expoToken: 'ExponentPushToken[elif-tablet]', platform: 'ios' },
  });
  serviceAccount = JSON.stringify({
    type: 'service_account',
    project_id: 'org-project',
    client_email: 'push@org-project.iam.gserviceaccount.com',
    private_key: keys.privateKey,
    token_uri: `${stub.url}/token`,
  });
});

afterAll(async () => {
  await app.close();
  await stub.close();
  await smtp.close();
  resetFcmCache();
});

beforeEach(() => {
  stub.hits.length = 0;
  stub.notifikeAnswers.length = 0;
});

describe('delivery settings (Yönetim › Bildirim gönderimi)', () => {
  it('defaults to the server settings and sends through them', async () => {
    const s = await settings();
    expect(s.email).toMatchObject({ mode: 'env', configured: true, lastTest: null });
    expect(s.push).toMatchObject({ mode: 'env', configured: true });
    expect(s.notifike).toEqual({
      baseUrl: null,
      apiKey: { set: false, hint: null, updatedAt: null },
      authFailedAt: null,
    });
    expect(s.server).toEqual({ email: true, fcm: false });

    const before = app.mailer.outbox.length;
    const result = await testEmail('test@milvasoft.com');
    expect(result).toMatchObject({ channel: 'email', ok: true, via: 'env', recipients: 1 });
    expect(app.mailer.outbox.slice(before).map((m) => m.to)).toEqual(['test@milvasoft.com']);
    expect((await settings()).email.lastTest).toMatchObject({ ok: true, via: 'env' });
  });

  it('is for owners and admins only', async () => {
    await expect(elif.api.call('getDeliverySettings')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      elif.api.call('updateDeliverySettings', { body: { email: { mode: 'env' } } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses a mode without its required fields', async () => {
    await expect(update({ email: { mode: 'smtp' } })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(update({ push: { mode: 'direct' } })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(update({ push: { mode: 'notifike' } })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    const bad = await owner.raw<{ details: { issues: { path: string[]; message: string }[] } }>(
      'PATCH',
      '/api/v1/org/delivery',
      { push: { fcmServiceAccount: JSON.stringify({ project_id: 'x' }) } },
    );
    expect(bad.status).toBe(422);
    const issue = bad.body.details.issues[0]!;
    expect(issue.path).toEqual(['push', 'fcmServiceAccount']);
    expect(issue.message).toContain('client_email');
  });

  it('stores secrets encrypted and never returns them', async () => {
    const s = await update({
      email: {
        smtp: {
          host: '127.0.0.1',
          port: smtp.port,
          security: 'none',
          username: 'ops',
          password: SMTP_PASSWORD,
          from: 'Ops <ops@milvasoft.com>',
        },
      },
      push: { fcmServiceAccount: serviceAccount, expoAccessToken: EXPO_TOKEN },
      notifike: { baseUrl: `${stub.url}/notifike/`, apiKey: NOTIFIKE_KEY },
    });
    const text = JSON.stringify(s);
    for (const secret of [SMTP_PASSWORD, NOTIFIKE_KEY, EXPO_TOKEN, 'PRIVATE KEY']) {
      expect(text).not.toContain(secret);
    }
    expect(s.email.smtp.password).toMatchObject({ set: true, hint: null });
    expect(s.push.direct).toMatchObject({
      fcmProjectId: 'org-project',
      fcmServiceAccount: { set: true },
      expoAccessToken: { set: true },
    });
    expect(s.notifike).toMatchObject({
      baseUrl: `${stub.url}/notifike`,
      apiKey: { set: true, hint: 'cdef' },
    });
    // Still 'env' for both channels until a mode is chosen.
    expect([s.email.mode, s.push.mode]).toEqual(['env', 'env']);

    const [row] = await app.deps.db
      .select()
      .from(deliverySettings)
      .where(eq(deliverySettings.orgId, orgId));
    const stored = JSON.stringify(row);
    for (const secret of [SMTP_PASSWORD, NOTIFIKE_KEY, EXPO_TOKEN, 'PRIVATE KEY']) {
      expect(stored).not.toContain(secret);
    }
    const [log] = await app.deps.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'org.delivery.update'));
    expect(log!.meta).toMatchObject({
      changed: expect.arrayContaining(['email.smtp.password', 'notifike.apiKey']),
    });
    expect(JSON.stringify(log!.meta)).not.toContain(SMTP_PASSWORD);
  });
});

describe('own SMTP server', () => {
  it('sends with the stored password, not through the server SMTP', async () => {
    await update({ email: { mode: 'smtp' } });
    const before = app.mailer.outbox.length;
    const result = await testEmail('smtp@milvasoft.com');
    expect(result).toMatchObject({ ok: true, via: 'smtp', recipients: 1, code: null });
    const mail = smtp.mails.at(-1)!;
    expect(mail.auth).toBe(`\0ops\0${SMTP_PASSWORD}`);
    expect(mail.from).toContain('ops@milvasoft.com');
    expect(mail.to[0]).toContain('smtp@milvasoft.com');
    expect(mail.data).toContain('Subject:');
    expect(app.mailer.outbox.length).toBe(before);
  });

  it('reports a refused login as delivery_unauthorized', async () => {
    await update({ email: { smtp: { password: 'wrong-password' } } });
    const result = await testEmail();
    expect(result).toMatchObject({ ok: false, code: 'delivery_unauthorized' });
    await update({ email: { smtp: { password: SMTP_PASSWORD } } });
  });
});

describe('Notifike', () => {
  it('sends e-mail with the key header and the integration body', async () => {
    await update({ email: { mode: 'notifike' } });
    const result = await testEmail('nk@milvasoft.com');
    expect(result).toMatchObject({ ok: true, via: 'notifike', recipients: 1 });
    const [hit] = stub.notifike();
    expect(hit!.method).toBe('POST');
    expect(hit!.path).toBe('/notifike/api/v1.0/notifications/send');
    expect(hit!.headers['x-api-key']).toBe(NOTIFIKE_KEY);
    const body = hit!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'body',
      'channel',
      'priority',
      'recipients',
      'subject',
      'tags',
    ]);
    expect(body).toMatchObject({
      channel: 1,
      recipients: [{ to: 'nk@milvasoft.com' }],
      priority: 5,
      tags: ['crewhall'],
    });
    expect(String(body.subject)).toContain('test');
    expect(String(body.body)).toContain('<html');
  });

  it.each([
    [
      401,
      { isSuccess: false, messages: [{ key: 'InvalidApiKey', message: 'Invalid key' }] },
      'delivery_unauthorized',
    ],
    [
      429,
      { isSuccess: false, messages: [{ key: 'DailyLimitExceeded', message: 'Limit' }] },
      'delivery_rate_limited',
    ],
    [503, {}, 'delivery_provider_error'],
    [
      400,
      { isSuccess: false, messages: [{ key: 'TemplateDisabled', message: 'Off' }] },
      'delivery_rejected',
    ],
  ])('maps HTTP %i to %s', async (status, body, code) => {
    stub.notifikeAnswers.push({ status, body });
    const result = await testEmail();
    expect(result).toMatchObject({ ok: false, code });
  });

  it('remembers a refused key until it changes, and audits it once', async () => {
    const s = await settings();
    expect(s.notifike.authFailedAt).not.toBeNull();
    stub.notifikeAnswers.push({ status: 401, body: {} });
    await testEmail();
    const logs = await app.deps.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'org.delivery.auth_failed'));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.meta).toMatchObject({ status: 401, key: 'InvalidApiKey' });
    const fresh = await update({ notifike: { apiKey: NOTIFIKE_KEY } });
    expect(fresh.notifike.authFailedAt).toBeNull();
  });

  it('pushes to FCM tokens and keeps Expo tokens on Expo', async () => {
    await update({ push: { mode: 'notifike' } });
    const n = await dm('Notifike ile gelsin');
    const [hit] = stub.notifike();
    expect(hit!.headers['x-api-key']).toBe(NOTIFIKE_KEY);
    const [device] = await app.deps.db
      .select()
      .from(pushDevices)
      .where(eq(pushDevices.expoToken, 'fcm-elif-phone'));
    expect(hit!.body).toEqual({
      channel: 3,
      recipients: [{ to: 'fcm-elif-phone', externalId: `${n.id}:p:${device!.id}` }],
      pushKind: 1,
      priority: 9,
      subject: expect.any(String),
      body: expect.stringContaining('Notifike ile gelsin'),
      data: [
        { key: 'url', value: n.url },
        { key: 'notificationId', value: n.id },
        { key: 'type', value: 'chat.direct' },
      ],
    });
    const expo = stub.hits.filter((h) => h.path === '/expo/send');
    expect((expo[0]!.body as { to: string }[]).map((m) => m.to)).toEqual([
      'ExponentPushToken[elif-tablet]',
    ]);
    // Notifike mode has no Expo token of its own: the server's (none here) is used.
    expect(expo[0]!.headers.authorization).toBeUndefined();
    const tickets = await app.deps.db
      .select()
      .from(pushTickets)
      .where(and(eq(pushTickets.notificationId, n.id), eq(pushTickets.provider, 'notifike')));
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.ticketId).toMatch(/^00000000-/);
  });

  it('rings a call as a silent, high-priority push and ends it the same way', async () => {
    await app.deps.db
      .update(pushDevices)
      .set({ appVersion: '0.2.0' })
      .where(eq(pushDevices.expoToken, 'fcm-elif-phone'));
    const n = await dm('arama');
    const callId = uuid();
    await app.deps.db
      .update(notifications)
      .set({
        type: 'meet.call',
        payload: { callId, actorName: 'Ahmet', conversationTitle: 'Ahmet' },
        pushedAt: null,
        pushOutcome: null,
      })
      .where(eq(notifications.id, n.id));
    stub.hits.length = 0;
    await sendPush(app.deps, n.id);
    const ring = stub.notifike()[0]!.body as Record<string, unknown>;
    expect(ring).toMatchObject({ channel: 3, pushKind: 2, priority: 9 });
    expect(ring.subject).toBeUndefined();
    const data = Object.fromEntries(
      (ring.data as { key: string; value: string }[]).map((d) => [d.key, d.value]),
    );
    expect(data).toMatchObject({ type: 'meet.call', callId, notificationId: n.id, video: 'false' });
    expect(Date.parse(data.expiresAt!)).toBeGreaterThan(Date.now());

    stub.hits.length = 0;
    await pushCallEnd(app.deps, { orgId, callId, userIds: [elifId] });
    const end = stub.notifike()[0]!.body as Record<string, unknown>;
    expect(end).toMatchObject({
      channel: 3,
      pushKind: 2,
      priority: 9,
      data: [
        { key: 'type', value: 'meet.call_end' },
        { key: 'callId', value: callId },
        { key: 'notificationId', value: n.id },
      ],
    });
  });

  it('reads message statuses for the receipts', async () => {
    await app.deps.db
      .update(pushTickets)
      .set({ createdAt: sql`now() - interval '1 hour'` })
      .where(eq(pushTickets.provider, 'notifike'));
    await checkReceipts(app.deps);
    const hit = stub.notifike().find((h) => h.path.endsWith('/notifications/statuses'))!;
    expect(hit.method).toBe('PATCH');
    expect(hit.headers['x-api-key']).toBe(NOTIFIKE_KEY);
    const tickets = await app.deps.db
      .select()
      .from(pushTickets)
      .where(eq(pushTickets.provider, 'notifike'));
    expect(tickets.every((t) => t.checkedAt)).toBe(true);
    expect(tickets.map((t) => t.error)).toContain('Fcm: Requested entity was not found.');
  });
});

describe('own FCM and Expo credentials', () => {
  it('sends with the org service account and Expo token', async () => {
    await update({ push: { mode: 'direct' } });
    await app.deps.db
      .update(pushDevices)
      .set({ appVersion: '1.0.0' })
      .where(eq(pushDevices.expoToken, 'fcm-elif-phone'));
    await dm('kendi FCM hesabımızla');
    const fcm = stub.hits.filter((h) => h.path === '/v1/projects/org-project/messages:send');
    expect(fcm).toHaveLength(1);
    expect(fcm[0]!.headers.authorization).toBe('Bearer org-access');
    expect((fcm[0]!.body as { message: { token: string } }).message.token).toBe('fcm-elif-phone');
    const expo = stub.hits.filter((h) => h.path === '/expo/send');
    expect(expo[0]!.headers.authorization).toBe(`Bearer ${EXPO_TOKEN}`);
    expect(stub.notifike()).toHaveLength(0);
  });

  it('sends a test push to the caller only, and says so when there is no device', async () => {
    const none = await owner.api.call('testDelivery', { body: { channel: 'push' } });
    expect(none).toMatchObject({ ok: false, code: 'delivery_no_device', via: 'direct' });
    const result = await elifAdminTest();
    expect(result).toMatchObject({ ok: true, via: 'direct', recipients: 2 });
  });
});

/** Elif becomes an admin and tests push to her own two devices. */
async function elifAdminTest() {
  await owner.api.call('updateMember', {
    params: { userId: elifId },
    body: { role: 'admin' },
  });
  // Admins need a second factor.
  await elif.enrolTotp();
  return elif.api.call('testDelivery', { body: { channel: 'push' } });
}
