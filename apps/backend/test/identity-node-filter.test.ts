import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, setupWithOwner, type TestApp } from './helpers';
import { callTool, connect } from './mcp-helpers';

/**
 * Module switches reach Drive (identity module): with wiki or boards off, their pages,
 * boards and drawings leave folder lists, search, recent, favorites, trash, public links
 * and MCP; opening one answers 403 module_disabled. Turning the module on brings them back.
 */
describe('Drive hides nodes of switched-off modules', () => {
  let app: TestApp;
  let owner: Client;
  let spaceId: string;
  let folderId: string;
  const ids: Record<'page' | 'board' | 'drawing' | 'sub' | 'oldPage', string> = {
    page: '',
    board: '',
    drawing: '',
    sub: '',
    oldPage: '',
  };
  let token: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Milvasoft')!.id;
    folderId = (
      await owner.api.call('createFolder', {
        params: { spaceId },
        body: { parentId: null, name: 'Belgeler' },
      })
    ).id;
    ids.sub = (
      await owner.api.call('createFolder', {
        params: { spaceId },
        body: { parentId: folderId, name: 'Alt klasör' },
      })
    ).id;
    ids.page = (
      await owner.api.call('createPage', {
        params: { spaceId },
        body: { parentId: folderId, name: 'Toplantı notları' },
      })
    ).id;
    ids.oldPage = (
      await owner.api.call('createPage', {
        params: { spaceId },
        body: { parentId: folderId, name: 'Eski notlar' },
      })
    ).id;
    ids.board = (
      await owner.api.call('createBoard', {
        params: { spaceId },
        body: { parentId: folderId, name: 'Yol haritası' },
      })
    ).id;
    ids.drawing = (
      await owner.api.call('createDrawing', {
        params: { spaceId },
        body: { parentId: folderId, name: 'Mimari çizim' },
      })
    ).id;
    for (const id of [ids.page, ids.drawing]) {
      await owner.api.call('markNodeOpened', { params: { nodeId: id } });
      await owner.api.call('setFavorite', { params: { nodeId: id }, body: { favorite: true } });
    }
    await owner.api.call('trashNodes', { body: { nodeIds: [ids.oldPage] } });
    token = (await connect(app, owner, { scopes: ['hub:read'] })).access;
  });
  afterAll(() => app.close());

  const setModules = (modules: Record<string, boolean>) =>
    owner.api.call('updateOrg', { body: { settings: { modules } } });

  async function seen() {
    const children = await owner.api.call('listNodes', {
      params: { spaceId },
      query: { parentId: folderId } as never,
    });
    const search = await owner.api.call('searchNodes', { query: { q: 'not' } as never });
    const searchDrawing = await owner.api.call('searchNodes', { query: { q: 'Mimari' } as never });
    const recent = await owner.api.call('listRecent', { query: {} as never });
    const favorites = await owner.api.call('listFavorites');
    const trash = await owner.api.call('listTrash', { params: { spaceId }, query: {} as never });
    const mcpSearch = await callTool(app, token, 'search', { query: 'not' });
    const mcpChildren = await callTool(app, token, 'list_children', {
      space_id: spaceId,
      parent_id: folderId,
    });
    const names = (list: { name: string }[]) => list.map((n) => n.name).sort();
    return {
      children: names(children.items),
      search: names([...search.items, ...searchDrawing.items].map((h) => h.node)),
      recent: names(recent.items),
      favorites: names(favorites.items),
      trash: names(trash.items),
      mcpSearch: names((mcpSearch.data.items as { name: string }[]) ?? []),
      mcpChildren: names((mcpChildren.data.items as { name: string }[]) ?? []),
    };
  }

  it('shows every node type while the modules are on', async () => {
    const s = await seen();
    expect(s.children).toEqual(['Alt klasör', 'Mimari çizim', 'Toplantı notları', 'Yol haritası']);
    expect(s.search).toEqual(['Mimari çizim', 'Toplantı notları']);
    expect(s.recent).toEqual(['Mimari çizim', 'Toplantı notları']);
    expect(s.favorites).toEqual(['Mimari çizim', 'Toplantı notları']);
    expect(s.trash).toEqual(['Eski notlar']);
    expect(s.mcpChildren).toContain('Toplantı notları');
  });

  it('leaves out pages, boards and drawings when wiki and boards are off', async () => {
    await setModules({ wiki: false, boards: false });
    const s = await seen();
    expect(s.children).toEqual(['Alt klasör']);
    expect(s.search).toEqual([]);
    expect(s.recent).toEqual([]);
    expect(s.favorites).toEqual([]);
    expect(s.trash).toEqual([]);
    expect(s.mcpSearch).toEqual([]);
    expect(s.mcpChildren).toEqual(['Alt klasör']);

    await expect(owner.api.call('getNode', { params: { nodeId: ids.page } })).rejects.toMatchObject(
      {
        status: 403,
        code: 'module_disabled',
      },
    );
    const mcpNode = await callTool(app, token, 'get_node', { node_id: ids.board });
    expect(mcpNode.isError).toBe(true);
    expect(mcpNode.data.error).toBe('module_disabled');
    // Folders and files stay.
    await expect(owner.api.call('getNode', { params: { nodeId: ids.sub } })).resolves.toBeTruthy();
  });

  it('hides only the switched-off module', async () => {
    await setModules({ wiki: false, boards: true });
    const s = await seen();
    expect(s.children).toEqual(['Alt klasör', 'Mimari çizim', 'Yol haritası']);
    expect(s.favorites).toEqual(['Mimari çizim']);
  });

  it('brings everything back when the modules are on again', async () => {
    await setModules({ wiki: true, boards: true });
    const s = await seen();
    expect(s.children).toEqual(['Alt klasör', 'Mimari çizim', 'Toplantı notları', 'Yol haritası']);
    expect(s.trash).toEqual(['Eski notlar']);
    await expect(
      owner.api.call('getNode', { params: { nodeId: ids.page } }),
    ).resolves.toMatchObject({
      type: 'page',
    });
  });
});
