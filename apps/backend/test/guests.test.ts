import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgMembers } from '@crewhall/db';
import { expireGuests } from '../src/services/guests';
import {
  Client,
  createTestApp,
  join,
  PASSWORD,
  setupWithOwner,
  uploadFile,
  type TestApp,
} from './helpers';

/**
 * Guests and outside collaboration (roadmap 13): invited into chosen spaces with a chosen
 * role and an optional end date, they see those spaces and the people they work with, and
 * nothing past them.
 */
describe('guests', () => {
  let app: TestApp;
  let owner: Client;
  let orgId: string;
  let spaceId: string;
  let otherSpaceId: string;
  let guest: Client;
  let guestId: string;
  let deniz: Client;
  let denizId: string;
  let canId: string;
  const inAMonth = () => new Date(Date.now() + 30 * 86_400_000).toISOString();

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner, orgId } = await setupWithOwner(app));
    const spaces = (await owner.api.call('listSpaces')).items;
    spaceId = spaces.find((s) => s.name === 'Milvasoft')!.id;
    otherSpaceId = spaces.find((s) => s.name === 'Altyapı')!.id;
    // Deniz works in another space only; Can shares Milvasoft with the guest.
    const d = await join(app, owner, 'deniz@milvasoft.com', 'member', [otherSpaceId]);
    deniz = d.person;
    denizId = d.me.user.id;
    await owner.api
      .call('removeSpaceMember', { params: { spaceId, userId: denizId } })
      .catch(() => undefined);
    canId = (await join(app, owner, 'can@milvasoft.com', 'member', [spaceId])).me.user.id;

    const inv = await owner.api.call('createInvitation', {
      body: {
        email: 'ayse@tedarikci.com',
        role: 'guest',
        spaceIds: [spaceId],
        spaceRole: 'editor',
        memberExpiresAt: inAMonth(),
      },
    });
    expect(inv.memberExpiresAt).not.toBeNull();
    const token = decodeURIComponent(new URL(inv.url!).pathname.split('/').pop()!);
    guest = new Client(app);
    await guest.auth('/sign-up/email', {
      email: 'ayse@tedarikci.com',
      password: PASSWORD,
      name: 'Ayşe Tedarikçi',
    });
    const me = await guest.api.call('acceptInvitation', { params: { token } });
    guestId = me.user.id;
  });
  afterAll(() => app.close());

  it('joins only the invited space, with the invited role and end date', async () => {
    const me = await guest.api.call('me');
    expect(me.accessExpiresAt).not.toBeNull();
    expect(me.personalSpaceId).toBeNull();
    const spaces = (await guest.api.call('listSpaces')).items;
    expect(spaces.map((s) => [s.id, s.myRole])).toEqual([[spaceId, 'editor']]);
  });

  it('only accepts an end date and a space role for guests, and only in the future', async () => {
    await expect(
      owner.api.call('createInvitation', {
        body: {
          email: 'uye@milvasoft.com',
          role: 'member',
          spaceIds: [],
          memberExpiresAt: inAMonth(),
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      owner.api.call('createInvitation', {
        body: {
          email: 'gec@tedarikci.com',
          role: 'guest',
          spaceIds: [spaceId],
          memberExpiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('sees and reaches only people from shared spaces and conversations', async () => {
    const names = async () =>
      (await guest.api.call('listMembers', { query: {} as never })).items.map((m) => m.user.email);
    expect(await names()).toEqual(
      expect.arrayContaining(['bugra@milvasoft.com', 'can@milvasoft.com']),
    );
    expect(await names()).not.toContain('deniz@milvasoft.com');
    await expect(
      guest.api.call('createConversation', { body: { type: 'direct', userId: denizId } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await guest.api.call('getPresence', { body: { userIds: [denizId] } })).items).toEqual(
      [],
    );
    // A direct chat with someone in the same space is fine.
    await expect(
      guest.api.call('createConversation', { body: { type: 'direct', userId: canId } }),
    ).resolves.toMatchObject({ type: 'direct' });

    // Once a member puts them in a group together, Deniz is reachable.
    await deniz.api.call('createConversation', {
      body: { type: 'group', userIds: [guestId, canId], name: 'Tedarik' },
    });
    expect(await names()).toContain('deniz@milvasoft.com');
    await expect(
      guest.api.call('createConversation', { body: { type: 'direct', userId: denizId } }),
    ).resolves.toMatchObject({ type: 'direct' });
  });

  it('works with content but never shares past the space or manages it', async () => {
    const file = await uploadFile(guest, {
      spaceId,
      name: 'teklif.txt',
      content: Buffer.from('fiyat'),
    });
    expect(file.node.name).toBe('teklif.txt');
    await expect(
      guest.api.call('createShare', {
        params: { nodeId: file.node.id },
        body: { kind: 'user', userId: canId, role: 'viewer' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      guest.api.call('addSpaceMember', {
        params: { spaceId },
        body: { userId: denizId, role: 'viewer' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('gets no portal permissions and no API token while guests are not allowed', async () => {
    await expect(
      owner.api.call('updateMember', {
        params: { userId: guestId },
        body: { permissions: ['portal.edit'] },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      guest.api.call('createMcpToken', {
        body: { name: 'Betik', scopes: ['hub:read'], spaceIds: null, expiresInDays: 30 },
      }),
    ).rejects.toMatchObject({ code: 'mcp_guests_not_allowed' });
  });

  it('loses access when the end date passes and gets it back when extended', async () => {
    const end = () =>
      app.deps.db
        .update(orgMembers)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(and(eq(orgMembers.organizationId, orgId), eq(orgMembers.userId, guestId)));
    await end();
    // Before the hourly job runs, the past date already keeps them out.
    await expect(guest.api.call('listSpaces')).rejects.toMatchObject({ status: 403 });
    expect(await expireGuests(app.deps.db)).toBe(1);
    const [row] = await app.deps.db
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.organizationId, orgId), eq(orgMembers.userId, guestId)));
    expect(row!.status).toBe('suspended');

    // Members have no end date; guests only get future ones.
    await expect(
      owner.api.call('updateMember', {
        params: { userId: canId },
        body: { expiresAt: inAMonth() },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const back = await owner.api.call('updateMember', {
      params: { userId: guestId },
      body: { expiresAt: inAMonth() },
    });
    expect(back).toMatchObject({ status: 'active', role: 'guest' });
    expect((await guest.api.call('listSpaces')).items).toHaveLength(1);
  });
});
