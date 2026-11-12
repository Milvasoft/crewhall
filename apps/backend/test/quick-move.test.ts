import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WsServerEvent } from '@crewhall/shared';
import { userTopic } from '../src/realtime/bus';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/** Moving a home card to another space's home (request of 2026-11-05). */
describe('moving a card between homes', () => {
  let app: TestApp;
  let owner: Client;
  let ownerId: string;
  let mert: Awaited<ReturnType<typeof join>>;
  let mertHome: string;
  let source: string;
  let target: string;
  let viewerOnly: string;
  let hidden: string;
  let targetSpaceId: string;
  let sourceSpaceId: string;

  const spaceSurface = async (client: Client, spaceId: string) => {
    const { items } = await client.api.call('listSurfaces');
    return items.find((s) => s.owner.type === 'space' && s.owner.spaceId === spaceId)!.id;
  };
  const note = (client: Client, surfaceId: string, text = 'Not') =>
    client.api.call('createCard', {
      params: { surfaceId },
      body: { type: 'note', config: { text } },
    });
  const titles = async (client: Client, surfaceId: string) =>
    (await client.api.call('getSurface', { params: { surfaceId } })).cards.map((c) => c.id);

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner, ownerId } = await setupWithOwner(app));
    mert = await join(app, owner, 'mert@milvasoft.com', 'member');
    const member = (role: 'editor' | 'viewer') => [{ userId: mert.me.user.id, role }];
    const space = (name: string, members: { userId: string; role: 'editor' | 'viewer' }[]) =>
      owner.api.call('createSpace', { body: { name, color: 's2', members } });
    const a = await space('Kaynak', member('editor'));
    const b = await space('Hedef', member('editor'));
    const c = await space('Yalnız izleyen', member('viewer'));
    const d = await space('Görünmeyen', []);
    sourceSpaceId = a.id;
    targetSpaceId = b.id;
    mertHome = (await mert.person.api.call('listSurfaces')).items[0]!.id;
    source = await spaceSurface(mert.person, a.id);
    target = await spaceSurface(mert.person, b.id);
    viewerOnly = await spaceSurface(mert.person, c.id);
    hidden = await spaceSurface(owner, d.id);
  });
  afterAll(async () => {
    await app.close();
  });

  it('lists only the surfaces the caller can write to', async () => {
    const card = await note(mert.person, source);
    const { items } = await mert.person.api.call('listCardMoveTargets', {
      params: { cardId: card.id },
    });
    const ids = items.map((t) => t.surface.id);
    expect(ids).toContain(mertHome);
    expect(ids).toContain(target);
    expect(ids).not.toContain(source);
    expect(ids).not.toContain(viewerOnly);
    expect(ids).not.toContain(hidden);
    expect(items.every((t) => t.cannotOpen === 0)).toBe(true);
  });

  it('moves a card, tells both homes and puts it back with its layout', async () => {
    const card = await note(mert.person, source, 'Taşınacak');
    const events: WsServerEvent[] = [];
    const stop = app.deps.bus.subscribe(userTopic(ownerId), (e) => events.push(e));
    const moved = await mert.person.api.call('moveCard', {
      params: { cardId: card.id },
      body: { surfaceId: target },
    });
    stop();
    expect(moved.surfaceId).toBe(target);
    expect(moved.layout.x).toBe(0);
    expect(moved.config).toMatchObject({ text: 'Taşınacak' });
    expect(await titles(mert.person, source)).not.toContain(card.id);
    expect(await titles(mert.person, target)).toContain(card.id);
    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'surface.changed', surfaceId: source },
        { type: 'surface.changed', surfaceId: target },
      ]),
    );

    const back = await mert.person.api.call('moveCard', {
      params: { cardId: card.id },
      body: { surfaceId: source, layout: { x: 3, y: 7, w: 3, h: 2 } },
    });
    expect(back.surfaceId).toBe(source);
    expect(back.layout).toEqual({ x: 3, y: 7, w: 3, h: 2 });
  });

  it('starts over on the phone: mobile place and settings stay behind', async () => {
    const card = await note(mert.person, source);
    const { layoutRev } = await mert.person.api.call('getSurface', {
      params: { surfaceId: source },
    });
    await mert.person.api.call('updateSurfaceLayout', {
      params: { surfaceId: source },
      body: { layoutRev, mobileOrder: [card.id], mobile: [{ cardId: card.id, hidden: true }] },
    });
    const moved = await mert.person.api.call('moveCard', {
      params: { cardId: card.id },
      body: { surfaceId: target },
    });
    expect(moved).toMatchObject({ mobileOrder: null, mobileHidden: false });
  });

  it('refuses a target or source the caller cannot write to', async () => {
    const card = await note(mert.person, source);
    await expect(
      mert.person.api.call('moveCard', {
        params: { cardId: card.id },
        body: { surfaceId: viewerOnly },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // A home the caller cannot see does not exist for them.
    await expect(
      mert.person.api.call('moveCard', {
        params: { cardId: card.id },
        body: { surfaceId: hidden },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      mert.person.api.call('moveCard', {
        params: { cardId: card.id },
        body: { surfaceId: source },
      }),
    ).rejects.toMatchObject({ code: 'invalid_target' });
    expect(await titles(mert.person, source)).toContain(card.id);

    // The owner's card on the home Mert only views: he can neither list nor move it.
    const viewOnly = await note(owner, viewerOnly);
    await expect(
      mert.person.api.call('moveCard', {
        params: { cardId: viewOnly.id },
        body: { surfaceId: target },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      mert.person.api.call('listCardMoveTargets', { params: { cardId: viewOnly.id } }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // An archived space takes no cards.
    const old = await owner.api.call('createSpace', {
      body: { name: 'Arşiv', color: 's3', members: [{ userId: mert.me.user.id, role: 'editor' }] },
    });
    const oldHome = await spaceSurface(mert.person, old.id);
    await owner.api.call('archiveSpace', { params: { spaceId: old.id } });
    await expect(
      mert.person.api.call('moveCard', {
        params: { cardId: card.id },
        body: { surfaceId: oldHome },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('keeps vault cards away from shared homes', async () => {
    const ids = {
      vaultId: '0190f0a0-0000-7000-8000-000000000001',
      itemId: '0190f0a0-0000-7000-8000-000000000002',
    };
    const mine = await mert.person.api.call('createCard', {
      params: { surfaceId: mertHome },
      body: { type: 'vault_item', config: ids },
    });
    const list = await mert.person.api.call('listCardMoveTargets', {
      params: { cardId: mine.id },
    });
    expect(list.items).toEqual([]);
    await expect(
      mert.person.api.call('moveCard', {
        params: { cardId: mine.id },
        body: { surfaceId: target },
      }),
    ).rejects.toMatchObject({ code: 'quick_card_not_movable' });
    // A pin would carry the same ids there.
    await expect(
      mert.person.api.call('pinCard', { params: { cardId: mine.id }, body: { surfaceId: target } }),
    ).rejects.toMatchObject({ code: 'quick_card_not_movable' });

    // From a shared home it may only come to the caller's own.
    const shared = await mert.person.api.call('createCard', {
      params: { surfaceId: source },
      body: { type: 'vault_item', config: ids },
    });
    const fromShared = await mert.person.api.call('listCardMoveTargets', {
      params: { cardId: shared.id },
    });
    expect(fromShared.items.map((t) => t.surface.id)).toEqual([mertHome]);
    const moved = await mert.person.api.call('moveCard', {
      params: { cardId: shared.id },
      body: { surfaceId: mertHome },
    });
    expect(moved.surfaceId).toBe(mertHome);
  });

  it('warns who cannot open the linked content, and leaves that content alone', async () => {
    // A page in Kaynak: Selin is in Hedef but not in Kaynak, Mert in both.
    const selin = await join(app, owner, 'selin@milvasoft.com', 'member');
    await owner.api.call('addSpaceMember', {
      params: { spaceId: targetSpaceId },
      body: { userId: selin.me.user.id, role: 'viewer' },
    });
    const file = await mert.person.api.call('createFolder', {
      params: { spaceId: sourceSpaceId },
      body: { parentId: null, name: 'Sözleşmeler' },
    });
    const card = await mert.person.api.call('createCard', {
      params: { surfaceId: source },
      body: { type: 'node', config: { nodeId: file.id } },
    });
    const { items } = await mert.person.api.call('listCardMoveTargets', {
      params: { cardId: card.id },
    });
    const of = (id: string) => items.find((t) => t.surface.id === id)!;
    expect(of(mertHome).cannotOpen).toBe(0);
    // Selin: the owner and Mert are in both spaces.
    expect(of(target).cannotOpen).toBe(1);

    await mert.person.api.call('moveCard', {
      params: { cardId: card.id },
      body: { surfaceId: target },
    });
    // The folder stays where it was; Selin sees the card locked and learns nothing of it.
    const node = await mert.person.api.call('getNode', { params: { nodeId: file.id } });
    expect(node.spaceId).toBe(sourceSpaceId);
    const seen = await selin.person.api.call('getSurface', { params: { surfaceId: target } });
    expect(seen.cards.find((c) => c.id === card.id)?.node).toBeNull();
    await expect(
      selin.person.api.call('getNode', { params: { nodeId: file.id } }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
