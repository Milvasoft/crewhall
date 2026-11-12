import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { notifications } from '@crewhall/db';
import type { NotificationCategory } from '@crewhall/shared';
import { createBoss, pgBossJobs } from '../src/jobs/queue';
import {
  createNotifications,
  deliverNotifications,
  setPushHoldForTests,
} from '../src/services/notifications/notify';
import { sendPush } from '../src/services/notifications/push';
import { expoStub, listen, WsClient } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * Chat pushes "sometimes arrive": the causes found on 2026-11-04, each pinned here. The first
 * uses the real pg-boss: the inline test queue has no singleton behaviour.
 */
describe('a burst of messages (real pg-boss)', () => {
  it('sends the first at once and the rest when the window ends, none dropped', async () => {
    const url = inject('databaseUrl');
    const boss = await createBoss(url);
    const jobs = pgBossJobs(boss);
    const key = `push:burst:${Date.now()}`;
    const options = { singletonKey: key, singletonSeconds: 15, singletonNextSlot: true };
    // Just past a window's start, so all three sends share it as in a real burst.
    await new Promise((r) => setTimeout(r, 15_000 - (Date.now() % 15_000) + 200));
    for (const notificationId of ['first', 'second', 'third']) {
      await jobs.send('push.send', { notificationId }, options);
    }
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    const { rows } = await c.query<{ id: string; start_after: Date; created_on: Date }>(
      `select data->>'notificationId' as id, start_after, created_on from pgboss.job
       where name = 'push.send' and singleton_key = $1 order by start_after`,
      [key],
    );
    await c.end();
    await jobs.stop();
    // Before this fix: one job. The tail job reads the newest row of the group when it runs.
    expect(rows.map((r) => r.id)).toEqual(['first', 'second']);
    const wait = rows[1]!.start_after.getTime() - rows[1]!.created_on.getTime();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(17_000);
  });
});

