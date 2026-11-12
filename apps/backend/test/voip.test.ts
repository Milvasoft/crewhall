import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { notifications, pushDevices } from '@crewhall/db';
import { VoipPush } from '@crewhall/shared';
import { liveKitSigning, setLiveKit, type LiveKitGateway } from '../src/services/meet/livekit';
import { signDeclineToken } from '../src/services/meet/voip';
import {
  apnsConfig,
  ApnsTransientError,
  resetApns,
  sendVoip,
} from '../src/services/notifications/apns';
import type { JobPayloads } from '../src/jobs/queue';
import { pushCallEnd, sendPush } from '../src/services/notifications/push';
import { sendTestVoip } from '../src/services/notifications/voip-test';
import { expoStub } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Stand-in for APNs over cleartext HTTP/2: records each push, answers per device token. */
async function apnsStub() {
  const pushes: { headers: IncomingHttpHeaders; token: string; body: unknown }[] = [];
  /** token → [status, reason] (default 200). */
  const answers = new Map<string, [number, string]>();
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      const token = String(req.headers[':path']).replace('/3/device/', '');
      pushes.push({ headers: req.headers, token, body: JSON.parse(raw) });
      const [status, reason] = answers.get(token) ?? [200, ''];
      res.statusCode = status;
      res.end(status === 200 ? '' : JSON.stringify({ reason }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    pushes,
    answers,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Enough of LiveKit for calls: rooms and signals are no-ops. */
const liveKit: LiveKitGateway = {
  publicUrl: 'ws://livekit.test',
  egressEnabled: false,
  ...liveKitSigning({ apiKey: 'test-key', apiSecret: 'test-secret-0123456789abcdef0123456789' }),
  ensureRoom: async () => undefined,
  updateRoomMetadata: async () => undefined,
  deleteRoom: async () => undefined,
  sendSignal: async () => undefined,
  listParticipants: async () => [],
  listRooms: async () => [],
  muteTrack: async () => undefined,
  updateParticipant: async () => undefined,
  removeParticipant: async () => undefined,
  startRecording: async () => ({ egressId: 'EG_1' }),
  stopRecording: async () => undefined,
};

const keys = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const VOIP = 'a1'.repeat(32);
const VOIP_DEAD = 'b2'.repeat(32);

let app: TestApp;
let apns: Awaited<ReturnType<typeof apnsStub>>;
/** api.sandbox.push.apple.com: development builds' tokens. */
let sandbox: Awaited<ReturnType<typeof apnsStub>>;
let expo: Awaited<ReturnType<typeof expoStub>>;
let owner: Client;
let zeynep: Client;
let zeynepId: string;
let conversationId: string;

beforeAll(async () => {
  apns = await apnsStub();
  sandbox = await apnsStub();
  expo = await expoStub();
  resetApns();
  app = await createTestApp({
    EXPO_PUSH_URL: expo.url,
    APNS_URL: apns.url,
    APNS_SANDBOX_URL: sandbox.url,
    // A throwaway key: generated here, the endpoint is the stub.
    APNS_KEY_P8: keys.privateKey.replace(/\n/g, '\\n'),
    APNS_KEY_ID: 'KEY123',
    APNS_TEAM_ID: 'TEAM456',
    APNS_BUNDLE_ID: 'com.example.crewhall',
  });
  setLiveKit(app.deps, liveKit);
  const setup = await setupWithOwner(app);
  owner = setup.owner;
  const z = await join(app, owner, 'zeynep@milvasoft.com', 'member');
  zeynep = z.person;
  zeynepId = z.me.user.id;
  conversationId = (
    await owner.api.call('createConversation', { body: { type: 'direct', userId: zeynepId } })
  ).id;
});

afterAll(async () => {
  await app.close();
  resetApns();
  await apns.close();
  await sandbox.close();
  await expo.close();
});

/** Starts a call to Zeynep and sends her phone's push the way the push.send job does. */
async function ring() {
  const call = await owner.api.call('startCall', { body: { conversationId, video: true } });
  const rows = await app.deps.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, zeynepId), eq(notifications.type, 'meet.call')));
  const row = rows.find((r) => r.payload.callId === call.id)!;
  await sendPush(app.deps, row.id);
  return { call, notificationId: row.id, orgId: row.orgId };
}

