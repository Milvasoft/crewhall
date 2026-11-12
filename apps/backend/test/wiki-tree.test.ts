import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Page tree drag and drop (design 5.1): movePage reorders siblings and changes parents. */
describe('wiki page tree moves', () => {
  let app: TestApp;
  let owner: Client;
  let viewer: Client;
  let spaceId: string;

  const tree = async () =>
    (await owner.api.call('listPageTree', { params: { spaceId } })).items
      .slice()
      .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
  const childrenOf = async (parentId: string | null) =>
    (await tree()).filter((i) => i.parentId === parentId).map((i) => i.name);
  const page = (name: string, parentId: string | null = null) =>
    owner.api.call('createPage', { params: { spaceId }, body: { name, parentId } });

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    // Invited people join default spaces as viewers.
    viewer = (await join(app, owner, 'selin@milvasoft.com', 'member')).person;
  });
  afterAll(async () => {
    await app?.close();
  });

  it('reorders siblings and nests a page under another one', async () => {
    const a = await page('Alfa');
    const b = await page('Beta');
    const c = await page('Gama');
    expect(await childrenOf(null)).toEqual(['Alfa', 'Beta', 'Gama']);

    await owner.api.call('movePage', { params: { nodeId: c.id }, body: { beforeId: a.id } });
    expect(await childrenOf(null)).toEqual(['Gama', 'Alfa', 'Beta']);
    await owner.api.call('movePage', { params: { nodeId: c.id }, body: { afterId: b.id } });
    expect(await childrenOf(null)).toEqual(['Alfa', 'Beta', 'Gama']);

    // Into Alfa (last child), then before the first child.
    const moved = await owner.api.call('movePage', {
      params: { nodeId: b.id },
      body: { parentId: a.id },
    });
    expect(moved.parentId).toBe(a.id);
    expect(moved.path.map((p) => p.name)).toContain('Alfa');
    const d = await page('Delta', a.id);
    await owner.api.call('movePage', { params: { nodeId: d.id }, body: { beforeId: b.id } });
    expect(await childrenOf(a.id)).toEqual(['Delta', 'Beta']);

    // Back to the root, between Alfa and Gama; Delta stays under Alfa.
    await owner.api.call('movePage', { params: { nodeId: b.id }, body: { afterId: a.id } });
    expect(await childrenOf(null)).toEqual(['Alfa', 'Beta', 'Gama']);
    expect(await childrenOf(a.id)).toEqual(['Delta']);
  });

  it('moves the subtree with the page and refuses a move into itself', async () => {
    const parent = await page('Üst');
    const child = await page('Alt', parent.id);
    const grandchild = await page('En alt', child.id);
    const target = await page('Hedef');

    await owner.api.call('movePage', {
      params: { nodeId: parent.id },
      body: { parentId: target.id },
    });
    const g = await owner.api.call('getPage', { params: { nodeId: grandchild.id } });
    expect(g.path.map((p) => p.name)).toEqual(['Hedef', 'Üst', 'Alt']);

    await expect(
      owner.api.call('movePage', {
        params: { nodeId: parent.id },
        body: { parentId: grandchild.id },
      }),
    ).rejects.toMatchObject({ code: 'invalid_target' });
    await expect(
      owner.api.call('movePage', { params: { nodeId: parent.id }, body: { parentId: parent.id } }),
    ).rejects.toMatchObject({ code: 'invalid_target' });
    await expect(
      owner.api.call('movePage', { params: { nodeId: child.id }, body: { afterId: child.id } }),
    ).rejects.toMatchObject({ code: 'invalid_target' });
  });

  it("renames on a name clash and goes into the sibling's folder", async () => {
    const host = await page('Ev sahibi');
    await page('Başlıksız', host.id);
    const loose = await page('Başlıksız');
    const moved = await owner.api.call('movePage', {
      params: { nodeId: loose.id },
      body: { parentId: host.id },
    });
    expect(moved.name).toBe('Başlıksız (2)');

    // A page inside a Drive folder: "after it" puts the moved page in the same folder.
    const folder = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { parentId: null, name: 'Klasör' },
    });
    const inFolder = await page('Klasördeki', folder.id);
    const outside = await page('Dışarıdaki');
    const next = await owner.api.call('movePage', {
      params: { nodeId: outside.id },
      body: { afterId: inFolder.id },
    });
    expect(next.parentId).toBe(folder.id);
  });

  it('needs edit rights', async () => {
    const p = await page('Salt okunur');
    await expect(
      viewer.api.call('movePage', { params: { nodeId: p.id }, body: { parentId: null } }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
