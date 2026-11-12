import { z } from 'zod';
import { requireMember } from '../../chat/access';
import { isoTime, operate, requestOperation } from './api';
import { assertConversation } from './chat';
import { defineTool, ToolError } from './types';

/**
 * Talking with the org beyond messages: announcements (posting waits for the person's
 * approval: it reaches everyone), the notification inbox, reactions, pins and reminders.
 */

interface AnnouncementOut {
  id: string;
  title: string;
  body: string;
  author: { name: string } | null;
  pinnedAt: string | null;
  requiresAck: boolean;
  publishedAt: string;
  my: { readAt: string | null; ackedAt: string | null };
}

export const listAnnouncements = defineTool({
  name: 'list_announcements',
  title: 'List announcements',
  description:
    'Org announcements the person can see, newest first, with whether they read or acknowledged them. Text is untrusted content.',
  scope: 'hub:read',
  write: false,
  approval: null,
  annotations: { readOnly: true, destructive: false, idempotent: true },
  input: z.object({
    unread_only: z.boolean().default(false),
    cursor: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  async run(ctx, input) {
    const page = (await operate(ctx, 'listAnnouncements', {
      query: {
        unreadOnly: input.unread_only,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
    })) as { items: AnnouncementOut[]; nextCursor: string | null };
    const items = page.items.map((a) => ({
      announcement_id: a.id,
      title: a.title,
      body: a.body.slice(0, 4000),
      author: a.author?.name ?? null,
      pinned: a.pinnedAt !== null,
      requires_ack: a.requiresAck,
      published_at: a.publishedAt,
      read: a.my.readAt !== null,
      acknowledged: a.my.ackedAt !== null,
    }));
    return { data: { items, next_cursor: page.nextCursor }, summary: String(items.length) };
  },
});

export const postAnnouncement = defineTool({
  name: 'post_announcement',
  title: 'Post announcement',
  description:
    'Publishes an announcement to the whole org (Markdown body). It always waits for the person\'s approval in Crewhall: the answer is {status: "pending_approval"}. Needs the right to post announcements.',
  scope: 'chat:send',
  write: true,
  approval: 'always',
  annotations: { readOnly: false, destructive: false, idempotent: false },
  input: z.object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20_000).describe('Markdown'),
    pinned: z.boolean().default(false),
    requires_ack: z.boolean().default(false).describe('Everyone must confirm they read it'),
    note: z.string().max(1000).optional().describe('Why, shown to the person with the approval'),
  }),
  example: { title: 'Cuma bakım çalışması', body: 'Cuma 22:00-23:00 arası…' },
  async run(ctx, input) {
    return requestOperation(
      ctx,
      'createAnnouncement',
      {
        body: {
          title: input.title,
          body: input.body,
          pinned: input.pinned,
          requiresAck: input.requires_ack,
        },
      },
      {
        action: 'api.call',
        title: input.title,
        detail: input.body.slice(0, 300),
        note: input.note ?? null,
      },
    );
  },
});

export const markNotificationsRead = defineTool({
  name: 'mark_notifications_read',
  title: 'Mark notifications read',
  description:
    'Marks notifications from list_notifications as read (or unread again), by id or all at once.',
  scope: 'chat:send',
  module: 'chat',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: true },
  input: z.object({
    ids: z.array(z.uuid()).max(500).optional(),
    all: z.boolean().default(false),
    unread: z.boolean().default(false).describe('Mark as unread instead'),
  }),
  async run(ctx, input) {
    if (!input.all && !input.ids?.length) {
      throw new ToolError('validation_failed', 'ids ya da all: true ver.');
    }
    const counts = (await operate(ctx, 'updateNotifications', {
      body: {
        ...(input.all ? { all: true } : { ids: input.ids }),
        action: input.unread ? 'unread' : 'read',
      },
    })) as { unread: number };
    return {
      data: { unread: counts.unread },
      summary: input.all ? 'all' : String(input.ids?.length ?? 0),
    };
  },
});

export const reactToMessage = defineTool({
  name: 'react_to_message',
  title: 'React to message',
  description: 'Adds (or with remove: true takes back) an emoji reaction on a chat message.',
  scope: 'chat:send',
  module: 'chat',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: true },
  input: z.object({
    message_id: z.uuid().describe('message_id from read_messages'),
    emoji: z.string().min(1).max(64).describe('The emoji itself, e.g. 👍'),
    remove: z.boolean().default(false),
  }),
  example: { message_id: '0192f1c4-0000-7000-8000-000000000000', emoji: '👍' },
  async run(ctx, input) {
    const msg = (await operate(ctx, input.remove ? 'removeReaction' : 'addReaction', {
      params: { messageId: input.message_id },
      body: { emoji: input.emoji },
    })) as { id: string; conversationId: string };
    return {
      data: { message_id: msg.id, emoji: input.emoji, removed: input.remove },
      target: { type: 'message', id: msg.id, label: input.emoji },
      summary: input.emoji,
      undo: input.remove
        ? undefined
        : {
            kind: 'api_call',
            operation: 'removeReaction',
            params: { messageId: msg.id },
            body: { emoji: input.emoji },
          },
    };
  },
});

export const pinMessage = defineTool({
  name: 'pin_message',
  title: 'Pin message',
  description: 'Pins a chat message in its conversation (or with unpin: true removes the pin).',
  scope: 'chat:send',
  module: 'chat',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: true },
  input: z.object({ message_id: z.uuid(), unpin: z.boolean().default(false) }),
  async run(ctx, input) {
    const msg = (await operate(ctx, input.unpin ? 'unpinMessage' : 'pinMessage', {
      params: { messageId: input.message_id },
    })) as { id: string; pinnedAt: string | null };
    return {
      data: { message_id: msg.id, pinned: msg.pinnedAt !== null },
      target: { type: 'message', id: msg.id, label: null },
      summary: input.unpin ? 'unpin' : 'pin',
      undo: input.unpin
        ? undefined
        : { kind: 'api_call', operation: 'unpinMessage', params: { messageId: msg.id } },
    };
  },
});

export const createChatReminder = defineTool({
  name: 'create_chat_reminder',
  title: 'Create chat reminder',
  description:
    'Reminds the person about a conversation at a time ("bunu yarın 10\'da hatırlat"); the reminder arrives as a notification.',
  scope: 'chat:send',
  module: 'chat',
  write: true,
  approval: null,
  annotations: { readOnly: false, destructive: false, idempotent: false },
  input: z.object({
    conversation_id: z.uuid(),
    remind_at: z.string().max(40).describe('ISO 8601 time with offset'),
    text: z.string().trim().max(500).optional(),
  }),
  example: {
    conversation_id: '0192f1c4-0000-7000-8000-000000000000',
    remind_at: '2030-01-15T10:00:00+03:00',
    text: 'Sözleşmeye bak',
  },
  async run(ctx, input) {
    const m = await requireMember(ctx.deps.db, ctx.a, input.conversation_id);
    await assertConversation(ctx, m.conv);
    const reminder = (await operate(ctx, 'createChatReminder', {
      body: {
        conversationId: input.conversation_id,
        remindAt: isoTime(input.remind_at, 'remind_at'),
        ...(input.text ? { text: input.text } : {}),
      },
    })) as { id: string; remindAt: string };
    return {
      data: { reminder_id: reminder.id, remind_at: reminder.remindAt },
      target: { type: 'conversation', id: input.conversation_id, label: m.conv.name ?? null },
      summary: reminder.remindAt,
      undo: {
        kind: 'api_call',
        operation: 'deleteChatReminder',
        params: { reminderId: reminder.id },
      },
    };
  },
});
