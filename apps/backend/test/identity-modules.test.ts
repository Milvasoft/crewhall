import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLogs } from '@crewhall/db';
import { MODULE_KEYS, MODULE_OF_ENDPOINT } from '@crewhall/shared';
import { isModuleEnabled } from '../src/services/identity/modules';
import { Client, join, setupWithOwner, createTestApp, type TestApp } from './helpers';

describe('module switches', () => {
  let app: TestApp;
  let owner: Client;
  let member: Client;
  let orgId: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner, orgId } = await setupWithOwner(app));
    ({ person: member } = await join(app, owner, 'elif@milvasoft.com', 'member'));
  });
  afterAll(() => app.close());

  it('maps module endpoints and leaves the core out', () => {
    expect(MODULE_OF_ENDPOINT.getMcpPolicy).toBe('mcp');
    expect(MODULE_OF_ENDPOINT.listSpaces).toBeUndefined();
    expect(MODULE_OF_ENDPOINT.getSecurityPolicy).toBeUndefined();
  });

  it('reports every module as enabled by default', async () => {
    const me = await member.api.call('me');
    expect(me.modules).toEqual([...MODULE_KEYS]);
    expect(await isModuleEnabled(app.deps.db, orgId, 'meet')).toBe(true);
  });

  it('lets only owners and admins switch modules', async () => {
    await expect(
      member.api.call('updateOrg', { body: { settings: { modules: { mcp: false } } } }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('turns a module off: Me.modules, 403 module_disabled, audit, service check', async () => {
    const org = await owner.api.call('updateOrg', {
      body: { settings: { modules: { mcp: false, meet: false } } },
    });
    expect(org.settings.modules).toEqual({ mcp: false, meet: false });
    // Other settings survive the partial update.
    expect(org.settings.defaultLocale).toBe('tr');

    const me = await member.api.call('me');
    expect(me.modules).not.toContain('mcp');
    expect(me.modules).not.toContain('meet');
    expect(me.modules).toContain('chat');

    await expect(member.api.call('getMcpOverview')).rejects.toMatchObject({
      status: 403,
      code: 'module_disabled',
    });
    await expect(owner.api.call('getMcpPolicy')).rejects.toMatchObject({
      status: 403,
      code: 'module_disabled',
    });
    // Core endpoints keep working.
    await expect(member.api.call('listSpaces')).resolves.toBeTruthy();

    expect(await isModuleEnabled(app.deps.db, orgId, 'meet')).toBe(false);

    const rows = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, 'org.modules.update')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({ disabled: ['meet', 'mcp'] });
  });

  it('drawings follow boards until they have their own switch', async () => {
    const spaceId = (await owner.api.call('listSpaces')).items.find((x) => x.isDefault)!.id;
    const d = await owner.api.call('createDrawing', {
      params: { spaceId },
      body: { name: 'Şema' },
    });
    expect(MODULE_OF_ENDPOINT.listDrawings).toBe('drawings');
    expect(MODULE_OF_ENDPOINT.listBoards).toBe('boards');
    // Card and drawing documents share the token endpoint; each checks its own module.
    expect(MODULE_OF_ENDPOINT.createBoardsCollabToken).toBeUndefined();

    // An org that turns boards off keeps drawings off too (no drawings key yet).
    await owner.api.call('updateOrg', { body: { settings: { modules: { boards: false } } } });
    let me = await member.api.call('me');
    expect(me.modules).not.toContain('boards');
    expect(me.modules).not.toContain('drawings');
    await expect(owner.api.call('listDrawings', { params: { spaceId } })).rejects.toMatchObject({
      status: 403,
      code: 'module_disabled',
    });

    // Turned on on their own: drawings work while boards stay off.
    await owner.api.call('updateOrg', {
      body: { settings: { modules: { boards: false, drawings: true } } },
    });
    me = await member.api.call('me');
    expect(me.modules).toContain('drawings');
    expect(me.modules).not.toContain('boards');
    const list = await owner.api.call('listDrawings', { params: { spaceId } });
    expect(list.items.map((x) => x.id)).toContain(d.id);
    await expect(
      owner.api.call('createBoardsCollabToken', { body: { document: `drawing:${d.id}` } }),
    ).resolves.toMatchObject({ document: `drawing:${d.id}` });
    await expect(owner.api.call('listBoards', { params: { spaceId } })).rejects.toMatchObject({
      status: 403,
      code: 'module_disabled',
    });

    // And the other way round: drawings off, boards on.
    await owner.api.call('updateOrg', {
      body: { settings: { modules: { boards: true, drawings: false } } },
    });
    await expect(
      owner.api.call('createBoardsCollabToken', { body: { document: `drawing:${d.id}` } }),
    ).rejects.toMatchObject({ status: 403, code: 'module_disabled' });
    await expect(owner.api.call('listBoards', { params: { spaceId } })).resolves.toBeTruthy();
    await owner.api.call('updateOrg', {
      body: { settings: { modules: { boards: true, drawings: true } } },
    });
  });

  it('turns it back on', async () => {
    await owner.api.call('updateOrg', {
      body: { settings: { modules: { mcp: true, meet: false } } },
    });
    await expect(member.api.call('getMcpOverview')).resolves.toBeTruthy();
    const me = await member.api.call('me');
    expect(me.modules).toContain('mcp');
    expect(me.modules).not.toContain('meet');
  });
});
