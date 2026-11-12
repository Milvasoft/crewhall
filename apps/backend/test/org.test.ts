import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLogs, invitations } from '@crewhall/db';
import {
  Client,
  createTestApp,
  join,
  linkFromMail,
  PASSWORD,
  setupWithOwner,
  type TestApp,
} from './helpers';

describe('spaces, invitations and permissions', () => {
  let app: TestApp;
  let owner: Client;
  let orgId: string;
  let defaultSpaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner, orgId } = await setupWithOwner(app));
    const { items } = await owner.api.call('listSpaces');
    defaultSpaceId = items.find((s) => s.isDefault)!.id;
  });
  afterAll(() => app.close());

  it('creates a space with a Turkish slug and refuses a taken slug', async () => {
    const space = await owner.api.call('createSpace', {
      body: { name: 'Ürün Geliştirme', color: 's3' },
    });
    expect(space).toMatchObject({
      slug: 'urun-gelistirme',
      myRole: 'owner',
      memberCount: 1,
      kind: 'shared',
    });
    await expect(
      owner.api.call('createSpace', {
        body: { name: 'Başka', slug: 'urun-gelistirme', color: 's3' },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'space_slug_taken' });
    await expect(
      owner.api.call('createSpace', { body: { name: 'Gri', color: 's6' } }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('replays a write with the same Idempotency-Key', async () => {
    const key = 'create-dumpapp-1';
    const first = await owner.api.call('createSpace', {
      body: { name: 'Dumpapp', color: 's4' },
      idempotencyKey: key,
    });
    const again = await owner.raw<{ id: string }>(
      'POST',
      '/api/v1/spaces',
      { name: 'Dumpapp', color: 's4' },
      { 'Idempotency-Key': key },
    );
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.id);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    const changed = await owner.raw<{ code: string }>(
      'POST',
      '/api/v1/spaces',
      { name: 'Opsiyon', color: 's4' },
      { 'Idempotency-Key': key },
    );
    expect(changed.status).toBe(422);
    expect(changed.body.code).toBe('idempotency_key_reused');
  });

  it('sign-up is invite-only', async () => {
    const c = new Client(app);
    const res = await c.auth<{ code: string }>('/sign-up/email', {
      email: 'stranger@example.com',
      password: PASSWORD,
      name: 'Stranger',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIGNUP_REQUIRES_INVITATION');
  });

  it('invites a member who joins the default and chosen spaces as viewer', async () => {
    const altyapi = (await owner.api.call('listSpaces')).items.find((s) => s.slug === 'altyapi')!;
    const inv = await owner.api.call('createInvitation', {
      body: { email: 'mert@milvasoft.com', role: 'member', spaceIds: [altyapi.id] },
    });
    expect(inv.url).toMatch(/\/invite\//);
    expect(linkFromMail(app, 'mert@milvasoft.com', 'http://localhost:5173/invite/')).toBe(inv.url);

    const token = decodeURIComponent(new URL(inv.url!).pathname.split('/').pop()!);
    const anon = new Client(app);
    const preview = await anon.api.call('getInvitation', { params: { token } });
    expect(preview).toMatchObject({
      orgName: 'Milvasoft',
      email: 'mert@milvasoft.com',
      role: 'member',
      hasAccount: false,
    });
    expect(preview.spaces?.map((s) => s.name).sort()).toEqual(['Altyapı', 'Milvasoft']);

    const mert = new Client(app);
    await mert.auth('/sign-up/email', {
      email: 'mert@milvasoft.com',
      password: PASSWORD,
      name: 'Mert Aydın',
    });
    const me = await mert.api.call('acceptInvitation', { params: { token } });
    expect(me.activeOrgId).toBe(orgId);
    expect(me.memberships[0]?.role).toBe('member');
    expect(me.personalSpaceId).toBeTruthy();
    expect(me.twoFactorRequired).toBe(false);

    const spaces = await mert.api.call('listSpaces');
    expect(spaces.items.map((s) => [s.kind, s.name, s.myRole])).toEqual([
      ['personal', 'Mert Aydın', 'owner'],
      ['shared', 'Altyapı', 'viewer'],
      ['shared', 'Milvasoft', 'viewer'],
    ]);

    // The link is single use.
    await expect(mert.api.call('acceptInvitation', { params: { token } })).rejects.toMatchObject({
      code: 'invitation_expired',
    });
  });

  it('refuses an invitation meant for someone else, and expired ones', async () => {
    const inv = await owner.api.call('createInvitation', {
      body: { email: 'zeynep@milvasoft.com', role: 'member' },
    });
    const token = decodeURIComponent(new URL(inv.url!).pathname.split('/').pop()!);
    const mert = new Client(app);
    await mert.signIn('mert@milvasoft.com');
    await expect(mert.api.call('acceptInvitation', { params: { token } })).rejects.toMatchObject({
      code: 'invitation_email_mismatch',
    });

    await app.deps.db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, inv.id));
    await expect(
      new Client(app).api.call('getInvitation', { params: { token } }),
    ).rejects.toMatchObject({
      status: 410,
      code: 'invitation_expired',
    });
  });

  it('members cannot invite, manage members or see spaces they are not in', async () => {
    const mert = new Client(app);
    await mert.signIn('mert@milvasoft.com');
    await expect(
      mert.api.call('createInvitation', { body: { email: 'x@milvasoft.com', role: 'member' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(mert.api.call('listOrgSpaces')).rejects.toMatchObject({ code: 'forbidden' });

    const secret = await owner.api.call('createSpace', { body: { name: 'Yönetim', color: 's5' } });
    await expect(
      mert.api.call('getSpace', { params: { spaceId: secret.id } }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    // Viewers cannot change members of a space they are in.
    const me = await mert.api.call('me');
    await expect(
      mert.api.call('updateSpaceMember', {
        params: { spaceId: defaultSpaceId, userId: me.user.id },
        body: { role: 'editor' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('space roles: grant up to your own role, audit role changes, protect the owner', async () => {
    const { me: can } = await join(app, owner, 'can@milvasoft.com', 'member');
    const space = await owner.api.call('createSpace', { body: { name: 'Opsiyon', color: 's2' } });
    const added = await owner.api.call('addSpaceMember', {
      params: { spaceId: space.id },
      body: { userId: can.user.id, role: 'editor' },
    });
    expect(added.role).toBe('editor');
    const changed = await owner.api.call('updateSpaceMember', {
      params: { spaceId: space.id, userId: can.user.id },
      body: { role: 'admin' },
    });
    expect(changed.role).toBe('admin');

    const [log] = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'space.member.role'), eq(auditLogs.targetId, space.id)));
    expect(log?.meta).toMatchObject({ userId: can.user.id, from: 'editor', to: 'admin' });

    const canClient = new Client(app);
    await canClient.signIn('can@milvasoft.com');
    const ownerMe = await owner.api.call('me');
    await expect(
      canClient.api.call('removeSpaceMember', {
        params: { spaceId: space.id, userId: ownerMe.user.id },
      }),
    ).rejects.toMatchObject({ code: 'cannot_change_owner' });

    const members = await owner.api.call('listSpaceMembers', { params: { spaceId: space.id } });
    expect(members.items.map((m) => m.role)).toEqual(['owner', 'admin']);

    // Leaving is always allowed (except for the owner).
    await canClient.api.call('removeSpaceMember', {
      params: { spaceId: space.id, userId: can.user.id },
    });
    expect(
      (await owner.api.call('listSpaceMembers', { params: { spaceId: space.id } })).items,
    ).toHaveLength(1);
  });

  it('an org admin manages memberships without content, and self-adds on record', async () => {
    const { person: elif, me: elifMe } = await join(app, owner, 'elif@milvasoft.com', 'admin');
    // Admins need 2FA too (design 01, "Zorunlu 2FA").
    await expect(elif.api.call('listOrgSpaces')).rejects.toMatchObject({
      code: 'two_factor_required',
    });
    await elif.enrolTotp();

    const list = await elif.api.call('listOrgSpaces');
    const yonetim = list.items.find((s) => s.name === 'Yönetim')!;
    expect(yonetim.myRole).toBeNull();
    expect(yonetim.owner?.email).toBe('bugra@milvasoft.com');
    await expect(
      elif.api.call('getSpace', { params: { spaceId: yonetim.id } }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });

    await elif.api.call('addSpaceMember', {
      params: { spaceId: yonetim.id },
      body: { userId: elifMe.user.id, role: 'admin' },
    });
    const [log] = await app.deps.db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, 'space.member.self_add'), eq(auditLogs.targetId, yonetim.id)),
      );
    expect(log?.actorId).toBe(elifMe.user.id);
    expect((await elif.api.call('getSpace', { params: { spaceId: yonetim.id } })).myRole).toBe(
      'admin',
    );
  });

  it('org members: directory with cursor paging, role changes, owner protected', async () => {
    const page1 = await owner.api.call('listMembers', { query: { limit: 2 } });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await owner.api.call('listMembers', {
      query: { limit: 2, cursor: page1.nextCursor! },
    });
    const all = [...page1.items, ...page2.items];
    expect(new Set(all.map((m) => m.user.id)).size).toBe(all.length);

    const search = await owner.api.call('listMembers', { query: { q: 'mert' } });
    expect(search.items.map((m) => m.user.email)).toEqual(['mert@milvasoft.com']);

    const mert = search.items[0]!;
    const updated = await owner.api.call('updateMember', {
      params: { userId: mert.user.id },
      body: { role: 'admin', permissions: ['portal.edit'] },
    });
    expect(updated).toMatchObject({ role: 'admin', permissions: ['portal.edit'] });

    const ownerMe = await owner.api.call('me');
    await expect(
      owner.api.call('updateMember', {
        params: { userId: ownerMe.user.id },
        body: { role: 'admin' },
      }),
    ).rejects.toMatchObject({ code: 'cannot_change_owner' });
  });

  it('suspended members lose access to the org', async () => {
    const { person: selin, me } = await join(app, owner, 'selin@milvasoft.com', 'member');
    expect((await selin.api.call('listSpaces')).items.length).toBeGreaterThan(0);
    await owner.api.call('updateMember', {
      params: { userId: me.user.id },
      body: { status: 'suspended' },
    });
    await expect(selin.api.call('listSpaces')).rejects.toMatchObject({ code: 'forbidden' });
    expect((await selin.api.call('me')).memberships).toHaveLength(0);
  });

  it('guests get no personal space and see only people they share a space with', async () => {
    const dumpapp = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Dumpapp')!;
    const { person: guest, me } = await join(app, owner, 'destek@dumpapp.io', 'guest', [
      dumpapp.id,
    ]);
    expect(me.personalSpaceId).toBeNull();
    const spaces = await guest.api.call('listSpaces');
    expect(spaces.items.map((s) => s.name)).toEqual(['Dumpapp']);
    const people = await guest.api.call('listMembers');
    expect(people.items.map((m) => m.user.email).sort()).toEqual([
      'bugra@milvasoft.com',
      'destek@dumpapp.io',
    ]);
    await expect(
      guest.api.call('createSpace', { body: { name: 'X', color: 's1' } }),
    ).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('org settings, branding and theme need admin rights and are audited', async () => {
    const org = await owner.api.call('updateOrg', {
      body: { settings: { requireTwoFactor: true } },
    });
    expect(org.settings.requireTwoFactor).toBe(true);
    const branding = await owner.api.call('updateBranding', {
      body: { appName: 'Hub', showPoweredBy: false },
    });
    expect(branding).toMatchObject({ appName: 'Hub', showPoweredBy: false, orgName: 'Milvasoft' });
    const current = await owner.api.call('getTheme');
    const { version: _v, ...draft } = current;
    const theme = await owner.api.call('publishTheme', {
      body: { ...draft, light: { ...draft.light, accent: '#F38424' } },
    });
    expect(theme.version).toBe(current.version + 1);
    expect((await new Client(app).api.call('bootstrap')).theme.light.accent).toBe('#F38424');

    // With the org policy on, a member without 2FA is sent to enrolment.
    const zeynep = await join(app, owner, 'zeynep2@milvasoft.com', 'member');
    expect(zeynep.me.twoFactorRequired).toBe(true);
    await expect(zeynep.person.api.call('listSpaces')).rejects.toMatchObject({
      code: 'two_factor_required',
    });

    const actions = (await app.deps.db.select({ a: auditLogs.action }).from(auditLogs)).map(
      (r) => r.a,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['org.update', 'org.branding.update', 'org.theme.publish']),
    );
  });

  it('archives a space (owner only) and lists it under archived', async () => {
    const space = await owner.api.call('createSpace', {
      body: { name: 'Eski Proje', color: 's1' },
    });
    const archived = await owner.api.call('archiveSpace', { params: { spaceId: space.id } });
    expect(archived.archivedAt).toBeTruthy();
    const active = await owner.api.call('listSpaces', { query: { archived: 'false' } });
    expect(active.items.some((s) => s.id === space.id)).toBe(false);
    const old = await owner.api.call('listSpaces', { query: { archived: 'true' } });
    expect(old.items.map((s) => s.id)).toEqual([space.id]);
    const orgOld = await owner.api.call('listOrgSpaces', { query: { archived: '1' } });
    expect(orgOld.items.map((s) => s.id)).toEqual([space.id]);
    const bad = await owner.raw<{ code: string; details: { in: string } }>(
      'GET',
      '/api/v1/spaces?archived=maybe',
    );
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: 'validation_failed', details: { in: 'query' } });
    const me = await owner.api.call('me');
    await expect(
      owner.api.call('archiveSpace', { params: { spaceId: me.personalSpaceId! } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