describe('APNs client', () => {
  it('sends a VoIP push with token auth and the VoIP headers', async () => {
    const cfg = apnsConfig(app.deps.env)!;
    const expiresAt = new Date(Date.now() + 45_000);
    const payload = {
      type: 'meet.call_end' as const,
      callId: '0190f0a0-0000-7000-8000-000000000001',
      notificationId: null,
    };
    expect(await sendVoip(cfg, VOIP, payload, expiresAt)).toEqual({ ok: true });
    const p = apns.pushes.at(-1)!;
    expect(p.token).toBe(VOIP);
    expect(p.body).toEqual(payload);
    expect(p.headers).toMatchObject({
      ':method': 'POST',
      'apns-push-type': 'voip',
      'apns-topic': 'com.example.crewhall.voip',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(expiresAt.getTime() / 1000)),
      'apns-collapse-id': payload.callId,
    });
    const jwt = String(p.headers.authorization).replace(/^bearer /, '');
    const { payload: claims, protectedHeader } = await jwtVerify(
      jwt,
      createPublicKey(keys.publicKey),
    );
    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'KEY123' });
    expect(claims.iss).toBe('TEAM456');
    // The JWT is reused between pushes (Apple refuses one renewed too often).
    await sendVoip(cfg, VOIP, payload, expiresAt);
    expect(apns.pushes.at(-1)!.headers.authorization).toBe(p.headers.authorization);
  });

  it('tells dead tokens from other refusals and transient errors', async () => {
    const cfg = apnsConfig(app.deps.env)!;
    const end = { type: 'meet.call_end' as const, callId: VOIP.slice(0, 36), notificationId: null };
    const at = new Date(Date.now() + 1000);
    apns.answers.set('c3'.repeat(32), [410, 'Unregistered']);
    apns.answers.set('d4'.repeat(32), [400, 'BadDeviceToken']);
    apns.answers.set('e5'.repeat(32), [400, 'PayloadTooLarge']);
    apns.answers.set('f6'.repeat(32), [503, 'ServiceUnavailable']);
    expect(await sendVoip(cfg, 'c3'.repeat(32), end, at)).toMatchObject({
      ok: false,
      disable: true,
    });
    expect(await sendVoip(cfg, 'd4'.repeat(32), end, at)).toMatchObject({
      ok: false,
      disable: true,
    });
    expect(await sendVoip(cfg, 'e5'.repeat(32), end, at)).toEqual({
      ok: false,
      disable: false,
      reason: 'PayloadTooLarge',
    });
    await expect(sendVoip(cfg, 'f6'.repeat(32), end, at)).rejects.toBeInstanceOf(
      ApnsTransientError,
    );
  });

  it('is off until every setting is there', () => {
    expect(apnsConfig({ ...app.deps.env, APNS_TEAM_ID: undefined })).toBeNull();
    expect(apnsConfig({ ...app.deps.env, APNS_KEY_P8: undefined })).toBeNull();
  });
});

