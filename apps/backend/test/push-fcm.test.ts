import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { createPublicKey } from 'node:crypto';
import { jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifications, pushDevices } from '@crewhall/db';
import { PushData } from '@crewhall/shared';
import { FcmTransientError, resetFcmCache } from '../src/services/notifications/fcm';
import {
  callRingData,
  pushCallEnd,
  pushClear,
  pushTag,
  sendPush,
} from '../src/services/notifications/push';
import { expoStub, uuid } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Stand-in for Google's token endpoint and FCM HTTP v1. */
async function googleStub() {
  const tokenRequests: string[] = [];
  const sends: { auth: string; body: { message: Record<string, unknown> } }[] = [];
  /** token → how FCM answers it (default 200). */
  const behaviour = new Map<string, () => { status: number; body: unknown }>();
  let issued = 0;
  const server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') {
        tokenRequests.push(new URLSearchParams(raw).get('assertion') ?? '');
        res.end(JSON.stringify({ access_token: `access-${++issued}`, expires_in: 3600 }));
        return;
      }
      if (req.url === '/v1/projects/crewhall-test/messages:send') {
        const body = JSON.parse(raw) as { message: Record<string, unknown> };
        sends.push({ auth: req.headers.authorization ?? '', body });
        const answer = behaviour.get(String(body.message.token))?.() ?? {
          status: 200,
          body: { name: 'projects/crewhall-test/messages/1' },
        };
        res.statusCode = answer.status;
        res.end(JSON.stringify(answer.body));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    tokenRequests,
    sends,
    behaviour,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

let app: TestApp;
let google: Awaited<ReturnType<typeof googleStub>>;
let expo: Awaited<ReturnType<typeof expoStub>>;
let owner: Client;
let elif: Client;
let elifId: string;
let directId: string;

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
  google = await googleStub();
  expo = await expoStub();
  resetFcmCache();
  app = await createTestApp({
    EXPO_PUSH_URL: expo.url,
    FCM_API_URL: google.url,
    // A throwaway account: the key is generated here, the endpoints are the stub.
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      type: 'service_account',
      project_id: 'crewhall-test',
      client_email: 'push@crewhall-test.iam.gserviceaccount.com',
      private_key: keys.privateKey,
      token_uri: `${google.url}/token`,
    }),
  });
  ({ owner } = await setupWithOwner(app));
  const e = await join(app, owner, 'elif@milvasoft.com', 'member');
  elif = e.person;
  elifId = (await elif.api.call('me')).user.id;
  directId = (
    await owner.api.call('createConversation', { body: { type: 'direct', userId: elifId } })
  ).id;
});

afterAll(async () => {
  await app.close();
  await google.close();
  await expo.close();
  resetFcmCache();
});

