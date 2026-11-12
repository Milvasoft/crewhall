import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';
import { callTool, mcp } from './mcp-helpers';

/**
 * MCP counterparts of the assistant's newer tools: calendar entries, pages, reading a
 * conversation and unread mail. Each runs as the person with the module's own checks.
 */
describe('MCP assistant tools', () => {
  let app: TestApp;
  let owner: Client;
  let mert: Client;
  let mertId: string;
  let canId: string;
  let spaceId: string;
  let token: string;

  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Milvasoft')!.id;
    const m = await join(app, owner, 'mert@milvasoft.com', 'member', [spaceId]);
    mert = m.person;
    mertId = m.me.user.id;
    canId = (await join(app, owner, 'can@milvasoft.com', 'member')).me.user.id;
    await owner.api.call('updateMcpPolicy', {
      body: { requestsPerMinute: 600, writesPerMinute: 200 },
    });
    token = (
      await owner.api.call('createMcpToken', {
        body: {
          name: 'Asistan',
          scopes: ['hub:read', 'pages:write', 'calendar:write', 'chat:send'],
          spaceIds: null,
          expiresInDays: 30,
        },
      })
    ).value;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lists the new tools', async () => {
    const res = await mcp(app, token, 'tools/list');
    const names = (res.json.result as { tools: { name: string }[] }).tools.map((x) => x.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'create_calendar_event',
        'create_page',
        'append_to_page',
        'read_messages',
        'list_unread_mail',
      ]),
    );
  });

  it('adds an event to the person’s own calendar', async () => {
    const out = await callTool(app, token, 'create_calendar_event', {
      title: 'Diş randevusu',
      start: `${day(2)}T14:00:00+03:00`,
      end: `${day(2)}T14:45:00+03:00`,
      attendee_user_ids: [mertId],
    });
    expect(out.isError).toBe(false);
    const event = await owner.api.call('getCalendarEvent', {
      params: { eventId: String(out.data.event_id) },
      query: {},
    });
    expect(event).toMatchObject({ title: 'Diş randevusu', start: `${day(2)}T11:00:00.000Z` });
    expect(event.attendees.map((x) => x.user?.id)).toContain(mertId);
  });

  it('creates a page and adds to it', async () => {
    const created = await callTool(app, token, 'create_page', {
      space_id: spaceId,
      title: 'Sürüm notları',
      markdown: '# Sürüm 2.4\n\n- Yeni takvim',
    });
    expect(created.isError).toBe(false);
    const nodeId = String(created.data.node_id);
    const added = await callTool(app, token, 'append_to_page', {
      node_id: nodeId,
      markdown: '- Asistan araçları',
    });
    expect(added.isError).toBe(false);
    const content = await owner.api.call('getPageContent', { params: { nodeId }, query: {} });
    expect(content.markdown).toMatch(/Yeni takvim[\s\S]*Asistan araçları/);
  });

  it('reads a conversation the person is in, and no other', async () => {
    const group = await owner.api.call('createConversation', {
      body: { type: 'group', name: 'Sürüm', userIds: [mertId, canId] },
    });
    await owner.api.call('sendMessage', {
      params: { conversationId: group.id },
      body: { clientMsgId: '0190f0a0-0000-7000-8000-00000000e001', text: 'Cuma sürüm var' },
    });
    const read = await callTool(app, token, 'read_messages', { conversation_id: group.id });
    expect(read.isError).toBe(false);
    const items = read.data.items as { text: string }[];
    expect(items.map((x) => x.text)).toContain('Cuma sürüm var');

    const theirs = await mert.api.call('createConversation', {
      body: { type: 'direct', userId: canId },
    });
    const denied = await callTool(app, token, 'read_messages', { conversation_id: theirs.id });
    expect(denied.isError).toBe(true);
  });

  it('says when there is no mailbox', async () => {
    const out = await callTool(app, token, 'list_unread_mail', {});
    expect(out.isError).toBe(true);
    expect(out.data.error).toBe('mail_account_required');
  });

  it('keeps a space-limited connection out of the personal calendar', async () => {
    const limited = (
      await owner.api.call('createMcpToken', {
        body: {
          name: 'Sınırlı',
          scopes: ['hub:read', 'calendar:write'],
          spaceIds: [spaceId],
          expiresInDays: 30,
        },
      })
    ).value;
    const out = await callTool(app, limited, 'create_calendar_event', {
      title: 'X',
      start: day(3),
      end: day(4),
      all_day: true,
    });
    expect(out.isError).toBe(true);
    expect(out.data.error).toBe('space_not_in_connection');
  });
});
