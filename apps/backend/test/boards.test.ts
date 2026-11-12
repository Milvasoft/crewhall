import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { auditLogs, blobs, boardCards, drawings } from '@crewhall/db';
import type { BoardDetail, BoardsWsEvent, WsServerEvent } from '@crewhall/shared';
import { userTopic } from '../src/realtime/bus';
import { onBoardsDelivery, type BoardNotification } from '../src/services/boards/integrations';
import { sweepBoards } from '../src/services/boards/sweep';
import { renderDrawingThumbnail, sceneSvg } from '../src/services/boards/thumbnail';
import { createLogger } from '../src/logger';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

const rect = (id: string, version: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'rectangle',
  version,
  versionNonce: version * 7,
  isDeleted: false,
  index: `a${id.length}`,
  x: 10,
  y: 20,
  width: 200,
  height: 120,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: '#fbc419',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 100,
  ...extra,
});

describe('boards', () => {
  let app: TestApp;
  let owner: Client;
  let ownerId: string;
  let spaceId: string;
  let mert: Awaited<ReturnType<typeof join>>;
  let selin: Awaited<ReturnType<typeof join>>;
  let outsider: Awaited<ReturnType<typeof join>>;
  const notes: BoardNotification[] = [];
  const events: BoardsWsEvent[] = [];
  let stop: () => void;

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    ownerId = setup.ownerId;
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    const altyapi = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!;
    mert = await join(app, owner, 'mert@milvasoft.com', 'member');
    selin = await join(app, owner, 'selin@milvasoft.com', 'member');
    outsider = await join(app, owner, 'can@milvasoft.com', 'member');
    // Default spaces make everyone a member; Can only stays in Altyapı.
    await owner.api.call('removeSpaceMember', {
      params: { spaceId, userId: outsider.me.user.id },
    });
    void altyapi;
    // Invited people join default spaces as viewers; Mert edits.
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId: mert.me.user.id },
      body: { role: 'editor' },
    });
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId: selin.me.user.id },
      body: { role: 'viewer' },
    });
    stop = onBoardsDelivery({
      notify: (n) => notes.push(...n),
      publish: (e) => events.push(e),
    });
  });
  afterAll(async () => {
    stop();
    await app.close();
  });

  const board = (id: string) => owner.api.call('getBoard', { params: { boardId: id } });
  const order = (d: BoardDetail, columnId: string) =>
    d.cards.filter((c) => c.columnId === columnId).map((c) => c.title);

  it('creates a board from a template: columns, WIP, done column, labels, key', async () => {
    const created = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Milvaion Yol Haritası', template: 'roadmap', key: 'MLV' },
    });
    expect(created.settings).toMatchObject({ key: 'MLV', template: 'roadmap', cardChats: true });
    expect(created.settings.labels.map((l) => l.name)).toEqual([
      'Backend',
      'Altyapı',
      'UI',
      'Güvenlik',
      'Entegrasyon',
    ]);
    const detail = await board(created.id);
    expect(detail.columns.map((c) => [c.name, c.wipLimit, c.isDone])).toEqual([
      ['Fikir', null, false],
      ['Sırada', null, false],
      ['Yapılıyor', 3, false],
      ['İncelemede', 4, false],
      ['Bitti', null, true],
    ]);
    expect(detail.people.map((p) => p.email).sort()).toEqual(
      ['bugra@milvasoft.com', 'mert@milvasoft.com', 'selin@milvasoft.com'].sort(),
    );
    // It is a node of the tree: Drive lists it.
    const nodes = await owner.api.call('listNodes', { params: { spaceId }, query: {} });
    expect(nodes.items.find((n) => n.id === created.id)?.type).toBe('board');
    const [log] = await app.deps.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, created.id));
    expect(log?.action).toBe('board.create');
    await expect(
      owner.api.call('createBoard', {
        params: { spaceId },
        body: { name: 'Milvaion Yol Haritası' },
      }),
    ).rejects.toMatchObject({ code: 'node_name_taken' });
  });

  it('orders cards with server-side fractional keys and moves them between neighbours', async () => {
    const b = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Sıra', template: 'empty', key: 'SRA' },
    });
    const [todo, doing, done] = (await board(b.id)).columns;
    const add = (title: string, extra: Record<string, unknown> = {}) =>
      owner.api.call('createBoardCard', {
        params: { boardId: b.id },
        body: { columnId: todo!.id, title, ...extra },
      });
    const c1 = await add('Bir');
    const c2 = await add('İki');
    const c3 = await add('Üç');
    const top = await add('Sıfır', { top: true });
    expect([c1.number, c2.number, c3.number, top.number]).toEqual([1, 2, 3, 4]);
    expect(order(await board(b.id), todo!.id)).toEqual(['Sıfır', 'Bir', 'İki', 'Üç']);

    // Üç between Bir and İki.
    await owner.api.call('moveBoardCard', {
      params: { cardId: c3.id },
      body: { columnId: todo!.id, afterId: c1.id, beforeId: c2.id },
    });
    expect(order(await board(b.id), todo!.id)).toEqual(['Sıfır', 'Bir', 'Üç', 'İki']);
    // To the top with only beforeId.
    await owner.api.call('moveBoardCard', {
      params: { cardId: c2.id },
      body: { columnId: todo!.id, beforeId: top.id },
    });
    expect(order(await board(b.id), todo!.id)).toEqual(['İki', 'Sıfır', 'Bir', 'Üç']);

    // Many moves into the same gap keep keys strictly ordered.
    let after = c1.id;
    for (let i = 0; i < 30; i++) {
      const c = await add(`n${i}`);
      await owner.api.call('moveBoardCard', {
        params: { cardId: c.id },
        body: { columnId: todo!.id, afterId: after, beforeId: c3.id },
      });
      after = c.id;
    }
    const titles = order(await board(b.id), todo!.id);
    expect(titles.slice(0, 3)).toEqual(['İki', 'Sıfır', 'Bir']);
    expect(titles.at(-1)).toBe('Üç');
    expect(titles.slice(3, 33)).toEqual(Array.from({ length: 30 }, (_, i) => `n${i}`));

    // Into the done column: done_at set, a moved line in the activity.
    const moved = await owner.api.call('moveBoardCard', {
      params: { cardId: c1.id },
      body: { columnId: done!.id },
    });
    expect(moved.card.doneAt).not.toBeNull();
    expect(moved.wip).toEqual({ count: 1, limit: null, exceeded: false });
    const activity = await owner.api.call('listBoardCardActivity', {
      params: { cardId: c1.id },
      query: {},
    });
    expect(activity.items.map((x) => x.kind)).toEqual(['created', 'moved']);
    expect(activity.items[1]!.data).toMatchObject({ from: 'Yapılacak', to: 'Bitti' });
    // Back out: done_at clears.
    const back = await owner.api.call('moveBoardCard', {
      params: { cardId: c1.id },
      body: { columnId: doing!.id },
    });
    expect(back.card.doneAt).toBeNull();
    // Unknown neighbour or column of another board.
    await expect(
      owner.api.call('moveBoardCard', {
        params: { cardId: c1.id },
        body: { columnId: doing!.id, afterId: c2.id },
      }),
    ).rejects.toMatchObject({ code: 'invalid_target' });
  });

  it('warns but allows going over a WIP limit; rev changes on every write', async () => {
    const b = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'WIP', template: 'bugs' },
    });
    const d = await board(b.id);
    const fixing = d.columns[2]!;
    expect(fixing.wipLimit).toBe(2);
    const rev0 = (await owner.api.call('getBoardRev', { params: { boardId: b.id } })).rev;
    const ids: string[] = [];
    for (const t of ['a', 'b', 'c']) {
      ids.push(
        (
          await owner.api.call('createBoardCard', {
            params: { boardId: b.id },
            body: { columnId: d.columns[0]!.id, title: t },
          })
        ).id,
      );
    }
    const results = [];
    for (const id of ids) {
      results.push(
        await owner.api.call('moveBoardCard', {
          params: { cardId: id },
          body: { columnId: fixing.id },
        }),
      );
    }
    expect(results.map((r) => r.wip)).toEqual([
      { count: 1, limit: 2, exceeded: false },
      { count: 2, limit: 2, exceeded: false },
      { count: 3, limit: 2, exceeded: true },
    ]);
    const rev1 = (await owner.api.call('getBoardRev', { params: { boardId: b.id } })).rev;
    expect(rev1).toBe(rev0 + 6);
    expect(events.filter((e) => e.type === 'board.changed' && e.boardId === b.id).at(-1)).toEqual({
      type: 'board.changed',
      boardId: b.id,
      rev: rev1,
    });
  });

  it('assigns people who can see the board and notifies them; assigned-to-me lists open cards', async () => {
    const b = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Atama', template: 'empty', key: 'ATM' },
    });
    const [todo, , done] = (await board(b.id)).columns;
    const card = await owner.api.call('createBoardCard', {
      params: { boardId: b.id },
      body: {
        columnId: todo!.id,
        title: 'SSO ile giriş (OIDC)',
        assigneeIds: [mert.me.user.id],
        dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      },
    });
    expect(card.assignees.map((u) => u.email)).toEqual(['mert@milvasoft.com']);
    expect(notes.at(-1)).toMatchObject({
      type: 'boards.assigned',
      userId: mert.me.user.id,
      actorId: ownerId,
      url: `/b/${b.id}/ATM-1`,
      data: { key: 'ATM-1', title: 'SSO ile giriş (OIDC)', boardName: 'Atama' },
    });

    // Someone outside the space cannot be assigned.
    await expect(
      owner.api.call('setBoardCardAssignees', {
        params: { cardId: card.id },
        body: { userIds: [outsider.me.user.id] },
      }),
    ).rejects.toMatchObject({ status: 422, code: 'board_assignee_not_member' });

    const before = notes.length;
    const updated = await owner.api.call('setBoardCardAssignees', {
      params: { cardId: card.id },
      body: { userIds: [mert.me.user.id, ownerId] },
    });
    expect(updated.assignees).toHaveLength(2);
    // Assigning yourself does not notify you; Mert was already there.
    expect(notes.length).toBe(before);

    const second = await owner.api.call('createBoardCard', {
      params: { boardId: b.id },
      body: { columnId: todo!.id, title: 'Uzak iş', assigneeIds: [mert.me.user.id] },
    });
    const finished = await owner.api.call('createBoardCard', {
      params: { boardId: b.id },
      body: { columnId: done!.id, title: 'Biten', assigneeIds: [mert.me.user.id] },
    });
    expect(finished.doneAt).not.toBeNull();

    const mine = await mert.person.api.call('listMyBoardCards', { query: {} });
    expect(mine.items.map((c) => c.title).sort()).toEqual(['SSO ile giriş (OIDC)', 'Uzak iş']);
    expect(mine.items[0]).toMatchObject({
      title: 'SSO ile giriş (OIDC)', // due date first
      board: { id: b.id, key: 'ATM', name: 'Atama' },
      column: { id: todo!.id, isDone: false },
    });
    const due = await mert.person.api.call('listMyBoardCards', { query: { scope: 'due' } });
    expect(due.items.map((c) => c.id)).toEqual([card.id]);
    void second;

    // Archived cards drop out; a removed member no longer sees the board's cards.
    await owner.api.call('updateBoardCard', {
      params: { cardId: second.id },
      body: { archived: true },
    });
    expect(
      (await mert.person.api.call('listMyBoardCards', { query: {} })).items.map((c) => c.title),
    ).toEqual(['SSO ile giriş (OIDC)']);
    const archived = await owner.api.call('listArchivedBoardCards', {
      params: { boardId: b.id },
      query: {},
    });
    expect(archived.items.map((c) => c.id)).toEqual([second.id]);
  });

  it('viewers read and comment but cannot change cards; comments notify followers', async () => {
    const b = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Yorum', template: 'empty', key: 'YRM' },
    });
    const [todo] = (await board(b.id)).columns;
    const card = await owner.api.call('createBoardCard', {
      params: { boardId: b.id },
      body: { columnId: todo!.id, title: 'Kart', assigneeIds: [mert.me.user.id] },
    });
    await expect(
      selin.person.api.call('createBoardCard', {
        params: { boardId: b.id },
        body: { columnId: todo!.id, title: 'Hayır' },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      selin.person.api.call('moveBoardCard', {
        params: { cardId: card.id },
        body: { columnId: todo!.id },
      }),
    ).rejects.toMatchObject({ status: 403 });
    // Can is not in the space: the board does not exist for them.
    await expect(
      outsider.person.api.call('getBoard', { params: { boardId: b.id } }),
    ).rejects.toMatchObject({ status: 404 });

    const before = notes.length;
    const comment = await selin.person.api.call('addBoardCardComment', {
      params: { cardId: card.id },
      body: { text: 'Giriş ekranında yalnızca "Crewhall ile giriş" kalsın.' },
    });
    expect(comment).toMatchObject({ kind: 'comment', actor: { email: 'selin@milvasoft.com' } });
    const sent = notes.slice(before);
    expect(sent.map((n) => [n.type, n.userId]).sort()).toEqual(
      [
        ['boards.comment', ownerId],
        ['boards.comment', mert.me.user.id],
      ].sort(),
    );
    const detail = await owner.api.call('getBoardCard', { params: { cardId: card.id } });
    expect(detail.commentCount).toBe(1);
    expect(detail.followerIds.sort()).toEqual([ownerId, mert.me.user.id, selin.me.user.id].sort());

    // Unfollowing stops comment notifications.
    await mert.person.api.call('setBoardCardFollowing', {
      params: { cardId: card.id },
      body: { following: false },
    });
    const mark = notes.length;
    await owner.api.call('addBoardCardComment', {
      params: { cardId: card.id },
      body: { text: 'Tamam' },
    });
    expect(notes.slice(mark).map((n) => n.userId)).toEqual([selin.me.user.id]);

    // Own comment only (or a space admin).
    await expect(
      mert.person.api.call('deleteBoardCardComment', { params: { activityId: comment.id } }),
    ).rejects.toMatchObject({ status: 403 });
    await selin.person.api.call('deleteBoardCardComment', { params: { activityId: comment.id } });
    expect(
      (await owner.api.call('getBoardCard', { params: { cardId: card.id } })).commentCount,
    ).toBe(1);

    // The card conversation (chat type `card`) opens once; followers are its members.
    const opened = await owner.api.call('openBoardCardConversation', {
      params: { cardId: card.id },
    });
    const again = await mert.person.api.call('openBoardCardConversation', {
      params: { cardId: card.id },
    });
    expect(again.conversationId).toBe(opened.conversationId);
    const conv = await owner.api.call('getConversation', {
      params: { conversationId: opened.conversationId },
    });
    expect(conv.type).toBe('card');
    const members = await owner.api.call('listConversationMembers', {
      params: { conversationId: opened.conversationId },
    });
    expect(members.items.map((m) => m.user.id).sort()).toEqual([ownerId, selin.me.user.id].sort());
    // Following again joins the conversation.
    await mert.person.api.call('setBoardCardFollowing', {
      params: { cardId: card.id },
      body: { following: true },
    });
    const after = await mert.person.api.call('getConversation', {
      params: { conversationId: opened.conversationId },
    });
    expect(after.id).toBe(opened.conversationId);
    // Assignment and comments are real notifications in Mert's centre.
    const inbox = await mert.person.api.call('listNotifications', { query: {} });
    expect(inbox.items.map((n) => n.type)).toEqual(expect.arrayContaining(['boards.assigned']));
    expect(inbox.items.find((n) => n.type === 'boards.assigned')).toMatchObject({
      source: 'boards',
      target: { type: 'card', id: card.id },
      url: `/b/${b.id}/YRM-1`,
    });
  });

  it('description, labels, checklist and the card address by number', async () => {
    const b = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Detay', template: 'roadmap', key: 'DTY' },
    });
    const d = await board(b.id);
    const card = await owner.api.call('createBoardCard', {
      params: { boardId: b.id },
      body: { columnId: d.columns[0]!.id, title: 'Kart', labels: ['l1'] },
    });
    await expect(
      owner.api.call('updateBoardCard', {
        params: { cardId: card.id },
        body: { labels: ['nope'] },
      }),
    ).rejects.toMatchObject({ code: 'board_label_unknown' });
    const updated = await owner.api.call('updateBoardCard', {
      params: { cardId: card.id },
      body: {
        description: 'Akış: Authorization Code + PKCE.\n- Rol eşleme\n- Back-channel logout',
        labels: ['l1', 'l4'],
        checklistItems: [
          { id: 'a', text: 'İstemci', done: true, assigneeId: null },
          { id: 'b', text: 'Ara katman', done: false, assigneeId: null },
        ],
      },
    });
    expect(updated.description).toBe(
      'Akış: Authorization Code + PKCE.\n• Rol eşleme\n• Back-channel logout',
    );
    expect(updated.checklist).toEqual({ done: 1, total: 2 });
    const [row] = await app.deps.db.select().from(boardCards).where(eq(boardCards.id, card.id));
    expect(row?.descYdoc?.length).toBeGreaterThan(10);
    expect(row?.descText).toContain('PKCE');

    const byNumber = await owner.api.call('getBoardCardByNumber', {
      params: { boardId: b.id, number: 'DTY-1' },
    });
    expect(byNumber.id).toBe(card.id);
    await expect(
      owner.api.call('getBoardCardByNumber', { params: { boardId: b.id, number: 'x' } }),
    ).rejects.toMatchObject({ status: 404 });

    // Removing a label from the board strips it from cards.
    await owner.api.call('updateBoard', {
      params: { boardId: b.id },
      body: { labels: d.board.settings.labels.filter((l) => l.id !== 'l4') },
    });
    expect((await owner.api.call('getBoardCard', { params: { cardId: card.id } })).labels).toEqual([
      'l1',
    ]);
    // Board settings are for admins (or the creator): Mert (editor) cannot.
    await expect(
      mert.person.api.call('updateBoard', { params: { boardId: b.id }, body: { key: 'XYZ' } }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('a column reorder reaches other members over the WebSocket bus after commit', async () => {
    const b = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Canlı sıra', template: 'empty' },
    });
    const [first, , last] = (await board(b.id)).columns;
    const got: { event: WsServerEvent; committedRev: Promise<number> }[] = [];
    const outsiderGot: WsServerEvent[] = [];
    const off = [
      app.deps.bus.subscribe(userTopic(mert.me.user.id), (event) => {
        // What a client refetching right away would see.
        if (event.type === 'board.changed') {
          got.push({
            event,
            committedRev: mert.person.api
              .call('getBoardRev', { params: { boardId: b.id } })
              .then((r) => r.rev),
          });
        }
      }),
      app.deps.bus.subscribe(userTopic(outsider.me.user.id), (e) => outsiderGot.push(e)),
    ];
    try {
      await owner.api.call('moveBoardColumn', {
        params: { columnId: last!.id },
        body: { beforeId: first!.id },
      });
      const mine = got.filter((g) => g.event.type === 'board.changed' && g.event.boardId === b.id);
      expect(mine).toHaveLength(1);
      const e = mine[0]!.event as Extract<WsServerEvent, { type: 'board.changed' }>;
      expect(await mine[0]!.committedRev).toBe(e.rev);
      expect(outsiderGot.filter((x) => x.type === 'board.changed')).toEqual([]);
    } finally {
      for (const o of off) o();
    }
  });

  it('columns: add, reorder, delete with a move target; never the last one', async () => {
    const b = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Sütunlar', template: 'empty' },
    });
    const [a, m, z] = (await board(b.id)).columns;
    const added = await owner.api.call('createBoardColumn', {
      params: { boardId: b.id },
      body: { name: 'Test', afterId: m!.id, wipLimit: 2 },
    });
    await owner.api.call('moveBoardColumn', {
      params: { columnId: z!.id },
      body: { beforeId: a!.id },
    });
    expect((await board(b.id)).columns.map((c) => c.name)).toEqual([
      'Bitti',
      'Yapılacak',
      'Yapılıyor',
      'Test',
    ]);
    const c = await owner.api.call('createBoardCard', {
      params: { boardId: b.id },
      body: { columnId: added.id, title: 'Taşınacak' },
    });
    await expect(
      owner.api.call('deleteBoardColumn', { params: { columnId: added.id }, query: {} }),
    ).rejects.toMatchObject({ code: 'board_column_not_empty' });
    await owner.api.call('deleteBoardColumn', {
      params: { columnId: added.id },
      query: { moveTo: z!.id },
    });
    const moved = await owner.api.call('getBoardCard', { params: { cardId: c.id } });
    expect(moved.columnId).toBe(z!.id);
    expect(moved.doneAt).not.toBeNull();
    for (const col of [a!, m!]) {
      await owner.api.call('deleteBoardColumn', { params: { columnId: col.id }, query: {} });
    }
    await expect(
      owner.api.call('deleteBoardColumn', {
        params: { columnId: z!.id },
        query: { moveTo: z!.id },
      }),
    ).rejects.toMatchObject({ code: 'board_last_column' });
  });

  it('bulk moves, assigns and labels; delete and restore a card', async () => {
    const b = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Toplu', template: 'roadmap' },
    });
    const d = await board(b.id);
    const ids = [];
    for (const t of ['x', 'y', 'z']) {
      ids.push(
        (
          await owner.api.call('createBoardCard', {
            params: { boardId: b.id },
            body: { columnId: d.columns[0]!.id, title: t },
          })
        ).id,
      );
    }
    const res = await owner.api.call('bulkUpdateBoardCards', {
      params: { boardId: b.id },
      body: {
        cardIds: ids,
        columnId: d.columns[1]!.id,
        addAssigneeIds: [mert.me.user.id],
        addLabels: ['l2'],
      },
    });
    expect(res.updated).toBe(3);
    const after = await board(b.id);
    expect(order(after, d.columns[1]!.id)).toEqual(['x', 'y', 'z']);
    expect(after.cards.every((c) => c.labels.includes('l2') && c.assignees.length === 1)).toBe(
      true,
    );

    await owner.api.call('deleteBoardCard', { params: { cardId: ids[0]! } });
    expect((await board(b.id)).cards).toHaveLength(2);
    await expect(
      owner.api.call('getBoardCard', { params: { cardId: ids[0]! } }),
    ).rejects.toMatchObject({ status: 404 });
    await owner.api.call('restoreBoardCard', { params: { cardId: ids[0]! } });
    expect((await board(b.id)).cards).toHaveLength(3);
  });

  it('quick access "Bana atananlar" card keeps only its view settings', async () => {
    const [mine] = (await mert.person.api.call('listSurfaces')).items;
    const card = await mert.person.api.call('createCard', {
      params: { surfaceId: mine!.id },
      body: { type: 'board_assigned', config: { scope: 'due' } },
    });
    expect(card).toMatchObject({
      type: 'board_assigned',
      config: { scope: 'due', spaceId: null, limit: 6 },
      layout: { w: 4, h: 3 },
    });
    const updated = await mert.person.api.call('updateCard', {
      params: { cardId: card.id },
      body: { config: { scope: 'assigned', spaceId, limit: 10 } },
    });
    expect(updated.config).toEqual({ scope: 'assigned', spaceId, limit: 10 });
    await expect(
      mert.person.api.call('updateCard', {
        params: { cardId: card.id },
        body: { config: { scope: 'assigned', spaceId: null, limit: 99 } },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('sweep: due-soon notifications once, done cards archived after the board setting', async () => {
    const b = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Süpürge', template: 'empty', key: 'SPR' },
    });
    const [todo, , done] = (await board(b.id)).columns;
    const soon = await owner.api.call('createBoardCard', {
      params: { boardId: b.id },
      body: {
        columnId: todo!.id,
        title: 'Yarın',
        assigneeIds: [mert.me.user.id],
        dueAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      },
    });
    const old = await owner.api.call('createBoardCard', {
      params: { boardId: b.id },
      body: { columnId: done!.id, title: 'Eski' },
    });
    await app.deps.db
      .update(boardCards)
      .set({ doneAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(boardCards.id, old.id));
    const mark = notes.length;
    const deps = { ...app.deps, logger: createLogger('silent') };
    await sweepBoards(deps);
    expect(notes.slice(mark).map((n) => [n.type, n.userId, n.cardId])).toEqual([
      ['boards.due_soon', mert.me.user.id, soon.id],
    ]);
    await sweepBoards(deps);
    expect(notes.length).toBe(mark + 1);
    const archived = await owner.api.call('getBoardCard', { params: { cardId: old.id } });
    expect(archived.archivedAt).not.toBeNull();
  });
});

describe('drawings', () => {
  let app: TestApp;
  let owner: Client;
  let spaceId: string;
  let viewer: Awaited<ReturnType<typeof join>>;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    viewer = await join(app, owner, 'burak@milvasoft.com', 'member');
    await owner.api.call('updateSpaceMember', {
      params: { spaceId, userId: viewer.me.user.id },
      body: { role: 'viewer' },
    });
  });
  afterAll(() => app.close());

  it('creates drawings with free names and merges scene writes per element version', async () => {
    const d1 = await owner.api.call('createDrawing', {
      params: { spaceId },
      body: { name: 'Hub mimarisi' },
    });
    const d2 = await owner.api.call('createDrawing', {
      params: { spaceId },
      body: { name: 'Hub mimarisi' },
    });
    expect(d2.name).toBe('Hub mimarisi (2)');
    expect(d1).toMatchObject({ sceneRev: 0, elementCount: 0, thumbnail: { ready: false } });

    const s1 = await owner.api.call('saveDrawingScene', {
      params: { nodeId: d1.id },
      body: { elements: [rect('api', 3), rect('db', 1, { x: 400 })] },
    });
    expect(s1.sceneRev).toBe(1);
    // An older version of `api` loses; a newer `db` wins; unknown keys survive.
    const s2 = await owner.api.call('saveDrawingScene', {
      params: { nodeId: d1.id },
      body: {
        elements: [
          rect('api', 2, { x: 999 }),
          rect('db', 2, { x: 500, customData: { link: 'x' } }),
        ],
      },
    });
    const byId = new Map(s2.elements.map((e) => [e.id, e]));
    expect(byId.get('api')).toMatchObject({ x: 10, version: 3 });
    expect(byId.get('db')).toMatchObject({ x: 500, customData: { link: 'x' } });
    // Deleted elements are tombstones: gone from the scene, kept in the document.
    await owner.api.call('saveDrawingScene', {
      params: { nodeId: d1.id },
      body: { elements: [rect('db', 3, { isDeleted: true })] },
    });
    const scene = await owner.api.call('getDrawingScene', { params: { nodeId: d1.id } });
    expect(scene.elements.map((e) => e.id)).toEqual(['api']);
    expect((await owner.api.call('getDrawing', { params: { nodeId: d1.id } })).elementCount).toBe(
      1,
    );

    await expect(
      viewer.person.api.call('saveDrawingScene', {
        params: { nodeId: d1.id },
        body: { elements: [rect('x', 1)] },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('renders a thumbnail in the worker and Drive shows it as the preview', async () => {
    const d = await owner.api.call('createDrawing', {
      params: { spaceId },
      body: { name: 'Küçük resim' },
    });
    await owner.api.call('saveDrawingScene', {
      params: { nodeId: d.id },
      body: {
        elements: [
          rect('box', 1),
          {
            id: 'label',
            type: 'text',
            version: 1,
            index: 'b0',
            x: 30,
            y: 60,
            width: 160,
            height: 25,
            text: 'API <&> "Hono"',
            fontSize: 20,
            strokeColor: '#141516',
          },
          {
            id: 'arrow',
            type: 'arrow',
            version: 1,
            index: 'b1',
            x: 210,
            y: 80,
            points: [
              [0, 0],
              [180, 0],
            ],
            strokeColor: '#f38424',
            endArrowhead: 'arrow',
          },
        ],
      },
    });
    const logger = createLogger('silent');
    const render = () =>
      renderDrawingThumbnail({ db: app.deps.db, storage: app.deps.storage, logger }, d.id);
    // The save queued its own render (inline in tests); racing renders of one revision keep
    // exactly one thumbnail whatever order they finish in.
    const thumbOf = async () =>
      (await app.deps.db.select().from(drawings).where(eq(drawings.nodeId, d.id)))[0]
        ?.thumbnailBlobId ?? null;
    // The first thumbnail committed for a revision stays; later renders of it are dropped.
    const firstCommitted = (async () => {
      for (;;) {
        const id = await thumbOf();
        if (id) return id;
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    await Promise.all([render(), render(), render()]);
    const [row] = await app.deps.db.select().from(drawings).where(eq(drawings.nodeId, d.id));
    expect(row?.thumbnailBlobId).not.toBeNull();
    expect(row?.thumbnailBlobId).toBe(await firstCommitted);
    expect(row?.thumbnailRev).toBe(row?.sceneRev);

    const node = await owner.api.call('getNode', { params: { nodeId: d.id } });
    expect(node.preview).toBe('ready');
    const preview = await owner.api.call('getPreview', {
      params: { nodeId: d.id },
      query: { kind: 'thumb_256' },
    });
    const bytes = Buffer.from(await (await fetch(preview.url)).arrayBuffer());
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(256);

    // Up to date: a second run is a no-op; a new edit renders again and frees the old blob.
    await render();
    const [same] = await app.deps.db.select().from(drawings).where(eq(drawings.nodeId, d.id));
    expect(same?.thumbnailBlobId).toBe(row?.thumbnailBlobId);
    await owner.api.call('saveDrawingScene', {
      params: { nodeId: d.id },
      body: { elements: [rect('box', 2, { backgroundColor: '#14b8a6' })] },
    });
    await Promise.all([render(), render()]);
    const [next] = await app.deps.db.select().from(drawings).where(eq(drawings.nodeId, d.id));
    expect(next?.thumbnailRev).toBe(next?.sceneRev);
    expect(next?.thumbnailBlobId).not.toBe(row?.thumbnailBlobId);
    // Every render that lost the race (and the replaced thumbnail) is released.
    const owned = await app.deps.db
      .select({ id: blobs.id, refCount: blobs.refCount })
      .from(blobs)
      .where(eq(blobs.orgId, row!.orgId));
    const live = owned.filter((b) => b.refCount > 0).map((b) => b.id);
    expect(live).toContain(next!.thumbnailBlobId);
    expect(live).not.toContain(row!.thumbnailBlobId);
  });

  it('draws shapes, text and arrows into the thumbnail SVG with escaping', () => {
    const { svg } = sceneSvg([
      rect('a', 1) as never,
      {
        id: 't',
        type: 'text',
        version: 1,
        x: 0,
        y: 0,
        width: 50,
        height: 20,
        text: '<b>&',
      } as never,
    ]);
    expect(svg).toContain('<rect');
    expect(svg).toContain('&lt;b&gt;&amp;');
    expect(svg).not.toContain('<b>');
  });

  it('stores embedded images once per content and refuses non-images', async () => {
    const d = await owner.api.call('createDrawing', {
      params: { spaceId },
      body: { name: 'Görsel' },
    });
    const png = await sharp({
      create: { width: 40, height: 30, channels: 3, background: '#FBC419' },
    })
      .png()
      .toBuffer();
    const dataURL = `data:image/png;base64,${png.toString('base64')}`;
    const f = await owner.api.call('uploadDrawingFile', {
      params: { nodeId: d.id },
      body: { fileId: 'f1', dataURL },
    });
    expect(f).toMatchObject({ fileId: 'f1', mime: 'image/png', sizeBytes: png.length });
    const again = await owner.api.call('uploadDrawingFile', {
      params: { nodeId: d.id },
      body: { fileId: 'f1', dataURL },
    });
    expect(again.createdAt).toBe(f.createdAt);
    const url = await owner.api.call('getDrawingFileUrl', { params: { nodeId: d.id, file: 'f1' } });
    expect((await fetch(url.url)).status).toBe(200);
    await expect(
      owner.api.call('uploadDrawingFile', {
        params: { nodeId: d.id },
        body: {
          fileId: 'f2',
          dataURL: `data:image/png;base64,${Buffer.from('MZ fake exe').toString('base64')}`,
        },
      }),
    ).rejects.toMatchObject({ code: 'drawing_file_invalid' });
  });

  it('keeps personal and space shape libraries', async () => {
    const item = {
      id: 'srv',
      status: 'unpublished' as const,
      elements: [rect('s', 1)],
      name: 'Sunucu',
    };
    await owner.api.call('updateDrawingLibrary', {
      body: { scope: 'space', spaceId, items: [item] },
    });
    await owner.api.call('updateDrawingLibrary', {
      body: { scope: 'personal', items: [item, { ...item, id: 'p2' }] },
    });
    const lib = await owner.api.call('getDrawingLibrary', { query: { spaceId } });
    expect(lib.personal).toHaveLength(2);
    expect(lib.space?.map((i) => i.name)).toEqual(['Sunucu']);
    expect(lib.canEditSpace).toBe(true);
    const viewerLib = await viewer.person.api.call('getDrawingLibrary', { query: { spaceId } });
    expect(viewerLib).toMatchObject({ personal: [], canEditSpace: false });
    await expect(
      viewer.person.api.call('updateDrawingLibrary', {
        body: { scope: 'space', spaceId, items: [] },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('issues collab tokens per document: viewers read-only, bad names refused', async () => {
    const d = await owner.api.call('createDrawing', {
      params: { spaceId },
      body: { name: 'Jeton' },
    });
    const t = await owner.api.call('createBoardsCollabToken', {
      body: { document: `drawing:${d.id}` },
    });
    expect(t).toMatchObject({ readOnly: false, document: `drawing:${d.id}` });
    const v = await viewer.person.api.call('createBoardsCollabToken', {
      body: { document: `drawing:${d.id}` },
    });
    expect(v.readOnly).toBe(true);
    await expect(
      owner.api.call('createBoardsCollabToken', { body: { document: `page:${d.id}` } }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
