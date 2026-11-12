import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, setupWithOwner, uploadFile, type TestApp } from './helpers';

/**
 * H15: pages and boards opened from a public link show their content read-only (instead of a
 * "0 B" file without preview); embedded Drive images come with short-lived URLs.
 */
describe('public link views of pages and boards', () => {
  let app: TestApp;
  let owner: Client;
  let visitor: Client;
  let spaceId: string;
  let otherSpaceId: string;

  const linkOf = async (nodeId: string, body: Record<string, unknown> = {}) => {
    const link = await owner.api.call('createShare', {
      params: { nodeId },
      body: { kind: 'link', ...body },
    });
    return decodeURIComponent(link.url!.split('/s/')[1]!);
  };

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    otherSpaceId = (await owner.api.call('createSpace', { body: { name: 'Finans', color: 's5' } }))
      .id;
    visitor = new Client(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('shows a shared page with its images; files elsewhere stay hidden', async () => {
    const folder = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { parentId: null, name: 'İçe aktarılan ekler' },
    });
    const image = (
      await uploadFile(owner, {
        spaceId,
        parentId: folder.id,
        name: 'şema.png',
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        mime: 'image/png',
      })
    ).node;
    const pdf = (
      await uploadFile(owner, {
        spaceId,
        parentId: folder.id,
        name: 'rapor.pdf',
        content: Buffer.from('%PDF-1.4'),
        mime: 'application/pdf',
      })
    ).node;
    const secret = (
      await uploadFile(owner, {
        spaceId: otherSpaceId,
        name: 'maaş.png',
        content: Buffer.from([1, 2, 3]),
        mime: 'image/png',
      })
    ).node;
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: {
        name: 'Mimari',
        markdown: `![şema](node:${image.id})\n\n[rapor](node:${pdf.id})\n\n![gizli](node:${secret.id})`,
      },
    });
    await owner.api.call('updatePage', { params: { nodeId: page.id }, body: { icon: '🏗️' } });

    const token = await linkOf(page.id);
    const shared = await visitor.api.call('getPublicShare', { params: { token } });
    expect(shared).toMatchObject({ status: 'ok', node: { type: 'page', name: 'Mimari' } });
    const view = await visitor.api.call('getPublicPage', { params: { token }, query: {} });
    expect(view).toMatchObject({ id: page.id, name: 'Mimari', icon: '🏗️', fullWidth: false });
    expect(JSON.stringify(view.doc)).toContain(`node:${image.id}`);
    expect(Object.keys(view.files).sort()).toEqual([image.id, pdf.id].sort());
    expect(view.files[image.id]).toMatch(/^https?:\/\//);
    expect(view.files[secret.id]).toBeUndefined();

    // Without downloads only images resolve.
    const noDownload = await linkOf(page.id, { allowDownload: false });
    const limited = await visitor.api.call('getPublicPage', {
      params: { token: noDownload },
      query: {},
    });
    expect(Object.keys(limited.files)).toEqual([image.id]);
  });

  it('opens a page inside a shared folder, not one outside it', async () => {
    const folder = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { parentId: null, name: 'Paylaşılan' },
    });
    const inside = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'İçeride', parentId: folder.id, markdown: 'Merhaba' },
    });
    const outside = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Dışarıda' },
    });
    const token = await linkOf(folder.id);
    const view = await visitor.api.call('getPublicPage', {
      params: { token },
      query: { nodeId: inside.id },
    });
    expect(view.name).toBe('İçeride');
    await expect(
      visitor.api.call('getPublicPage', { params: { token }, query: { nodeId: outside.id } }),
    ).rejects.toMatchObject({ status: 404 });
    // The folder itself is not a page.
    await expect(
      visitor.api.call('getPublicPage', { params: { token }, query: {} }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('asks for the password grant on password links', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Kilitli' },
    });
    const token = await linkOf(page.id, { password: 'gizli-1234' });
    await expect(
      visitor.api.call('getPublicPage', { params: { token }, query: {} }),
    ).rejects.toMatchObject({ code: 'share_password_required' });
    const { grant } = await visitor.api.call('unlockPublicShare', {
      params: { token },
      body: { password: 'gizli-1234' },
    });
    const view = await visitor.api.call('getPublicPage', { params: { token }, query: { grant } });
    expect(view.name).toBe('Kilitli');
  });

  it('shows a shared board read-only, without people', async () => {
    const board = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Yol haritası', template: 'empty' },
    });
    const { columns } = await owner.api.call('getBoard', { params: { boardId: board.id } });
    await owner.api.call('createBoardCard', {
      params: { boardId: board.id },
      body: { columnId: columns[0]!.id, title: 'Portal', description: 'gizli ayrıntı' },
    });
    const token = await linkOf(board.id);
    const view = await visitor.api.call('getPublicBoard', { params: { token }, query: {} });
    expect(view.name).toBe('Yol haritası');
    expect(view.columns.map((c) => c.id)).toEqual(columns.map((c) => c.id));
    expect(view.cards).toEqual([
      expect.objectContaining({ title: 'Portal', columnId: columns[0]!.id, number: 1 }),
    ]);
    expect(JSON.stringify(view)).not.toContain('gizli ayrıntı');
    expect(view.cards[0]).not.toHaveProperty('assignees');
    await expect(
      visitor.api.call('getPublicPage', { params: { token }, query: {} }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});