describe('FCM push (HTTP v1)', () => {
  it('registers native tokens as FCM devices and Expo tokens as Expo ones', async () => {
    const fcm = await elif.api.call('registerPushDevice', {
      body: { expoToken: 'fcm-elif-phone:APA91b', platform: 'android', appVersion: '1.1.0' },
    });
    expect(fcm.provider).toBe('fcm');
    const ex = await elif.api.call('registerPushDevice', {
      body: { expoToken: 'ExponentPushToken[elif-tablet]', platform: 'ios' },
    });
    expect(ex.provider).toBe('expo');
    const explicit = await owner.api.call('registerPushDevice', {
      body: { expoToken: 'owner-token', platform: 'ios', provider: 'fcm' },
    });
    expect(explicit.provider).toBe('fcm');
  });

  it('sends through FCM with a service-account token, and Expo devices still through Expo', async () => {
    const n = await dm('FCM ile gelsin');
    const sent = google.sends.filter((s) => s.body.message.token === 'fcm-elif-phone:APA91b');
    expect(sent).toHaveLength(1);
    const msg = sent[0]!.body.message as {
      notification: { title: string; body: string };
      data: Record<string, string>;
      android: { priority: string; notification: { channel_id: string } };
      apns: { headers: Record<string, string> };
    };
    expect(msg.notification.body).toContain('FCM ile gelsin');
    expect(PushData.parse(msg.data)).toEqual({
      url: n.url,
      notificationId: n.id,
      type: 'chat.direct',
    });
    expect(msg.android).toMatchObject({
      priority: 'HIGH',
      notification: { channel_id: 'default' },
    });
    expect(msg.apns.headers['apns-priority']).toBe('10');
    expect(sent[0]!.auth).toBe('Bearer access-1');
    expect(expo.sent.map((m) => m.to)).toContain('ExponentPushToken[elif-tablet]');

    // The OAuth assertion is a JWT signed with the service account's key, for FCM's scope.
    const { payload } = await jwtVerify(google.tokenRequests[0]!, createPublicKey(keys.publicKey));
    expect(payload).toMatchObject({
      iss: 'push@crewhall-test.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: `${google.url}/token`,
    });
  });

  it('reuses the access token until it expires', async () => {
    const before = google.tokenRequests.length;
    await dm('ikinci');
    await dm('üçüncü');
    expect(google.tokenRequests.length).toBe(before);
    expect(google.sends.at(-1)!.auth).toBe('Bearer access-1');
  });

  it('disables a device FCM calls unregistered or invalid', async () => {
    await elif.api.call('registerPushDevice', {
      body: { expoToken: 'fcm-gone', platform: 'android' },
    });
    await elif.api.call('registerPushDevice', {
      body: { expoToken: 'fcm-garbage', platform: 'android' },
    });
    google.behaviour.set('fcm-gone', () => ({
      status: 404,
      body: {
        error: {
          status: 'NOT_FOUND',
          details: [
            {
              '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
              errorCode: 'UNREGISTERED',
            },
          ],
        },
      },
    }));
    // What FCM really answers for a malformed token.
    google.behaviour.set('fcm-garbage', () => ({
      status: 400,
      body: {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'The registration token is not a valid FCM registration token',
          details: [
            { fieldViolations: [{ field: 'message.token' }] },
            { errorCode: 'INVALID_ARGUMENT' },
          ],
        },
      },
    }));
    await dm('ölü cihazlar');
    const rows = await app.deps.db.select().from(pushDevices);
    const by = new Map(rows.map((r) => [r.expoToken, r]));
    expect(by.get('fcm-gone')).toMatchObject({ disabledReason: 'UNREGISTERED' });
    expect(by.get('fcm-gone')!.disabledAt).not.toBeNull();
    expect(by.get('fcm-garbage')).toMatchObject({ disabledReason: 'INVALID_ARGUMENT' });
    expect(by.get('fcm-garbage')!.disabledAt).not.toBeNull();
    expect(by.get('fcm-elif-phone:APA91b')!.disabledAt).toBeNull();
  });

  it('keeps the device when FCM refuses the message rather than the token', async () => {
    await elif.api.call('registerPushDevice', {
      body: { expoToken: 'fcm-healthy', platform: 'android' },
    });
    google.behaviour.set('fcm-healthy', () => ({
      status: 400,
      body: {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'Invalid value at message.android.notification.sound',
          details: [
            { fieldViolations: [{ field: 'message.android.notification.sound' }] },
            { errorCode: 'INVALID_ARGUMENT' },
          ],
        },
      },
    }));
    const n = await dm('FCM bu mesajı reddediyor');
    const [device] = await app.deps.db
      .select()
      .from(pushDevices)
      .where(eq(pushDevices.expoToken, 'fcm-healthy'));
    expect(device!.disabledAt).toBeNull();
    // The refusal is on the notification, for the diagnostics.
    const [row] = await app.deps.db.select().from(notifications).where(eq(notifications.id, n.id));
    expect(row!.pushOutcome).toContainEqual({
      deviceId: device!.id,
      provider: 'fcm',
      ok: false,
      error: 'INVALID_ARGUMENT',
    });
    google.behaviour.delete('fcm-healthy');
    await elif.api.call('unregisterPushDevice', { body: { expoToken: 'fcm-healthy' } });
  });

  it('lets the job retry on 503 / 429 and sends on the next run', async () => {
    let calls = 0;
    google.behaviour.set('fcm-elif-phone:APA91b', () =>
      ++calls === 1
        ? { status: 503, body: { error: { status: 'UNAVAILABLE' } } }
        : { status: 200, body: { name: 'ok' } },
    );
    // The inline job of sendMessage takes the 503 (logged); run the job again like pg-boss.
    const n = await dm('yeniden dene');
    const [after] = await app.deps.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, n.id));
    expect(after!.pushedAt).toBeNull();
    await sendPush(app.deps, n.id);
    expect(calls).toBe(2);
    const [done] = await app.deps.db.select().from(notifications).where(eq(notifications.id, n.id));
    expect(done!.pushedAt).not.toBeNull();

    google.behaviour.set('fcm-elif-phone:APA91b', () => ({ status: 429, body: {} }));
    const m = await dm('kota');
    await expect(sendPush(app.deps, m.id)).rejects.toBeInstanceOf(FcmTransientError);
    google.behaviour.delete('fcm-elif-phone:APA91b');
  });

  it('mints a new access token when FCM says the old one is no longer valid', async () => {
    let calls = 0;
    google.behaviour.set('fcm-elif-phone:APA91b', () =>
      ++calls === 1
        ? { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } }
        : { status: 200, body: { name: 'ok' } },
    );
    const before = google.tokenRequests.length;
    await dm('yeni jeton');
    expect(google.tokenRequests.length).toBe(before + 1);
    expect(google.sends.at(-1)!.auth).toBe(`Bearer access-${before + 1}`);
    google.behaviour.delete('fcm-elif-phone:APA91b');
  });
});

