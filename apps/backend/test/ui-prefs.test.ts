import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { nodes } from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import { createTestApp, join, setupWithOwner, type Client, type TestApp } from './helpers';

/** Personal left-menu order: kept on the server so web and the desktop app share it. */
describe('ui prefs (menu order, sidebars, pages full width)', () => {
  let app: TestApp;
  let owner: Client;
  let mert: Client;

  beforeAll(async () => {
    app = await createTestApp();
    owner = (await setupWithOwner(app)).owner;
    mert = (await join(app, owner, 'mert@milvasoft.com', 'member', [])).person;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('starts with the default order, saves mine, and keeps it per person', async () => {
    expect(await owner.api.call('getUiPrefs')).toEqual({ navOrder: [], pagesFullWidth: false });
    const saved = await owner.api.call('updateUiPrefs', {
      body: { navOrder: ['meet', 'chat', 'meet', 'drive'] },
    });
    // Duplicates go, the first place wins.
    expect(saved).toEqual({ navOrder: ['meet', 'chat', 'drive'], pagesFullWidth: false });
    expect(await owner.api.call('getUiPrefs')).toEqual(saved);
    // Someone else's menu is theirs.
    expect(await mert.api.call('getUiPrefs')).toEqual({ navOrder: [], pagesFullWidth: false });
    // Back to the default.
    expect(await owner.api.call('updateUiPrefs', { body: { navOrder: [] } })).toEqual({
      navOrder: [],
      pagesFullWidth: false,
    });
  });

  it('keeps the web left menu apart from the phone order, per person', async () => {
    const plugin = `plugin:${'p'.repeat(60)}:tab`;
    const saved = await mert.api.call('updateUiPrefs', {
      body: {
        railOrder: ['meet', plugin, 'meet'],
        railHidden: ['mail', 'mail'],
        railShortcuts: { meet: 'g j', chat: '', [plugin]: 'alt+shift+p' },
      },
    });
    expect(saved).toMatchObject({
      navOrder: [],
      railOrder: ['meet', plugin],
      railHidden: ['mail'],
      railShortcuts: { meet: 'g j', chat: '', [plugin]: 'alt+shift+p' },
    });
    expect(await mert.api.call('getUiPrefs')).toEqual(saved);
    expect((await owner.api.call('getUiPrefs')).railOrder).toBeUndefined();
    // The phone's order does not touch it.
    const phone = await mert.api.call('updateUiPrefs', { body: { navOrder: ['chat'] } });
    expect(phone).toMatchObject({ navOrder: ['chat'], railOrder: ['meet', plugin] });
    await mert.api.call('updateUiPrefs', { body: { navOrder: [] } });
  });

  it.each(['ctrl+t', 'alt+d', 'g', 'g ş', 'g  a'])('refuses the shortcut "%s"', async (combo) => {
    const err = await mert.api
      .call('updateUiPrefs', { body: { railShortcuts: { meet: combo } } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('validation_failed');
  });

  it('keeps sidebar widths and collapsed sidebars apart from the menu order', async () => {
    await owner.api.call('updateUiPrefs', { body: { navOrder: ['chat', 'drive'] } });
    const saved = await owner.api.call('updateUiPrefs', {
      body: { sidebarWidths: { chat: 320, drive: 260 }, sidebarCollapsed: ['meet', 'meet'] },
    });
    expect(saved).toEqual({
      navOrder: ['chat', 'drive'],
      sidebarWidths: { chat: 320, drive: 260 },
      sidebarCollapsed: ['meet'],
      pagesFullWidth: false,
    });
    // A field sent again replaces the stored one whole; the others stay.
    const next = await owner.api.call('updateUiPrefs', { body: { sidebarWidths: { pages: 400 } } });
    expect(next).toEqual({ ...saved, sidebarWidths: { pages: 400 } });
    expect(await owner.api.call('getUiPrefs')).toEqual(next);
    await expect(
      owner.api.call('updateUiPrefs', { body: { sidebarWidths: { chat: 5000 } } }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('keeps pages full width as my choice, seeded once from my full-width pages', async () => {
    const zeynep = await join(app, owner, 'zeynep@milvasoft.com', 'member');
    const spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Geniş' },
    });
    await owner.api.call('updatePage', { params: { nodeId: page.id }, body: { fullWidth: true } });
    // Before API level 7 full width was per page; Zeynep last edited this full-width one.
    await app.deps.db
      .update(nodes)
      .set({ updatedBy: zeynep.me.user.id })
      .where(eq(nodes.id, page.id));
    expect(await zeynep.person.api.call('getUiPrefs')).toMatchObject({ pagesFullWidth: true });
    // Seeded once: the page no longer decides, her choice does.
    await owner.api.call('updatePage', { params: { nodeId: page.id }, body: { fullWidth: false } });
    expect(await zeynep.person.api.call('getUiPrefs')).toMatchObject({ pagesFullWidth: true });
    const off = await zeynep.person.api.call('updateUiPrefs', { body: { pagesFullWidth: false } });
    expect(off).toMatchObject({ pagesFullWidth: false });
    await owner.api.call('updatePage', { params: { nodeId: page.id }, body: { fullWidth: true } });
    expect(await zeynep.person.api.call('getUiPrefs')).toMatchObject({ pagesFullWidth: false });
    // Saving another field keeps it.
    const next = await zeynep.person.api.call('updateUiPrefs', { body: { navOrder: ['wiki'] } });
    expect(next).toEqual({ navOrder: ['wiki'], pagesFullWidth: false });
  });

  it('keeps the pages where I hide completed to-dos', async () => {
    const saved = await owner.api.call('updateUiPrefs', {
      body: { pagesHideDone: ['page-a', 'page-b', 'page-a'] },
    });
    expect(saved.pagesHideDone).toEqual(['page-a', 'page-b']);
    expect((await owner.api.call('getUiPrefs')).pagesHideDone).toEqual(['page-a', 'page-b']);
    expect((await mert.api.call('getUiPrefs')).pagesHideDone).toBeUndefined();
  });

  it('refuses a list that is not a short list of ids', async () => {
    const tooMany = Array.from({ length: 41 }, (_, i) => `m${i}`);
    const err = await owner.api
      .call('updateUiPrefs', { body: { navOrder: tooMany } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('validation_failed');
  });
});