describe('iOS incoming calls through CallKit', () => {
  it('registers a VoIP token only for iPhones and only in hex', async () => {
    const d = await zeynep.api.call('registerPushDevice', {
      body: { expoToken: VOIP, platform: 'ios', provider: 'voip', appVersion: '1.0.0' },
    });
    expect(d.provider).toBe('voip');
    await zeynep.api.call('registerPushDevice', {
      body: { expoToken: 'ExponentPushToken[zeynep-iphone]', platform: 'ios' },
    });
    await expect(
      zeynep.api.call('registerPushDevice', {
        body: { expoToken: VOIP_DEAD, platform: 'android', provider: 'voip' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      zeynep.api.call('registerPushDevice', {
        body: { expoToken: 'not-hex', platform: 'ios', provider: 'voip' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('rings the iPhone through CallKit only, and declines from the signed link', async () => {
    const expoBefore = expo.sent.length;
    const before = apns.pushes.length;
    const { call, notificationId, orgId } = await ring();
    const sent = apns.pushes.slice(before).filter((p) => p.token === VOIP);
    expect(sent).toHaveLength(1);
    const push = VoipPush.parse(sent[0]!.body);
    if (push.type !== 'meet.call') throw new Error('type');
    expect(push).toMatchObject({
      callId: call.id,
      notificationId,
      video: true,
      invite: false,
      conversationId,
    });
    expect(push.callerName).not.toBe('');
    expect(Date.parse(push.expiresAt)).toBeGreaterThan(Date.now());
    // CallKit shows the call: the Expo token of the same iPhone gets nothing for it.
    expect(expo.sent.slice(expoBefore).filter((m) => m.to.includes('zeynep-iphone'))).toEqual([]);

    // "Reddet" with no session: the signed link declines as Zeynep.
    const link = new URL(push.declineUrl);
    const forged = await app.app.request(
      `${link.pathname}?token=${signDeclineToken('another-secret-0123456789abcdef0123', {
        callId: call.id,
        userId: zeynepId,
        orgId,
      })}`,
      { method: 'POST' },
    );
    expect(forged.status).toBe(403);
    const jobs = vi.spyOn(app.deps.jobs, 'send');
    const declined = await app.app.request(`${link.pathname}${link.search}`, { method: 'POST' });
    expect(declined.status).toBe(200);
    const after = await owner.api.call('getCall', { params: { callId: call.id } });
    expect(after.members.find((m) => m.user.id === zeynepId)?.state).toBe('declined');
    const endJob = jobs.mock.calls.find(([name]) => name === 'meet.call_end')?.[1] as
      JobPayloads['meet.call_end'] | undefined;
    jobs.mockRestore();
    expect(endJob).toEqual({ orgId, callId: call.id, userIds: [zeynepId], reason: 'declined' });

    // The end goes to the iPhone that rang through VoIP, so CallKit closes the call, with the
    // reason (CallKit's recents show it).
    const endBefore = apns.pushes.length;
    await pushCallEnd(app.deps, endJob!);
    const end = apns.pushes.slice(endBefore).filter((p) => p.token === VOIP);
    expect(end.map((p) => p.body)).toEqual([
      { type: 'meet.call_end', callId: call.id, notificationId, reason: 'declined' },
    ]);
  });

  it('a dead VoIP token is turned off and the ordinary push takes over', async () => {
    await zeynep.api.call('registerPushDevice', {
      body: { expoToken: VOIP_DEAD, platform: 'ios', provider: 'voip' },
    });
    await app.deps.db
      .update(pushDevices)
      .set({ disabledAt: new Date() })
      .where(eq(pushDevices.expoToken, VOIP));
    apns.answers.set(VOIP_DEAD, [410, 'Unregistered']);
    const expoBefore = expo.sent.length;
    const { call } = await ring();
    const [dead] = await app.deps.db
      .select()
      .from(pushDevices)
      .where(eq(pushDevices.expoToken, VOIP_DEAD));
    expect(dead!.disabledAt).not.toBeNull();
    expect(
      expo.sent.slice(expoBefore).filter((m) => m.to === 'ExponentPushToken[zeynep-iphone]'),
    ).toHaveLength(1);
    await owner.api.call('cancelCall', { params: { callId: call.id } });
  });

  it('sends a test call to a person’s iPhones for operators', async () => {
    await app.deps.db
      .update(pushDevices)
      .set({ disabledAt: null })
      .where(eq(pushDevices.expoToken, VOIP));
    const before = apns.pushes.length;
    const r = await sendTestVoip(app.deps.env, app.deps.db, { email: 'zeynep@milvasoft.com' });
    expect(r.results).toEqual([{ token: `${VOIP.slice(0, 8)}…`, result: 'ok (production)' }]);
    const push = VoipPush.parse(apns.pushes.at(-1)!.body);
    expect(push).toMatchObject({ type: 'meet.call', callId: r.callId });
    const end = await sendTestVoip(app.deps.env, app.deps.db, {
      token: VOIP,
      end: r.callId,
    });
    expect(apns.pushes.at(-1)!.body).toEqual({
      type: 'meet.call_end',
      callId: end.callId,
      notificationId: null,
    });
    expect(apns.pushes.length).toBe(before + 2);
    await expect(
      sendTestVoip({ ...app.deps.env, APNS_KEY_ID: undefined }, app.deps.db, { token: VOIP }),
    ).rejects.toThrow(/not set up/);
  });

  it('sends each iPhone to its own APNs environment (dev build next to TestFlight)', async () => {
    const DEV = 'c7'.repeat(32);
    const UNKNOWN = 'd8'.repeat(32);
    const GONE = 'e9'.repeat(32);
    const SAID_PROD = 'fa'.repeat(32);
    // Each token is valid only in its own environment, as at Apple.
    for (const t of [DEV, UNKNOWN]) apns.answers.set(t, [400, 'BadDeviceToken']);
    for (const t of [GONE]) {
      apns.answers.set(t, [400, 'BadDeviceToken']);
      sandbox.answers.set(t, [400, 'BadDeviceToken']);
    }
    apns.answers.set(SAID_PROD, [400, 'BadDeviceToken']);
    await app.deps.db.update(pushDevices).set({ disabledAt: new Date() });
    const dev = await zeynep.api.call('registerPushDevice', {
      body: { expoToken: DEV, platform: 'ios', provider: 'voip', apnsEnvironment: 'sandbox' },
    });
    expect(dev.apnsEnvironment).toBe('sandbox');
    for (const t of [UNKNOWN, GONE]) {
      await zeynep.api.call('registerPushDevice', {
        body: { expoToken: t, platform: 'ios', provider: 'voip' },
      });
    }
    await zeynep.api.call('registerPushDevice', {
      body: {
        expoToken: SAID_PROD,
        platform: 'ios',
        provider: 'voip',
        apnsEnvironment: 'production',
      },
    });
    await expect(
      zeynep.api.call('registerPushDevice', {
        body: {
          expoToken: 'ExponentPushToken[x]',
          platform: 'ios',
          apnsEnvironment: 'sandbox',
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    const prodBefore = apns.pushes.length;
    const sandBefore = sandbox.pushes.length;
    const { call } = await ring();
    const toProd = apns.pushes.slice(prodBefore).map((p) => p.token);
    const toSand = sandbox.pushes.slice(sandBefore).map((p) => p.token);
    // Said sandbox: straight to the sandbox host, never production.
    expect(toSand).toContain(DEV);
    expect(toProd).not.toContain(DEV);
    // Unknown: APNS_ENV (production) first, then sandbox once; it rang there and is kept.
    expect(toProd).toContain(UNKNOWN);
    expect(toSand).toContain(UNKNOWN);
    // Said production: no second try elsewhere.
    expect(toSand).not.toContain(SAID_PROD);
    const rows = new Map(
      (await app.deps.db.select().from(pushDevices)).map((d) => [d.expoToken, d]),
    );
    expect(rows.get(UNKNOWN)).toMatchObject({ apnsEnvironment: 'sandbox', disabledAt: null });
    expect(rows.get(DEV)).toMatchObject({ apnsEnvironment: 'sandbox', disabledAt: null });
    // Refused by both hosts, or by the one it said: really dead.
    expect(rows.get(GONE)!.disabledAt).not.toBeNull();
    expect(rows.get(SAID_PROD)!.disabledAt).not.toBeNull();
    await owner.api.call('cancelCall', { params: { callId: call.id } });

    // Next time the found environment is used directly.
    const again = sandbox.pushes.length;
    const prodAgain = apns.pushes.length;
    const second = await ring();
    expect(apns.pushes.slice(prodAgain).map((p) => p.token)).not.toContain(UNKNOWN);
    expect(sandbox.pushes.slice(again).map((p) => p.token)).toContain(UNKNOWN);
    await owner.api.call('cancelCall', { params: { callId: second.call.id } });
  });
});
