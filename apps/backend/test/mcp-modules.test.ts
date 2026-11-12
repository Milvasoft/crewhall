import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inverseOf, INVERSES, operationRule } from '../src/services/mcp/bridge';
import { endpoints, type EndpointName } from '@crewhall/shared';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';
import { callTool } from './mcp-helpers';

/**
 * The second round of MCP module tools: directory and contacts, mail, forms, announcements,
 * notifications, reactions/pins/reminders, table structure, bookings, sprints and time, and
 * the undo of direct bridge writes.
 */
describe('MCP module tools', () => {
  let app: TestApp;
  let owner: Client;
  let mert: Client;
  let mertId: string;
  let spaceId: string;
  let token: string;

  const undoLast = async (tool: string) => {
    const activity = await owner.api.call('listMcpActivity', { query: { filter: 'all' } });
    const call = activity.items.find((i) => i.tool === tool && i.result === 'ok')!;
    expect(call.canUndo).toBe(true);
    return owner.api.call('undoMcpToolCall', { params: { callNo: call.id } });
  };

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Milvasoft')!.id;
    const joined = await join(app, owner, 'mert@milvasoft.com', 'member', [spaceId]);
    mert = joined.person;
    mertId = joined.me.user.id;
    await owner.api.call('updateMcpPolicy', {
      body: { requestsPerMinute: 600, writesPerMinute: 200 },
    });
    token = (
      await owner.api.call('createMcpToken', {
        body: {
          name: 'Modüller',
          scopes: [
            'hub:read',
            'boards:write',
            'chat:send',
            'calendar:write',
            'contacts:write',
            'tables:write',
            'mail:send',
          ],
          spaceIds: null,
          expiresInDays: 30,
        },
      })
    ).value;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('every reverse operation exists and gets all of its path parameters', () => {
    for (const [name, inverse] of Object.entries(INVERSES)) {
      expect(operationRule(name), name).not.toBeNull();
      expect(operationRule(inverse.operation), inverse.operation).not.toBeNull();
      const def = endpoints[inverse.operation];
      const params = inverse.params(
        { tableId: 't', messageId: 'm', boardId: 'b', nodeId: 'n', cardId: 'c', rowId: 'r' },
        { id: 'x' },
      );
      for (const [, key] of def.path.matchAll(/:([A-Za-z0-9_]+)/g)) {
        expect(params[key!], `${inverse.operation}.${key}`).toBeTruthy();
      }
    }
    expect(inverseOf('updateBoardCard' as EndpointName, {}, { id: 'x' })).toBeUndefined();
  });

  it('finds colleagues and contacts, adds a contact, undo removes it', async () => {
    const created = await callTool(app, token, 'create_contact', {
      first_name: 'Ayşe',
      last_name: 'Yılmaz',
      emails: ['ayse@example.com'],
      tags: ['müşteri'],
    });
    expect(created.isError).toBe(false);
    const contactId = created.data.contact_id as string;
    const found = await callTool(app, token, 'search_directory', { query: 'Ayşe' });
    expect((found.data.contacts as { contact_id: string }[]).map((c) => c.contact_id)).toContain(
      contactId,
    );
    const people = await callTool(app, token, 'search_directory', {
      query: 'mert',
      include_contacts: false,
    });
    expect((people.data.people as { user_id: string }[]).map((p) => p.user_id)).toContain(mertId);

    await undoLast('create_contact');
    const after = await owner.api.call('listContacts', { query: { q: 'Ayşe' } });
    expect(after.items.some((c) => c.id === contactId)).toBe(false);
  });

  it('reads form answers by question label', async () => {
    const form = await owner.api.call('createForm', {
      params: { spaceId },
      body: {
        title: 'Etkinlik kaydı',
        fields: [
          { id: 'name', type: 'short_text', label: 'Ad', required: true },
          {
            id: 'team',
            type: 'single_choice',
            label: 'Ekip',
            choices: [
              { id: 'api', label: 'API' },
              { id: 'web', label: 'Web' },
            ],
          },
        ],
      },
    });
    await owner.api.call('updateForm', { params: { formId: form.id }, body: { status: 'open' } });
    await mert.api.call('submitForm', {
      params: { formId: form.id },
      body: { answers: { name: 'Mert', team: 'api' } },
    });
    const forms = await callTool(app, token, 'list_forms', { space_id: spaceId });
    expect(forms.data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ form_id: form.id, responses: 1 })]),
    );
    const answers = await callTool(app, token, 'list_form_responses', { form_id: form.id });
    expect(answers.isError).toBe(false);
    expect(answers.data.items).toEqual([
      expect.objectContaining({ respondent: 'mert', answers: { Ad: 'Mert', Ekip: 'API' } }),
    ]);
  });

  it('announcements wait for approval; notifications get marked read', async () => {
    const pending = await callTool(app, token, 'post_announcement', {
      title: 'Bakım',
      body: 'Cuma 22:00 bakım var.',
      note: 'Kullanıcı istedi',
    });
    expect(pending.data.status).toBe('pending_approval');
    const before = await callTool(app, token, 'list_announcements', {});
    expect((before.data.items as { title: string }[]).map((a) => a.title)).not.toContain('Bakım');
    const approved = await owner.api.call('approveMcpApproval', {
      params: { approvalId: pending.data.approval_id as string },
    });
    expect(approved.status).toBe('applied');
    const after = await callTool(app, token, 'list_announcements', {});
    expect((after.data.items as { title: string }[]).map((a) => a.title)).toContain('Bakım');

    const marked = await callTool(app, token, 'mark_notifications_read', { all: true });
    expect(marked.isError).toBe(false);
    expect(marked.data.unread).toBe(0);
    const none = await callTool(app, token, 'mark_notifications_read', {});
    expect(none.data.error).toBe('validation_failed');
  });

  it('reacts, pins and sets a reminder in a conversation; undo takes the reaction back', async () => {
    const dm = await owner.api.call('createConversation', {
      body: { type: 'direct', userId: mertId },
    });
    await mert.api.call('sendMessage', {
      params: { conversationId: dm.id },
      body: { text: 'Sözleşme hazır mı?', clientMsgId: crypto.randomUUID() },
    });
    const read = await callTool(app, token, 'read_messages', { conversation_id: dm.id });
    const messageId = (read.data.items as { message_id: string }[])[0]!.message_id;
    expect(messageId).toBeTruthy();

    const reacted = await callTool(app, token, 'react_to_message', {
      message_id: messageId,
      emoji: '👍',
    });
    expect(reacted.isError).toBe(false);
    const pinned = await callTool(app, token, 'pin_message', { message_id: messageId });
    expect(pinned.data.pinned).toBe(true);
    const reminder = await callTool(app, token, 'create_chat_reminder', {
      conversation_id: dm.id,
      remind_at: new Date(Date.now() + 86_400_000).toISOString(),
      text: 'Sözleşmeye bak',
    });
    expect(reminder.isError).toBe(false);
    const reminders = await owner.api.call('listChatReminders');
    expect(reminders.items.map((r) => r.id)).toContain(reminder.data.reminder_id);

    await undoLast('react_to_message');
    const pins = await owner.api.call('listPinnedMessages', {
      params: { conversationId: dm.id },
    });
    expect(pins.items.map((m) => m.message.id)).toContain(messageId);
    const messages = await owner.api.call('listMessages', {
      params: { conversationId: dm.id },
      query: {},
    });
    const msg = messages.items.find((m) => m.id === messageId)!;
    expect(msg.reactions.length).toBe(0);
  });

  it('adds fields with choices and a kanban view to a table', async () => {
    const table = await owner.api.call('createTable', {
      params: { spaceId },
      body: { name: 'Müşteriler' },
    });
    const field = await callTool(app, token, 'create_table_field', {
      table_id: table.id,
      name: 'Aşama',
      type: 'single_select',
      choices: ['Aday', 'Teklif'],
    });
    expect(field.isError).toBe(false);
    const changed = await callTool(app, token, 'update_table_field', {
      table_id: table.id,
      field: 'aşama',
      choices: ['Aday', 'Teklif', 'Kazanıldı'],
    });
    expect(changed.data.choices).toEqual(['Aday', 'Teklif', 'Kazanıldı']);
    const view = await callTool(app, token, 'create_table_view', {
      table_id: table.id,
      name: 'Huni',
      type: 'kanban',
      kanban_field: 'Aşama',
    });
    expect(view.isError).toBe(false);
    const full = await owner.api.call('getTable', { params: { tableId: table.id } });
    const huni = full.views.find((v) => v.id === view.data.view_id)!;
    expect(huni.config.kanbanFieldId).toBe(field.data.field_id);

    await undoLast('create_table_view');
    const after = await owner.api.call('getTable', { params: { tableId: table.id } });
    expect(after.views.some((v) => v.id === view.data.view_id)).toBe(false);
  });

  it('finds a free room and books it; undo cancels the booking', async () => {
    const room = await owner.api.call('createBookingResource', {
      body: { kind: 'room', name: 'Toplantı odası 1', capacity: 8 },
    });
    const start = new Date(Date.now() + 2 * 86_400_000);
    start.setUTCHours(8, 0, 0, 0);
    const end = new Date(start.getTime() + 3_600_000);
    const free = await callTool(app, token, 'find_free_resources', {
      from: start.toISOString(),
      to: end.toISOString(),
      capacity: 4,
    });
    expect(free.data.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ resource_id: room.id, free: true })]),
    );
    const booked = await callTool(app, token, 'book_resource', {
      resource_id: room.id,
      start: start.toISOString(),
      end: end.toISOString(),
      title: 'Planlama',
    });
    expect(booked.isError).toBe(false);
    const busy = await callTool(app, token, 'find_free_resources', {
      from: start.toISOString(),
      to: end.toISOString(),
    });
    expect(
      (busy.data.items as { resource_id: string; free: boolean }[]).find(
        (i) => i.resource_id === room.id,
      )!.free,
    ).toBe(false);
    await undoLast('book_resource');
    const again = await callTool(app, token, 'find_free_resources', {
      from: start.toISOString(),
      to: end.toISOString(),
    });
    expect(
      (again.data.items as { resource_id: string; free: boolean }[]).find(
        (i) => i.resource_id === room.id,
      )!.free,
    ).toBe(true);
  });

  it('plans, starts and closes a sprint; logs time and runs the timer', async () => {
    const board = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Sprintli', key: 'SPR' },
    });
    const column = await owner.api.call('createBoardColumn', {
      params: { boardId: board.id },
      body: { name: 'Yapılacak' },
    });
    const card = await owner.api.call('createBoardCard', {
      params: { boardId: board.id },
      body: { columnId: column.id, title: 'İş' },
    });
    const today = new Date().toISOString().slice(0, 10);
    const later = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);
    const sprint = await callTool(app, token, 'manage_board_sprint', {
      action: 'create',
      board_id: board.id,
      name: 'Sprint 1',
      starts_on: today,
      ends_on: later,
    });
    expect(sprint.isError).toBe(false);
    const sprintId = sprint.data.sprint_id as string;
    const started = await callTool(app, token, 'manage_board_sprint', {
      action: 'start',
      sprint_id: sprintId,
    });
    expect(started.data.status).toBe('active');
    const listed = await callTool(app, token, 'list_board_sprints', { board_id: board.id });
    expect((listed.data.items as { sprint_id: string }[]).map((s) => s.sprint_id)).toContain(
      sprintId,
    );
    const closed = await callTool(app, token, 'manage_board_sprint', {
      action: 'close',
      sprint_id: sprintId,
    });
    expect(closed.data.status).toBe('closed');

    const logged = await callTool(app, token, 'log_card_time', {
      card_id: card.id,
      minutes: 90,
      note: 'API testleri',
    });
    expect(logged.data.minutes).toBe(90);
    await undoLast('log_card_time');
    const entries = await owner.api.call('listBoardCardTime', { params: { cardId: card.id } });
    expect(entries.items.some((e) => e.id === logged.data.entry_id)).toBe(false);
    const timer = await callTool(app, token, 'log_card_time', { card_id: card.id, timer: 'start' });
    expect(timer.isError).toBe(false);
    const stopped = await callTool(app, token, 'log_card_time', { timer: 'stop' });
    expect(stopped.isError).toBe(false);
  });

  it('mail goes out only after approval; reading needs a mailbox', async () => {
    const pending = await callTool(app, token, 'send_mail', {
      to: ['ayse@example.com'],
      subject: 'Teklif',
      text: 'Merhaba,\n\nTeklif ektedir.',
    });
    expect(pending.data.status).toBe('pending_approval');
    const detail = await owner.api.call('getMcpApproval', {
      params: { approvalId: pending.data.approval_id as string },
    });
    expect(detail.action).toBe('api.call');
    expect(detail.payload).toMatchObject({
      operation: 'mailSend',
      body: { subject: 'Teklif', html: '<p>Merhaba,</p><p>Teklif ektedir.</p>' },
    });
    const read = await callTool(app, token, 'read_mail', { uid: 1 });
    expect(read.isError).toBe(true);
  });

  it('direct bridge writes with a known reverse can be undone', async () => {
    const made = await callTool(app, token, 'call_write_operation', {
      operation: 'createContact',
      body: { firstName: 'Deniz', emails: [] },
    });
    expect(made.isError).toBe(false);
    const contactId = (made.data.result as { id: string }).id;
    await undoLast('call_write_operation');
    const after = await owner.api.call('listContacts', { query: { q: 'Deniz' } });
    expect(after.items.some((c) => c.id === contactId)).toBe(false);
  });
});