describe('incoming calls on Android apps that ring from data-only messages (H7)', () => {
  it('builds the ring as strings with an expiry', () => {
    const ring = callRingData(
      {
        id: 'n1',
        url: '/toplantilar/oda/x?arama=c1',
        conversationId: 'conv1',
        payload: { actorName: 'Elif Yıldız', video: true },
      } as unknown as Parameters<typeof callRingData>[0],
      'c1',
      'Elif Yıldız arıyor',
      'Ekip',
    );
    expect(ring).toMatchObject({
      type: 'meet.call',
      callId: 'c1',
      notificationId: 'n1',
      // A row stored before the English paths rings with the current one.
      url: '/meetings/room/x?call=c1',
      conversationId: 'conv1',
      callerName: 'Elif Yıldız',
      video: 'true',
      title: 'Elif Yıldız arıyor',
      body: 'Ekip',
    });
    expect(Object.values(ring).every((v) => typeof v === 'string')).toBe(true);
    expect(Date.parse(ring.expiresAt) - Date.now()).toBeGreaterThan(40_000);
  });

  it('sends meet.call_end only to Android apps from 0.2.0 on', async () => {
    await elif.api.call('registerPushDevice', {
      body: { expoToken: 'fcm-elif-old:APA91b', platform: 'android', appVersion: '0.1.0' },
    });
    await elif.api.call('registerPushDevice', {
      body: { expoToken: 'fcm-elif-new:APA91b', platform: 'android', appVersion: '0.2.0' },
    });
    const [device] = await app.deps.db
      .select({ orgId: pushDevices.orgId })
      .from(pushDevices)
      .where(eq(pushDevices.expoToken, 'fcm-elif-new:APA91b'));
    const before = google.sends.length;
    await pushCallEnd(app.deps, { orgId: device!.orgId, callId: 'call-1', userIds: [elifId] });
    const sent = google.sends.slice(before).map((s) => s.body.message);
    const tokens = sent.map((m) => m.token);
    expect(tokens).toContain('fcm-elif-new:APA91b');
    expect(tokens).not.toContain('fcm-elif-old:APA91b');
    const end = sent.find((m) => m.token === 'fcm-elif-new:APA91b')!;
    expect(end.notification).toBeUndefined();
    expect(end.data).toEqual({ type: 'meet.call_end', callId: 'call-1' });
    expect(end.android).toEqual({ priority: 'HIGH', ttl: '45s' });
  });
});

describe('a plugin notification on the phone', () => {
  it('carries a tag when it can be cleared, and the clear goes only to apps that handle it', async () => {
    await elif.api.call('registerPushDevice', {
      body: { expoToken: 'fcm-clear-new:APA91b', platform: 'android', appVersion: '0.3.0' },
    });
    await elif.api.call('registerPushDevice', {
      body: { expoToken: 'fcm-clear-old:APA91b', platform: 'android', appVersion: '0.2.0' },
    });
    const key = 'plugin:inst-1:chat-42';
    const n = await dm('eklenti');
    await app.deps.db
      .update(notifications)
      .set({
        type: 'plugin.notification',
        groupKey: key,
        pushedAt: null,
        pushOutcome: null,
        wantsPush: true,
      })
      .where(eq(notifications.id, n.id));
    const sentBefore = google.sends.length;
    await sendPush(app.deps, n.id);
    const push = google.sends
      .slice(sentBefore)
      .map((s) => s.body.message)
      .find((m) => m.token === 'fcm-clear-new:APA91b') as {
      data: Record<string, string>;
      android: { notification: { tag?: string } };
      apns: { headers: Record<string, string> };
    };
    const tag = pushTag(key);
    expect(tag).toHaveLength(32);
    expect(PushData.parse(push.data).tag).toBe(tag);
    expect(push.android.notification.tag).toBe(tag);
    expect(push.apns.headers['apns-collapse-id']).toBe(tag);

    const before = google.sends.length;
    await pushClear(app.deps, { orgId: n.orgId, userId: elifId, tag });
    const sent = google.sends.slice(before).map((s) => s.body.message);
    const tokens = sent.map((m) => m.token);
    expect(tokens).toContain('fcm-clear-new:APA91b');
    expect(tokens).not.toContain('fcm-clear-old:APA91b');
    const clear = sent.find((m) => m.token === 'fcm-clear-new:APA91b')!;
    expect(clear.notification).toBeUndefined();
    expect(clear.data).toEqual({ type: 'notification.clear', tag });
    expect(clear.apns).toMatchObject({
      headers: { 'apns-push-type': 'background' },
      payload: { aps: { 'content-available': 1 } },
    });
  });

  it('has no tag on other notifications', async () => {
    const before = google.sends.length;
    await dm('sıradan');
    const msg = google.sends
      .slice(before)
      .map((s) => s.body.message)
      .find((m) => m.token === 'fcm-clear-new:APA91b') as {
      data: Record<string, string>;
      android: { notification: { tag?: string } };
    };
    expect(msg.data.tag).toBeUndefined();
    expect(msg.android.notification.tag).toBeUndefined();
  });
});
