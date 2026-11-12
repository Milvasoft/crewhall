import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifications, organizations } from '@crewhall/db';
import {
  BOARDS_NOTIFICATION_TYPES,
  MEET_NOTIFICATION_TYPES,
  NOTIFICATION_TYPES,
  PAGE_NOTIFICATION_TYPES,
  notificationGroupOf,
  type NotificationCategory,
} from '@crewhall/shared';
import { createNotifications } from '../src/services/notifications/notify';
import { sendPush } from '../src/services/notifications/push';
import { expoStub } from './chat-helpers';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Every type the server sends today (the audit): each must land in a row of the page. */
const SENT_TYPES = [
  ...NOTIFICATION_TYPES,
  ...MEET_NOTIFICATION_TYPES,
  ...BOARDS_NOTIFICATION_TYPES,
  ...PAGE_NOTIFICATION_TYPES,
  'calendar.invited',
  'calendar.updated',
  'calendar.cancelled',
  'calendar.response',
  'calendar.reminder',
  'mail.new',
  'mail.inbox.assigned',
  'forms.response',
  'automations.notify',
  'automations.disabled',
  'plugin.notification',
];

describe('notification rows (groups)', () => {
  it('puts every type the server sends into a row', () => {
    const missing = SENT_TYPES.filter((t) => notificationGroupOf(t) === null);
    expect(missing).toEqual([]);
    expect(notificationGroupOf('meet.call')).toBe('calls');
    expect(notificationGroupOf('meet.call_missed')).toBe('calls');
    expect(notificationGroupOf('meet.invited')).toBe('meetings');
    expect(notificationGroupOf('chat.webhook_failing')).toBe('integrations');
    expect(notificationGroupOf('link.down')).toBe('integrations');
    expect(notificationGroupOf('chat.direct')).toBe('chat_direct');
    expect(notificationGroupOf('mail.inbox.assigned')).toBe('mail');
    expect(notificationGroupOf('kudos.received')).toBe('announcements');
    expect(notificationGroupOf('approval.requested')).toBe('approvals');
    expect(PAGE_NOTIFICATION_TYPES.map(notificationGroupOf)).toEqual(
      PAGE_NOTIFICATION_TYPES.map(() => 'pages'),
    );
    expect(notificationGroupOf('somethingnew.event')).toBeNull();
  });
});

