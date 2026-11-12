import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messages } from '@crewhall/db';
import { eq } from 'drizzle-orm';
import { fallsOn, localDay, postCelebrations } from '../src/services/announcements/kudos';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Thank-you wall (kudos), birthdays and work anniversaries. */

let app: TestApp;
let owner: Client;
let elif: Client;
let can: Client;
let guest: Client;
let ownerId: string;
let elifId: string;
let canId: string;
let guestId: string;

beforeAll(async () => {
  app = await createTestApp();
  const setup = await setupWithOwner(app);
  owner = setup.owner;
  ownerId = (await owner.api.call('me')).user.id;
  elif = (await join(app, owner, 'elif@milvasoft.com', 'member')).person;
  elifId = (await elif.api.call('me')).user.id;
  can = (await join(app, owner, 'can@milvasoft.com', 'member')).person;
  canId = (await can.api.call('me')).user.id;
  guest = (await join(app, owner, 'misafir@example.com', 'guest')).person;
  guestId = (await guest.api.call('me')).user.id;
});

afterAll(async () => {
  await app.close();
});

describe('kudos badges', () => {
  it('starts every org with the six ready badges; only admins change them', async () => {
    const list = await elif.api.call('listKudosBadges');
    expect(list.items.map((b) => b.key)).toEqual([
      'teamwork',
      'helping',
      'idea',
      'customer',
      'quality',
      'extraMile',
    ]);
    expect(list.items.every((b) => b.name === null && !b.archived)).toBe(true);
    expect(list.permissions.manage).toBe(false);
    // A second call does not add them again.
    expect((await owner.api.call('listKudosBadges')).items).toHaveLength(6);

    const first = list.items[0]!;
    await expect(
      elif.api.call('updateKudosBadge', { params: { badgeId: first.id }, body: { name: 'x' } }),
    ).rejects.toMatchObject({ status: 403 });
    const renamed = await owner.api.call('updateKudosBadge', {
      params: { badgeId: first.id },
      body: { name: 'Birlikte güçlüyüz' },
    });
    expect(renamed.name).toBe('Birlikte güçlüyüz');
    const back = await owner.api.call('updateKudosBadge', {
      params: { badgeId: first.id },
      body: { name: null },
    });
    expect(back.name).toBeNull();

    const own = await owner.api.call('createKudosBadge', {
      body: { emoji: '🧠', name: 'Problem çözücü' },
    });
    expect(own).toMatchObject({ key: null, position: 6 });
    await expect(
      owner.api.call('createKudosBadge', { body: { emoji: 'abc', name: 'Olmaz' } }),
    ).rejects.toMatchObject({ status: 422 });
    // An org badge has no translated name to fall back to.
    await expect(
      owner.api.call('updateKudosBadge', { params: { badgeId: own.id }, body: { name: null } }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('kudos', () => {
  it('sends a card, notifies the person and shows it on the wall and their profile', async () => {
    const badges = (await elif.api.call('listKudosBadges')).items;
    const card = await elif.api.call('createKudos', {
      body: { toUserId: canId, badgeId: badges[1]!.id, message: 'Sunum için teşekkürler!' },
    });
    expect(card).toMatchObject({
      from: { id: elifId },
      to: { id: canId },
      badge: { key: 'helping' },
      message: 'Sunum için teşekkürler!',
      permissions: { delete: true },
    });

    const note = (await can.api.call('listNotifications')).items.find(
      (n) => n.type === 'kudos.received',
    );
    expect(note).toMatchObject({ url: '/announcements/kudos', category: 'announcements' });

    const wall = await owner.api.call('listKudos');
    expect(wall.items[0]?.id).toBe(card.id);
    expect(wall.items[0]?.permissions.delete).toBe(true);
    expect((await can.api.call('listKudos', { query: { userId: canId } })).items).toHaveLength(1);
    expect((await can.api.call('listKudos', { query: { userId: elifId } })).items).toHaveLength(0);
    // Someone else's card: not theirs to take back.
    await expect(
      can.api.call('deleteKudos', { params: { kudosId: card.id } }),
    ).rejects.toMatchObject({ status: 403 });
    await elif.api.call('deleteKudos', { params: { kudosId: card.id } });
    expect((await owner.api.call('listKudos')).items).toHaveLength(0);
  });

  it('refuses cards to yourself, to guests, with archived badges, and keeps guests out', async () => {
    const badges = (await owner.api.call('listKudosBadges')).items;
    await expect(
      elif.api.call('createKudos', { body: { toUserId: elifId, badgeId: badges[0]!.id } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      elif.api.call('createKudos', { body: { toUserId: guestId, badgeId: badges[0]!.id } }),
    ).rejects.toMatchObject({ status: 404 });
    await owner.api.call('updateKudosBadge', {
      params: { badgeId: badges[2]!.id },
      body: { archived: true },
    });
    await expect(
      elif.api.call('createKudos', { body: { toUserId: canId, badgeId: badges[2]!.id } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(guest.api.call('listKudos')).rejects.toMatchObject({ status: 404 });
  });

  it('pages newest first', async () => {
    const badge = (await owner.api.call('listKudosBadges')).items[0]!;
    for (const msg of ['bir', 'iki', 'üç']) {
      await owner.api.call('createKudos', {
        body: { toUserId: elifId, badgeId: badge.id, message: msg },
      });
    }
    const p1 = await elif.api.call('listKudos', { query: { limit: 2 } });
    expect(p1.items.map((k) => k.message)).toEqual(['üç', 'iki']);
    const p2 = await elif.api.call('listKudos', { query: { limit: 2, cursor: p1.nextCursor! } });
    expect(p2.items.map((k) => k.message)).toEqual(['bir']);
    expect(p2.nextCursor).toBeNull();
  });
});

describe('birthdays and work anniversaries', () => {
  const tz = 'Europe/Istanbul';
  const today = () => localDay(new Date(), tz);
  const yearsAgo = (n: number) => `${Number(today().slice(0, 4)) - n}${today().slice(4)}`;

  it('keeps a birthday private until its person shows it', async () => {
    await elif.api.call('updateDirectoryProfile', {
      params: { userId: elifId },
      body: { birthday: today().slice(5) },
    });
    // Not shown yet: neither on the card nor to others in the directory.
    expect((await can.api.call('getCelebrations')).today).toEqual([]);
    const seen = await can.api.call('getDirectoryPerson', { params: { userId: elifId } });
    expect(seen.birthday).toBeNull();
    expect(
      (await elif.api.call('getDirectoryPerson', { params: { userId: elifId } })).birthday,
    ).toBe(today().slice(5));
    // Only the person turns it on.
    await expect(
      owner.api.call('updateDirectoryProfile', {
        params: { userId: elifId },
        body: { birthdayVisible: true },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await elif.api.call('updateDirectoryProfile', {
      params: { userId: elifId },
      body: { birthdayVisible: true },
    });
    const c = await can.api.call('getCelebrations');
    expect(c.today).toEqual([
      {
        kind: 'birthday',
        user: expect.objectContaining({ id: elifId }),
        date: today(),
        years: null,
      },
    ]);
    await expect(
      elif.api.call('updateDirectoryProfile', {
        params: { userId: elifId },
        body: { birthday: '02-30' },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('counts work anniversaries from the first working day', async () => {
    await owner.api.call('updateDirectoryProfile', {
      params: { userId: canId },
      body: { startedOn: yearsAgo(3) },
    });
    const c = await elif.api.call('getCelebrations');
    expect(c.today).toContainEqual({
      kind: 'anniversary',
      user: expect.objectContaining({ id: canId }),
      date: today(),
      years: 3,
    });
    // Started today: not an anniversary yet.
    await owner.api.call('updateDirectoryProfile', {
      params: { userId: ownerId },
      body: { startedOn: today() },
    });
    expect((await elif.api.call('getCelebrations')).today.some((x) => x.user.id === ownerId)).toBe(
      false,
    );
  });

  it('keeps 29 February on 28 February in other years', () => {
    expect(fallsOn('02-29', '2027-02-28')).toBe(true);
    expect(fallsOn('02-29', '2028-02-28')).toBe(false);
    expect(fallsOn('02-29', '2028-02-29')).toBe(true);
    expect(fallsOn('03-01', '2027-03-01')).toBe(true);
  });

  it('posts the morning celebrations to the chosen channel once', async () => {
    const conv = await owner.api.call('createConversation', {
      body: { type: 'group', userIds: [elifId, canId], name: 'Genel' },
    });
    await expect(
      elif.api.call('updateCelebrationSettings', { body: { channelId: conv.id } }),
    ).rejects.toMatchObject({ status: 403 });
    const s = await owner.api.call('updateCelebrationSettings', {
      body: { channelId: conv.id, kudos: true },
    });
    expect(s).toMatchObject({ channelId: conv.id, birthdays: true, kudos: true });

    // Late enough in the local day for the morning post.
    const noon = new Date(`${today()}T12:00:00+03:00`);
    const posted = await postCelebrations(app.deps, noon);
    expect(posted).toBe(2); // Elif's birthday, Can's third year.
    expect(await postCelebrations(app.deps, noon)).toBe(0);
    const rows = await app.deps.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    const texts = rows.map((r) => r.text);
    expect(texts.some((t) => t.includes(`<@${elifId}>`) && t.includes('🎂'))).toBe(true);
    expect(texts.some((t) => t.includes(`<@${canId}>`) && t.includes('3.'))).toBe(true);

    // A kudos card is posted there too.
    const badge = (await owner.api.call('listKudosBadges')).items[0]!;
    await can.api.call('createKudos', { body: { toUserId: elifId, badgeId: badge.id } });
    const after = await app.deps.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    expect(after.some((r) => r.text.includes(`<@${canId}> → <@${elifId}>`))).toBe(true);
  });
});
