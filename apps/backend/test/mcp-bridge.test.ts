import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { nodes, organizations, spaces } from '@crewhall/db';
import { operationRule } from '../src/services/mcp/bridge';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';
import { callTool, mcp } from './mcp-helpers';

/**
 * MCP over the whole of Crewhall: the dedicated tools for the busiest work (boards, pages,
 * Drive, calendar, meetings, portal categories) and the operation bridge for the rest
 * (find_operations, call_read_operation, call_write_operation) with its approval rules.
 */
describe('MCP operation bridge and module tools', () => {
  let app: TestApp;
  let owner: Client;
  let orgId: string;
  let spaceId: string;
  let otherSpaceId: string;
  let mertId: string;
  let token: string;
  let narrow: string;

  const toolNames = async (t: string) => {
    const res = await mcp(app, t, 'tools/list');
    return (res.json.result as { tools: { name: string }[] }).tools.map((x) => x.name);
  };
  const approve = async (approvalId: string) =>
    owner.api.call('approveMcpApproval', { params: { approvalId } });
  const lastCall = async (tool: string) => {
    const activity = await owner.api.call('listMcpActivity', { query: { filter: 'all' } });
    return activity.items.find((i) => i.tool === tool && i.result === 'ok')!;
  };

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    orgId = setup.orgId;
    const list = (await owner.api.call('listSpaces')).items;
    spaceId = list.find((s) => s.name === 'Milvasoft')!.id;
    otherSpaceId = list.find((s) => s.name === 'Altyapı')!.id;
    mertId = (await join(app, owner, 'mert@milvasoft.com', 'member', [spaceId])).me.user.id;
    await owner.api.call('updateMcpPolicy', {
      body: { requestsPerMinute: 600, writesPerMinute: 200 },
    });
    token = (
      await owner.api.call('createMcpToken', {
        body: {
          name: 'Her şey',
          scopes: [
            'hub:read',
            'pages:write',
            'drive:write',
            'boards:write',
            'portal:draft',
            'meetings:write',
            'calendar:write',
            'admin:write',
          ],
          spaceIds: null,
          expiresInDays: 30,
        },
      })
    ).value;
    narrow = (
      await owner.api.call('createMcpToken', {
        body: { name: 'Dar', scopes: ['hub:read'], spaceIds: [spaceId], expiresInDays: 30 },
      })
    ).value;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('operation rules', () => {
    it('keeps the vault, MCP management, live media and the trash out; gates risky writes', () => {
      expect(operationRule('vaultList')).toBeNull();
      expect(operationRule('listMcpTokens')).toBeNull();
      expect(operationRule('sendMessage')).toBeNull();
      expect(operationRule('emptyTrash')).toBeNull();
      expect(operationRule('ringCall')).toBeNull();
      expect(operationRule('getBoard')).toEqual({ scope: 'hub:read', approval: null });
      expect(operationRule('createBoardCard')).toEqual({ scope: 'boards:write', approval: null });
      expect(operationRule('deleteBoardCard')).toEqual({
        scope: 'boards:write',
        approval: 'api.call',
      });
      expect(operationRule('createShare')).toEqual({
        scope: 'drive:write',
        approval: 'share.external',
      });
      expect(operationRule('createSpace')).toEqual({ scope: 'admin:write', approval: 'api.call' });
      expect(operationRule('mailSend')).toEqual({ scope: 'mail:send', approval: 'api.call' });
      expect(operationRule('removeReaction')).toEqual({ scope: 'chat:send', approval: null });
    });
  });

  describe('catalog', () => {
    it('lists the new tools and searches operations with their schemas', async () => {
      expect(await toolNames(token)).toEqual(
        expect.arrayContaining([
          'find_operations',
          'call_read_operation',
          'call_write_operation',
          'read_page',
          'replace_page',
          'list_boards',
          'get_board',
          'create_board_card',
          'update_board_card',
          'move_nodes',
          'rename_node',
          'share_node',
          'list_calendar_events',
          'schedule_meeting',
          'create_portal_category',
          'move_portal_doc',
        ]),
      );
      const narrowNames = await toolNames(narrow);
      expect(narrowNames).toContain('find_operations');
      expect(narrowNames).not.toContain('create_board_card');

      const found = await callTool(app, token, 'find_operations', { query: 'board card' });
      expect(found.isError).toBe(false);
      const names = (found.data.items as { name: string }[]).map((i) => i.name);
      expect(names).toEqual(expect.arrayContaining(['createBoardCard', 'moveBoardCard']));
      expect(names.some((n) => n.startsWith('vault'))).toBe(false);

      const one = await callTool(app, token, 'find_operations', { name: 'createBoardCard' });
      expect(one.data).toMatchObject({
        name: 'createBoardCard',
        method: 'POST',
        scope: 'boards:write',
        tool: 'call_write_operation',
        path_params: ['boardId'],
      });
      expect((one.data.body_schema as { properties: object }).properties).toHaveProperty('title');

      // Without the scope an operation is hidden unless asked for.
      const readOnly = await callTool(app, narrow, 'find_operations', { query: 'board card' });
      const readNames = readOnly.data.items as { name: string; scope: string }[];
      expect(readNames.map((i) => i.name)).toContain('getBoardCard');
      expect(readNames.map((i) => i.name)).not.toContain('createBoardCard');
      expect(readNames.every((i) => i.scope === 'hub:read')).toBe(true);
      const all = await callTool(app, narrow, 'find_operations', {
        query: 'createBoardCard',
        include_unavailable: true,
      });
      expect(all.data.items).toEqual([expect.objectContaining({ available: false })]);

      const catalog = await owner.api.call('getMcpToolCatalog');
      const bridge = catalog.tools.find((t) => t.name === 'call_write_operation')!;
      expect(bridge.approval).toBe('policy');
      expect(catalog.tools.map((t) => t.name)).toContain('create_portal_category');
    });
  });

  describe('boards', () => {
    let boardId: string;

    beforeAll(async () => {
      const board = await owner.api.call('createBoard', {
        params: { spaceId },
        body: { name: 'Sürüm', key: 'SRM' },
      });
      boardId = board.id;
      for (const name of ['Sıra', 'Tamam']) {
        await owner.api.call('createBoardColumn', { params: { boardId }, body: { name } });
      }
    });

    it('lists boards, adds a card by column name, moves it, undoes the add', async () => {
      const boards = await callTool(app, token, 'list_boards', { space_id: spaceId });
      expect(boards.data.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ board_id: boardId, key: 'SRM' })]),
      );
      const created = await callTool(app, token, 'create_board_card', {
        board_id: boardId,
        column: 'sıra',
        title: 'Sürüm notlarını yaz',
        assignee_ids: [mertId],
      });
      expect(created.isError).toBe(false);
      expect(created.data.ref).toMatch(/^SRM-\d+$/);
      const cardId = created.data.card_id as string;

      const moved = await callTool(app, token, 'update_board_card', {
        card_id: cardId,
        column: 'Tamam',
        priority: 'p1',
      });
      expect(moved.isError).toBe(false);
      expect(moved.data.column).toBe('Tamam');

      const board = await callTool(app, token, 'get_board', { board_id: boardId });
      const card = (
        board.data.cards as { card_id: string; column: string; assignees: string[] }[]
      ).find((c) => c.card_id === cardId)!;
      expect(card.column).toBe('Tamam');
      expect(card.assignees.length).toBe(1);

      const missing = await callTool(app, token, 'create_board_card', {
        board_id: boardId,
        column: 'Yok böyle',
        title: 'x',
      });
      expect(missing.isError).toBe(true);
      expect(missing.data.message).toContain('Sıra');

      const call = await lastCall('create_board_card');
      expect(call.canUndo).toBe(true);
      await owner.api.call('undoMcpToolCall', { params: { callNo: call.id } });
      const after = await owner.api.call('getBoard', { params: { boardId } });
      expect(after.cards.some((c) => c.id === cardId)).toBe(false);
    });

    it('writes through the bridge: direct when safe, through approval when it deletes', async () => {
      const column = await callTool(app, token, 'call_write_operation', {
        operation: 'createBoardColumn',
        params: { boardId },
        body: { name: 'İncelemede' },
      });
      expect(column.isError).toBe(false);
      const columnId = (column.data.result as { id: string }).id;

      const read = await callTool(app, token, 'call_read_operation', {
        operation: 'getBoard',
        params: { boardId },
      });
      expect(
        (read.data.result as { columns: { id: string }[] }).columns.map((c) => c.id),
      ).toContain(columnId);

      const pending = await callTool(app, token, 'call_write_operation', {
        operation: 'deleteBoardColumn',
        params: { columnId },
        note: 'Gereksiz sütun',
      });
      expect(pending.data.status).toBe('pending_approval');
      const approvalId = pending.data.approval_id as string;
      const detail = await owner.api.call('getMcpApproval', { params: { approvalId } });
      expect(detail.action).toBe('api.call');
      expect(detail.items[0]!.label).toBe('deleteBoardColumn');
      expect(detail.clientNote).toBe('Gereksiz sütun');
      const still = await owner.api.call('getBoard', { params: { boardId } });
      expect(still.columns.map((c) => c.id)).toContain(columnId);

      expect((await approve(approvalId)).status).toBe('applied');
      const gone = await owner.api.call('getBoard', { params: { boardId } });
      expect(gone.columns.map((c) => c.id)).not.toContain(columnId);
    });

    it('refuses the wrong tool, unknown, blocked and out-of-scope operations', async () => {
      const wrong = await callTool(app, token, 'call_read_operation', {
        operation: 'createBoardColumn',
        params: { boardId },
      });
      expect(wrong.data.error).toBe('validation_failed');
      const vault = await callTool(app, token, 'call_read_operation', { operation: 'vaultList' });
      expect(vault.data.error).toBe('unknown_operation');
      const chat = await callTool(app, token, 'call_write_operation', {
        operation: 'sendMessage',
        params: { conversationId: crypto.randomUUID() },
        body: { text: 'x' },
      });
      expect(chat.data.error).toBe('unknown_operation');
      const scoped = await callTool(app, narrow, 'call_write_operation', {
        operation: 'createBoardColumn',
        params: { boardId },
        body: { name: 'x' },
      });
      expect(scoped.data.error).toBe('insufficient_scope');
      const invalid = await callTool(app, token, 'call_write_operation', {
        operation: 'deleteBoardColumn',
        params: {},
      });
      expect(invalid.data.error).toBe('validation_failed');
    });

    it('a connection limited to one space cannot reach another space', async () => {
      const elsewhere = await owner.api.call('createBoard', {
        params: { spaceId: otherSpaceId },
        body: { name: 'Altyapı panosu' },
      });
      const denied = await callTool(app, narrow, 'call_read_operation', {
        operation: 'getBoard',
        params: { boardId: elsewhere.id },
      });
      expect(denied.isError).toBe(true);
      expect(denied.data.error).toBe('not_found');
      const own = await callTool(app, narrow, 'call_read_operation', {
        operation: 'getBoard',
        params: { boardId },
      });
      expect(own.isError).toBe(false);
      const listed = await callTool(app, narrow, 'call_read_operation', {
        operation: 'listSpaces',
      });
      expect((listed.data.result as { items: { id: string }[] }).items.map((s) => s.id)).toEqual([
        spaceId,
      ]);
    });

    it('hides board tools and operations while the org has boards off', async () => {
      await app.deps.db.execute(
        sql`update ${organizations} set settings = jsonb_set(settings, '{modules}', ${JSON.stringify({ boards: false })}::jsonb) where id = ${orgId}`,
      );
      try {
        const names = await toolNames(token);
        expect(names).not.toContain('create_board_card');
        const found = await callTool(app, token, 'find_operations', { module: 'boards' });
        expect(found.data.items).toEqual([]);
        const call = await callTool(app, token, 'call_read_operation', {
          operation: 'getBoard',
          params: { boardId },
        });
        expect(call.data.error).toBe('unknown_operation');
      } finally {
        await app.deps.db.execute(
          sql`update ${organizations} set settings = settings - 'modules' where id = ${orgId}`,
        );
      }
    });
  });

  describe('pages', () => {
    it('reads a page as Markdown and replaces its body after saving a version', async () => {
      const page = await callTool(app, token, 'create_page', {
        space_id: spaceId,
        title: 'Mimari',
        markdown: '# Katmanlar\n\n- API\n- Web',
      });
      const nodeId = page.data.node_id as string;
      const read = await callTool(app, token, 'read_page', { node_id: nodeId });
      expect(read.isError).toBe(false);
      expect(read.data.markdown).toContain('Katmanlar');
      expect(read.data.can_edit).toBe(true);
      const node = await callTool(app, token, 'get_node', { node_id: nodeId });
      expect(node.data.markdown).toContain('Web');

      const replaced = await callTool(app, token, 'replace_page', {
        node_id: nodeId,
        markdown: '# Yeni mimari\n\n- Tek servis',
      });
      expect(replaced.isError).toBe(false);
      const content = await owner.api.call('getPageContent', {
        params: { nodeId },
        query: {},
      });
      expect(content.markdown).toContain('Tek servis');
      expect(content.markdown).not.toContain('Katmanlar');
      const versions = await owner.api.call('listPageVersions', { params: { nodeId } });
      expect(versions.items.some((v) => v.id === replaced.data.saved_version_id)).toBe(true);
    });
  });

  describe('drive', () => {
    it('moves and renames with undo, shares with a person directly and a link after approval', async () => {
      const a = await callTool(app, token, 'create_folder', { space_id: spaceId, name: 'Arşiv' });
      const b = await callTool(app, token, 'create_folder', { space_id: spaceId, name: 'Taslak' });
      const target = a.data.node_id as string;
      const nodeId = b.data.node_id as string;

      const moved = await callTool(app, token, 'move_nodes', {
        node_ids: [nodeId],
        space_id: spaceId,
        parent_id: target,
      });
      expect(moved.isError).toBe(false);
      let [row] = await app.deps.db.select().from(nodes).where(eq(nodes.id, nodeId));
      expect(row!.parentId).toBe(target);
      await owner.api.call('undoMcpToolCall', {
        params: { callNo: (await lastCall('move_nodes')).id },
      });
      [row] = await app.deps.db.select().from(nodes).where(eq(nodes.id, nodeId));
      expect(row!.parentId).toBeNull();

      const renamed = await callTool(app, token, 'rename_node', { node_id: nodeId, name: 'Son' });
      expect(renamed.data).toMatchObject({ name: 'Son', old_name: 'Taslak' });
      await owner.api.call('undoMcpToolCall', {
        params: { callNo: (await lastCall('rename_node')).id },
      });
      [row] = await app.deps.db.select().from(nodes).where(eq(nodes.id, nodeId));
      expect(row!.name).toBe('Taslak');

      const toMert = await callTool(app, token, 'share_node', {
        node_id: nodeId,
        kind: 'user',
        user_id: mertId,
        role: 'editor',
      });
      expect(toMert.isError).toBe(false);
      const link = await callTool(app, token, 'share_node', {
        node_id: nodeId,
        kind: 'link',
        note: 'Müşteriye',
      });
      expect(link.data.status).toBe('pending_approval');
      const approvalId = link.data.approval_id as string;
      const detail = await owner.api.call('getMcpApproval', { params: { approvalId } });
      expect(detail.action).toBe('share.external');
      let shares = await owner.api.call('listShares', { params: { nodeId } });
      expect(shares.items.map((s) => s.kind).sort()).toEqual(['user']);
      expect((await approve(approvalId)).status).toBe('applied');
      shares = await owner.api.call('listShares', { params: { nodeId } });
      expect(shares.items.map((s) => s.kind).sort()).toEqual(['link', 'user']);
    });
  });

  describe('calendar and meetings', () => {
    it('lists events in a range and schedules a meeting that undo cancels', async () => {
      const start = new Date(Date.now() + 3 * 86_400_000);
      start.setUTCHours(9, 0, 0, 0);
      const end = new Date(start.getTime() + 3_600_000);
      const event = await callTool(app, token, 'create_calendar_event', {
        title: 'Planlama',
        start: start.toISOString(),
        end: end.toISOString(),
      });
      expect(event.isError).toBe(false);
      const list = await callTool(app, token, 'list_calendar_events', {
        from: new Date(start.getTime() - 86_400_000).toISOString(),
        to: new Date(start.getTime() + 86_400_000).toISOString(),
      });
      expect(list.isError).toBe(false);
      expect((list.data.items as { title: string }[]).map((i) => i.title)).toContain('Planlama');

      const meeting = await callTool(app, token, 'schedule_meeting', {
        title: 'Sürüm toplantısı',
        starts_at: start.toISOString(),
        duration_minutes: 30,
        invitee_user_ids: [mertId],
      });
      expect(meeting.isError).toBe(false);
      expect(String(meeting.data.url)).toContain('/m/');
      const meetingId = meeting.data.meeting_id as string;
      await owner.api.call('undoMcpToolCall', {
        params: { callNo: (await lastCall('schedule_meeting')).id },
      });
      const after = await owner.api.call('getMeeting', { params: { meetingId } });
      expect(after.cancelledAt).not.toBeNull();

      const guests = await callTool(app, token, 'schedule_meeting', {
        title: 'Müşteri görüşmesi',
        starts_at: start.toISOString(),
        guest_emails: ['musteri@example.com'],
      });
      expect(guests.data.status).toBe('pending_approval');
    });
  });

  describe('administration', () => {
    it('opens a space only after the person approves', async () => {
      const pending = await callTool(app, token, 'call_write_operation', {
        operation: 'createSpace',
        body: { name: 'Pazarlama', color: 's3' },
        note: 'Yeni ekip',
      });
      expect(pending.data.status).toBe('pending_approval');
      const approvalId = pending.data.approval_id as string;
      const before = await app.deps.db.select().from(spaces).where(eq(spaces.name, 'Pazarlama'));
      expect(before.length).toBe(0);
      const applied = await approve(approvalId);
      expect(applied.status).toBe('applied');
      const after = await app.deps.db.select().from(spaces).where(eq(spaces.name, 'Pazarlama'));
      expect(after.length).toBe(1);
    });
  });

  describe('portal categories', () => {
    it('opens a category, writes a doc into it and moves it back to the root', async () => {
      await owner.api.call('createPortalSite', {
        body: {
          name: 'Docs',
          slug: 'docs',
          domain: 'docs.milvasoft.com',
          locales: ['tr', 'en'],
          defaultLocale: 'tr',
          initialVersion: '1.0',
        },
      });
      const portalToken = (
        await owner.api.call('createMcpToken', {
          body: {
            name: 'Portal',
            scopes: ['hub:read', 'portal:draft'],
            spaceIds: null,
            expiresInDays: 30,
          },
        })
      ).value;
      const category = await callTool(app, portalToken, 'create_portal_category', {
        lang: 'tr',
        title: 'Kurulum',
      });
      expect(category.isError).toBe(false);
      const groupId = category.data.group_id as string;
      const en = await callTool(app, portalToken, 'create_portal_category', {
        lang: 'en',
        title: 'Installation',
        translation_of: category.data.doc_id,
      });
      expect(en.data.group_id).toBe(groupId);

      const doc = await callTool(app, portalToken, 'upsert_portal_doc', {
        lang: 'tr',
        slug: 'kurulum/docker',
        title: 'Docker ile kurulum',
        markdown: 'docker compose up',
        parent_group_id: groupId,
      });
      expect(doc.isError).toBe(false);
      const tree = await callTool(app, portalToken, 'list_portal_docs', { lang: 'tr' });
      const items = tree.data.items as { id: string; kind: string; parent_group_id: string }[];
      expect(items.find((i) => i.id === category.data.doc_id)?.kind).toBe('category');
      expect(items.find((i) => i.id === doc.data.doc_id)?.parent_group_id).toBe(groupId);

      const moved = await callTool(app, portalToken, 'move_portal_doc', {
        doc_id: doc.data.doc_id,
        parent_group_id: null,
        title: 'Docker',
      });
      expect(moved.isError).toBe(false);
      expect(moved.data.parent_group_id).toBeNull();
    });
  });
});