describe('who gets a push', () => {
  let app: TestApp;
  let server: Awaited<ReturnType<typeof listen>>;
  let expo: Awaited<ReturnType<typeof expoStub>>;
  let owner: Client;
  let orgId: string;
  let elif: Client;
  let elifId: string;
  const PHONE = 'ExponentPushToken[elif-phone]';

  const make = async (type = 'chat.direct', category: NotificationCategory = 'direct_reply') => {
    const [row] = await createNotifications(
      app.deps.db,
      [
        {
          orgId,
          userId: elifId,
          type,
          category,
          actorId: null,
          target: { type: 'conversation', id: orgId },
          data: { excerpt: 'selam' },
          url: '/chat',
          groupKey: `chat:test:${type}`,
        },
      ],
      app.deps.presence,
    );
    return row!;
  };
  const row = async (id: string) =>
    (await app.deps.db.select().from(notifications).where(eq(notifications.id, id)))[0]!;

  beforeAll(async () => {
    expo = await expoStub();
    app = await createTestApp({ EXPO_PUSH_URL: expo.url });
    server = await listen(app);
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    orgId = setup.orgId;
    const e = await join(app, owner, 'elif@milvasoft.com', 'member');
    elif = e.person;
    elifId = e.me.user.id;
    await elif.api.call('registerPushDevice', { body: { expoToken: PHONE, platform: 'android' } });
  });

  afterAll(async () => {
    await server.close();
    await app?.close();
    await expo.close();
  });

  it('a visible tab nobody touches does not keep the phone silent', async () => {
    const presence = app.deps.presence;
    presence.connect('pc', elifId, null);
    // Right after connecting nothing is known: the phone may ring.
    expect(presence.hasFocusedSession(elifId)).toBe(false);

    presence.heartbeat('pc', elifId, true, true, 'conv-1', { client: 'web', idleSeconds: 5 });
    expect(presence.hasFocusedSession(elifId)).toBe(true);
    expect(presence.isViewingConversation(elifId, 'conv-1')).toBe(true);
    // Held, not dropped: it goes to the phone if still unread once the person left (holdPush).
    expect(await make()).toMatchObject({ wantsPush: true, pushSkip: 'attending' });

    // The person left the PC; the tab stays visible and keeps sending heartbeats.
    presence.heartbeat('pc', elifId, true, true, 'conv-1', { client: 'web', idleSeconds: 600 });
    expect(presence.hasFocusedSession(elifId)).toBe(false);
    expect(presence.isViewingConversation(elifId, 'conv-1')).toBe(false);
    const away = await make('chat.mention', 'mention');
    expect(away).toMatchObject({ wantsPush: true, pushSkip: null });

    // A phone in the foreground needs no touches: it locks itself.
    presence.connect('phone', elifId, null);
    presence.heartbeat('phone', elifId, true, true, null, { client: 'mobile', idleSeconds: 600 });
    expect(presence.hasFocusedSession(elifId)).toBe(true);
    presence.disconnect('phone', elifId);
    presence.disconnect('pc', elifId);
  });

  it('holds the push while the person is at the PC and sends it once they left, if unread', async () => {
    setPushHoldForTests(60, 5_000);
    const presence = app.deps.presence;
    presence.connect('held', elifId, null);
    const at = (idleSeconds: number) =>
      presence.heartbeat('held', elifId, true, true, null, { client: 'web', idleSeconds });
    const note = async (key: string) => {
      const [r] = await createNotifications(
        app.deps.db,
        [
          {
            orgId,
            userId: elifId,
            type: 'chat.alert',
            category: 'alert',
            actorId: null,
            target: { type: 'conversation', id: orgId },
            data: { excerpt: '❌ Job failed' },
            url: '/chat',
            groupKey: `chat:held:${key}`,
          },
        ],
        presence,
      );
      return r!;
    };
    const pushedFor = (id: string) =>
      expo.sent.filter(
        (m) => (m.data as { notificationId?: string } | undefined)?.notificationId === id,
      );
    try {
      at(1);
      const unread = await note('unread');
      expect(unread).toMatchObject({ wantsPush: true, pushSkip: 'attending' });
      await deliverNotifications(app.deps, [unread]);
      // Still at the PC after a hold: kept back, looked at again.
      await new Promise((r) => setTimeout(r, 150));
      at(1);
      expect(pushedFor(unread.id)).toEqual([]);

      const read = await note('read');
      await deliverNotifications(app.deps, [read]);
      await app.deps.db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(eq(notifications.id, read.id));

      // Left the PC: the unread one goes to the phone, the read one never does.
      at(600);
      await expect.poll(() => pushedFor(unread.id).length, { timeout: 3_000 }).toBe(1);
      expect(pushedFor(read.id)).toEqual([]);
      expect(await row(unread.id)).toMatchObject({ pushSkip: null });
      expect((await row(read.id)).pushedAt).toBeNull();
    } finally {
      setPushHoldForTests();
      presence.disconnect('held', elifId);
    }
  });

  it('applies a heartbeat sent the moment the socket opens', async () => {
    const t = await elif.api.call('createWsTicket');
    const c = await WsClient.openWithTicket(server.port, t.ticket);
    // Before "ready": the web sends this from onopen.
    c.send({ type: 'heartbeat', active: true, focused: false, client: 'web', idleSeconds: 3 });
    await c.waitFor('ready');
    await expect.poll(() => app.deps.presence.sessions(elifId).at(-1)?.client).toBe('web');
    await c.close();
  });

  it('records why a notification will not push', async () => {
    await elif.api.call('updateNotificationPrefs', {
      body: { groups: [{ group: 'pages', push: false }] },
    });
    expect(await make('page.mention', 'mention')).toMatchObject({
      wantsPush: false,
      pushSkip: 'pref_off',
    });
    await elif.api.call('updateNotificationPrefs', {
      body: { quietHours: { from: '00:00', to: '23:59' } },
    });
    expect(await make('chat.reply', 'direct_reply')).toMatchObject({
      wantsPush: false,
      pushSkip: 'quiet_hours',
    });
    await elif.api.call('updateNotificationPrefs', { body: { quietHours: null } });
    await elif.api.call('updateMyStatus', { body: { visibility: 'dnd' } });
    expect(await make('chat.alert', 'alert')).toMatchObject({ pushSkip: 'dnd' });
    await elif.api.call('updateMyStatus', { body: { visibility: 'online' } });
  });

  it('a window that ends after the row was read sends the newer row of the conversation', async () => {
    const first = await make('chat.message', 'conversation_message');
    await app.deps.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(eq(notifications.id, first.id));
    const newer = await make('chat.message', 'conversation_message');
    expect(newer.id).not.toBe(first.id);
    const before = expo.sent.length;
    // The job was queued for the first row.
    await sendPush(app.deps, first.id);
    expect(expo.sent.slice(before).map((m) => m.to)).toEqual([PHONE]);
    expect((await row(newer.id)).pushedAt).not.toBeNull();
  });

  it('does not retry when Expo refuses the request, and retries when Expo is down', async () => {
    const answer = (status: number) =>
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status }));
    const refused = await make('chat.direct', 'direct_reply');
    await app.deps.db
      .update(notifications)
      .set({ wantsPush: true, pushedAt: null, pushOutcome: null })
      .where(eq(notifications.id, refused.id));
    // The test server's four "expo push failed" (403, no EXPO_ACCESS_TOKEN).
    const forbidden = answer(403);
    await sendPush(app.deps, refused.id);
    forbidden.mockRestore();
    const after = await row(refused.id);
    expect(after.pushedAt).not.toBeNull();
    expect(after.pushOutcome).toEqual([
      expect.objectContaining({ provider: 'expo', ok: false, error: 'http_403' }),
    ]);

    await app.deps.db
      .update(notifications)
      .set({ pushedAt: null, pushOutcome: null })
      .where(eq(notifications.id, refused.id));
    const down = answer(503);
    await expect(sendPush(app.deps, refused.id)).rejects.toThrow();
    down.mockRestore();
    expect((await row(refused.id)).pushedAt).toBeNull();
  });

  it('says what each provider answered, and when there is no device', async () => {
    const pushed = await row((await make('chat.reply', 'direct_reply')).id);
    await app.deps.db
      .update(notifications)
      .set({ wantsPush: true, pushedAt: null, pushOutcome: null })
      .where(eq(notifications.id, pushed.id));
    await sendPush(app.deps, pushed.id);
    expect((await row(pushed.id)).pushOutcome).toEqual([
      expect.objectContaining({ provider: 'expo', ok: true }),
    ]);

    await elif.api.call('unregisterPushDevice', { body: { expoToken: PHONE } });
    const lonely = await make('boards.assigned', 'boards');
    await sendPush(app.deps, lonely.id);
    expect((await row(lonely.id)).pushSkip).toBe('no_devices');
  });

  it('shows admins why, and nobody else', async () => {
    app.deps.presence.connect('pc', elifId, null);
    app.deps.presence.heartbeat('pc', elifId, true, true, null, { client: 'web', idleSeconds: 2 });
    await elif.api.call('registerPushDevice', { body: { expoToken: PHONE, platform: 'android' } });
    const d = await owner.api.call('getPushDiagnostics', {
      params: { userId: elifId },
      query: {},
    });
    expect(d.sessions).toEqual([expect.objectContaining({ client: 'web', attending: true })]);
    expect(d.devices).toEqual([expect.objectContaining({ provider: 'expo', disabledAt: null })]);
    expect(JSON.stringify(d)).not.toContain('ExponentPushToken');
    expect(d.groups.find((g) => g.group === 'chat_direct')?.push).toBe(true);
    expect(d.recent.some((r) => r.pushSkip === 'pref_off')).toBe(true);
    await expect(
      elif.api.call('getPushDiagnostics', { params: { userId: elifId }, query: {} }),
    ).rejects.toMatchObject({ status: 403 });
    app.deps.presence.disconnect('pc', elifId);
  });
});
