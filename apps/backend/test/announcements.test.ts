import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifications } from '@crewhall/db';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Roadmap 19: internal announcements, read receipts, "Okudum", notifications and e-mail. */

let app: TestApp;
let owner: Client;
let elif: Client;
let can: Client;
let guest: Client;
let elifId: string;
let canId: string;

beforeAll(async () => {
  app = await createTestApp();
  const setup = await setupWithOwner(app);
  owner = setup.owner;
  elif = (await join(app, owner, 'elif@milvasoft.com', 'member')).person;
  elifId = (await elif.api.call('me')).user.id;
  can = (await join(app, owner, 'can@milvasoft.com', 'member')).person;
  canId = (await can.api.call('me')).user.id;
  guest = (await join(app, owner, 'misafir@example.com', 'guest')).person;
});

afterAll(async () => {
  await app.close();
});

describe('announcements', () => {
  let id: string;

  it('lets admins publish, notifies and e-mails the members (not guests)', async () => {
    app.mailer.outbox.length = 0;
    const a = await owner.api.call('createAnnouncement', {
      body: {
        title: 'Yeni izin politikası',
        body: 'Merhaba ekip,\n\nİzinler iki hafta önceden girilmeli.',
        pinned: true,
        requiresAck: true,
      },
    });
    id = a.id;
    // The author is neither a reader nor in the total (B3).
    expect(a).toMatchObject({ readCount: 0, ackCount: 0, audienceCount: 2 });
    expect(a.pinnedAt).not.toBeNull();
    expect(a.permissions.manage).toBe(true);

    const notes = await elif.api.call('listNotifications');
    const note = notes.items.find((n) => n.type === 'announcement.published');
    expect(note).toMatchObject({ url: `/announcements/${id}`, category: 'announcements' });
    expect(note?.data.title).toBe('Yeni izin politikası');

    const to = app.mailer.outbox.map((m) => m.to).sort();
    expect(to).toEqual(['can@milvasoft.com', 'elif@milvasoft.com']);
    expect(app.mailer.outbox[0]?.subject).toContain('Yeni izin politikası');
    expect(app.mailer.outbox[0]?.text).toContain(`/announcements/${id}`);
    // Mailed already: the digest must not repeat it.
    const raw = await app.deps.db.select().from(notifications);
    expect(raw.filter((n) => n.type === 'announcement.published').every((n) => n.emailedAt)).toBe(
      true,
    );
  });

  it('keeps guests out and members from writing without the permission', async () => {
    await expect(guest.api.call('listAnnouncements')).rejects.toMatchObject({ status: 404 });
    expect(await guest.api.call('getAnnouncementCounts')).toEqual({ unread: 0, pendingAck: 0 });
    await expect(
      elif.api.call('createAnnouncement', { body: { title: 'x', body: 'y' } }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      elif.api.call('updateAnnouncement', { params: { announcementId: id }, body: { title: 'x' } }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      elif.api.call('listAnnouncementReaders', { params: { announcementId: id } }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('counts reads and confirmations', async () => {
    expect(await elif.api.call('getAnnouncementCounts')).toEqual({ unread: 1, pendingAck: 1 });
    const list = await elif.api.call('listAnnouncements', { query: { unreadOnly: 'true' } });
    expect(list.items.map((a) => a.id)).toEqual([id]);

    const read = await elif.api.call('markAnnouncementRead', { params: { announcementId: id } });
    expect(read.my.readAt).not.toBeNull();
    expect(read.readCount).toBe(1);
    // Opened but not confirmed: still to do.
    expect(await elif.api.call('getAnnouncementCounts')).toEqual({ unread: 0, pendingAck: 1 });
    expect(
      (await elif.api.call('listAnnouncements', { query: { unreadOnly: 'true' } })).items,
    ).toHaveLength(1);
    // Opening it reads its bell row too.
    const bell = await elif.api.call('listNotifications');
    expect(bell.items.find((n) => n.type === 'announcement.published')?.readAt).not.toBeNull();

    const acked = await elif.api.call('acknowledgeAnnouncement', {
      params: { announcementId: id },
    });
    expect(acked.my.ackedAt).not.toBeNull();
    expect(acked.ackCount).toBe(1);
    expect(await elif.api.call('getAnnouncementCounts')).toEqual({ unread: 0, pendingAck: 0 });

    const readers = await owner.api.call('listAnnouncementReaders', {
      params: { announcementId: id },
    });
    expect(readers).toMatchObject({ audienceCount: 2, readCount: 1, ackCount: 1 });
    expect(readers.items.map((r) => r.user.id).sort()).toEqual([elifId, canId].sort());
    expect(readers.items.at(-1)?.user.id).toBe(canId);
    expect(readers.items.find((r) => r.user.id === elifId)?.ackedAt).not.toBeNull();
  });

  it('lets a granted member publish, and only the author or an admin manage it', async () => {
    await owner.api.call('updateMember', {
      params: { userId: elifId },
      body: { permissions: ['announcements.publish'] },
    });
    const mine = await elif.api.call('createAnnouncement', {
      body: { title: 'Cuma buluşması', body: 'Saat 16:00.' },
    });
    expect(mine.permissions.manage).toBe(true);
    // Granted but not the author or an admin: can't change someone else's.
    await expect(
      elif.api.call('updateAnnouncement', { params: { announcementId: id }, body: { title: 'x' } }),
    ).rejects.toMatchObject({ status: 403 });
    const edited = await owner.api.call('updateAnnouncement', {
      params: { announcementId: mine.id },
      body: { body: 'Saat 17:00.', pinned: true },
    });
    expect(edited.editedAt).not.toBeNull();

    // Pinned first, then newest.
    const feed = await can.api.call('listAnnouncements');
    expect(feed.items.map((a) => a.id)).toEqual([mine.id, id]);
    await expect(
      can.api.call('acknowledgeAnnouncement', { params: { announcementId: mine.id } }),
    ).rejects.toMatchObject({ code: 'invalid_target' });

    await elif.api.call('deleteAnnouncement', { params: { announcementId: mine.id } });
    await expect(
      can.api.call('getAnnouncement', { params: { announcementId: mine.id } }),
    ).rejects.toMatchObject({ status: 404 });
    const bell = await can.api.call('listNotifications');
    expect(bell.items.filter((n) => n.target.id === mine.id)).toHaveLength(0);
  });
});