describe('notification preferences per row and channel', () => {
  let app: TestApp;
  let expo: Awaited<ReturnType<typeof expoStub>>;
  let owner: Client;
  let orgId: string;
  let elif: Client;
  let elifId: string;

  const make = async (type: string, category: NotificationCategory) => {
    const [row] = await createNotifications(app.deps.db, [
      {
        orgId,
        userId: elifId,
        type,
        category,
        actorId: null,
        target: { type: 'space', id: orgId },
        data: { title: 'x' },
        url: '/',
      },
    ]);
    return row;
  };

  beforeAll(async () => {
    expo = await expoStub();
    app = await createTestApp({ EXPO_PUSH_URL: expo.url });
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    orgId = setup.orgId;
    const e = await join(app, owner, 'elif@milvasoft.com', 'member');
    elif = e.person;
    elifId = e.me.user.id;
  });

  afterAll(async () => {
    await app?.close();
    await expo.close();
  });

  it('lists every row with all four channels and the defaults of its category', async () => {
    const prefs = await elif.api.call('getNotificationPrefs');
    const row = (k: string) => prefs.groups!.find((g) => g.group === k)!;
    expect(row('chat_messages')).toMatchObject({
      inApp: true,
      desktop: true,
      push: true,
      email: false,
      channels: ['inApp', 'desktop', 'push', 'email'],
    });
    // Calls send no e-mail; security keeps the bell and e-mail.
    expect(row('calls')).toMatchObject({ channels: ['inApp', 'desktop', 'push'], email: false });
    expect(row('security')).toMatchObject({ locked: ['inApp', 'email'], push: false });
    expect(row('chat_alerts').locked).toEqual(['inApp']);
    // Older clients still get the categories.
    expect(prefs.categories.length).toBeGreaterThan(5);
  });

  it('turns one row off on one channel without touching its neighbours', async () => {
    await elif.api.call('updateNotificationPrefs', {
      body: { groups: [{ group: 'chat_direct', push: false }] },
    });
    // chat.direct and chat.reply share the older category; only the direct row changed.
    expect((await make('chat.direct', 'direct_reply'))!.wantsPush).toBe(false);
    expect((await make('chat.reply', 'direct_reply'))!.wantsPush).toBe(true);
    const prefs = await elif.api.call('getNotificationPrefs');
    expect(prefs.groups!.find((g) => g.group === 'chat_direct')).toMatchObject({
      push: false,
      inApp: true,
      email: true,
    });
    // Locked channels stay on whatever is sent.
    const security = await elif.api.call('updateNotificationPrefs', {
      body: { groups: [{ group: 'security', email: false, inApp: false }] },
    });
    expect(security.groups!.find((g) => g.group === 'security')).toMatchObject({
      inApp: true,
      email: true,
    });
  });

  it('keeps the desktop channel apart, and quiet hours silence it', async () => {
    await elif.api.call('updateNotificationPrefs', {
      body: { groups: [{ group: 'boards', desktop: false }] },
    });
    const off = await make('boards.assigned', 'boards');
    expect(off).toMatchObject({ wantsDesktop: false, dismissedAt: null });
    const listed = await elif.api.call('listNotifications', { query: {} });
    expect(listed.items.find((n) => n.id === off!.id)?.desktop).toBe(false);
    expect((await make('boards.comment', 'boards'))!.wantsDesktop).toBe(false);
    expect((await make('page.mention', 'mention'))!.wantsDesktop).toBe(true);
    // No bell row, no OS notification (it comes from the bell's live event).
    await elif.api.call('updateNotificationPrefs', {
      body: { groups: [{ group: 'drive', inApp: false, desktop: true }] },
    });
    expect((await make('drive.shared', 'share'))!.wantsDesktop).toBe(false);

    await elif.api.call('updateNotificationPrefs', {
      body: { quietHours: { from: '00:00', to: '23:59' } },
    });
    expect((await make('page.mention', 'mention'))!.wantsDesktop).toBe(false);
    await elif.api.call('updateNotificationPrefs', { body: { quietHours: null } });
  });

  it('older clients that change a category move the rows nobody set', async () => {
    await elif.api.call('updateNotificationPrefs', {
      body: {
        groups: [{ group: 'calendar', push: true }],
        categories: [{ category: 'meetings', push: false }],
      },
    });
    const prefs = await elif.api.call('getNotificationPrefs');
    const row = (k: string) => prefs.groups!.find((g) => g.group === k)!;
    // meetings follows the category; calendar was set on its own and keeps its value.
    expect(row('meetings').push).toBe(false);
    expect(row('calendar').push).toBe(true);
    expect((await make('meet.invited', 'meetings'))!.wantsPush).toBe(false);
    expect((await make('calendar.invited', 'meetings'))!.wantsPush).toBe(true);
  });

  it('leaves out rows of modules the org turned off', async () => {
    await app.deps.db.execute(
      sql`update ${organizations} set settings = jsonb_set(settings, '{modules}', '{"mail": false, "forms": false}') where id = ${orgId}`,
    );
    const keys = (await elif.api.call('getNotificationPrefs')).groups!.map((g) => g.group);
    expect(keys).not.toContain('mail');
    expect(keys).not.toContain('forms');
    expect(keys).toContain('chat_direct');
    await app.deps.db.execute(
      sql`update ${organizations} set settings = settings - 'modules' where id = ${orgId}`,
    );
  });

  it('mutes push on one device only, until a time or until turned back on', async () => {
    const token = 'ExponentPushToken[elif-phone]';
    await elif.api.call('registerPushDevice', { body: { expoToken: token, platform: 'android' } });
    await elif.api.call('registerPushDevice', {
      body: { expoToken: 'ExponentPushToken[elif-tablet]', platform: 'ios' },
    });
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    const muted = await elif.api.call('mutePushDevice', {
      body: { expoToken: token, mutedUntil: until },
    });
    expect(muted.mutedUntil).toBe(until);

    const sentTo = async () => {
      const before = expo.sent.length;
      const row = await make('chat.mention', 'mention');
      await app.deps.db
        .update(notifications)
        .set({ wantsPush: true })
        .where(eq(notifications.id, row!.id));
      await sendPush(app.deps, row!.id);
      return expo.sent.slice(before).map((m) => m.to);
    };
    expect(await sentTo()).toEqual(['ExponentPushToken[elif-tablet]']);
    await elif.api.call('mutePushDevice', { body: { expoToken: token, mutedUntil: null } });
    expect((await sentTo()).sort()).toEqual([token, 'ExponentPushToken[elif-tablet]'].sort());
    // Only the caller's own devices.
    await expect(
      owner.api.call('mutePushDevice', { body: { expoToken: token, mutedUntil: null } }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
