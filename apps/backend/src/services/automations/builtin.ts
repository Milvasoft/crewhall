import { and, eq, inArray } from 'drizzle-orm';
import { boardColumns, forms, spaceMembers } from '@crewhall/db';
import { CHAT_LIMITS, Id, paths } from '@crewhall/shared';
import { z } from 'zod';
import { AppError } from '../../http/errors';
import { loadBoard, requireRole } from '../boards/access';
import { createCard } from '../boards/cards';
import { inBoardsTx } from '../boards/integrations';
import { membershipOf, requireMember, requirePermission, type Membership } from '../chat/access';
import { publishMessage, writeMessage } from '../chat/messages';
import { loadNode } from '../drive/access';
import { deliverNotifications, notify } from '../notifications/notify';
import { registerAction, registerTrigger } from './registry';
import { postWebhook } from './webhook';
// The calendar registers `calendar.event_upcoming` itself.
import '../calendar/automation';
// Tables register their row triggers and actions.
import '../tables/automation';

/**
 * Built-in triggers and actions (roadmap 17). Other modules register theirs the same way
 * (registerTrigger / registerAction), e.g. the calendar's `calendar.event_upcoming` trigger and
 * the AI module's step.
 */

const optionalId = Id.nullable().default(null);

/* --------------------------------- triggers --------------------------------- */

registerTrigger({
  type: 'boards.card_moved',
  module: 'boards',
  config: z.object({ boardId: Id, toColumnId: optionalId, fromColumnId: optionalId }),
  fields: [
    { key: 'boardId', kind: 'board', required: true, options: [], dependsOn: null },
    { key: 'fromColumnId', kind: 'column', required: false, options: [], dependsOn: 'boardId' },
    { key: 'toColumnId', kind: 'column', required: false, options: [], dependsOn: 'boardId' },
  ],
  variables: [
    'card.ref',
    'card.title',
    'card.url',
    'board.name',
    'from.name',
    'to.name',
    'to.done',
    'actor.name',
  ],
  async validate(db, a, spaceId, c) {
    const access = await loadBoard(db, a, c.boardId).catch(() => {
      throw new AppError('automation_target_invalid', { field: 'boardId' });
    });
    if (access.space.id !== spaceId)
      throw new AppError('automation_target_invalid', { field: 'boardId' });
    for (const col of [c.fromColumnId, c.toColumnId]) {
      if (!col) continue;
      const [row] = await db
        .select({ id: boardColumns.id })
        .from(boardColumns)
        .where(and(eq(boardColumns.id, col), eq(boardColumns.boardNodeId, c.boardId)));
      if (!row) throw new AppError('automation_target_invalid', { field: 'column' });
    }
  },
  matches: (c, e) =>
    e.match?.boardId === c.boardId &&
    (!c.toColumnId || e.match?.toColumnId === c.toColumnId) &&
    (!c.fromColumnId || e.match?.fromColumnId === c.fromColumnId),
  sample: () => ({
    card: { id: null, ref: 'MLV-42', title: 'Örnek kart', url: '/' },
    board: { id: null, name: 'Örnek pano' },
    from: { id: null, name: 'Yapılıyor' },
    to: { id: null, name: 'Bitti', done: true },
    actor: { id: null, name: 'Crewhall' },
  }),
});

registerTrigger({
  type: 'forms.response_submitted',
  module: 'forms',
  config: z.object({ formId: Id }),
  fields: [{ key: 'formId', kind: 'form', required: true, options: [], dependsOn: null }],
  variables: ['form.title', 'form.url', 'response.url', 'respondent.name', 'answers'],
  async validate(db, a, spaceId, c) {
    const [row] = await db
      .select({ spaceId: forms.spaceId })
      .from(forms)
      .where(and(eq(forms.id, c.formId), eq(forms.orgId, a.org.id)));
    if (!row || row.spaceId !== spaceId)
      throw new AppError('automation_target_invalid', { field: 'formId' });
  },
  matches: (c, e) => e.match?.formId === c.formId,
  sample: () => ({
    form: { id: null, title: 'Örnek form', url: '/' },
    response: { id: null, url: '/' },
    respondent: { name: 'Crewhall' },
    answers: {},
  }),
});

registerTrigger({
  type: 'drive.file_uploaded',
  module: null,
  config: z.object({
    folderId: optionalId,
    /** Comma-separated extensions without dots ("pdf, docx"); empty = any. */
    extensions: z.string().max(200).nullable().default(null),
  }),
  fields: [
    { key: 'folderId', kind: 'folder', required: false, options: [], dependsOn: null },
    { key: 'extensions', kind: 'text', required: false, options: [], dependsOn: null },
  ],
  variables: [
    'file.name',
    'file.mime',
    'file.size',
    'file.version',
    'file.url',
    'folder.name',
    'actor.name',
  ],
  async validate(db, a, spaceId, c) {
    if (!c.folderId) return;
    const access = await loadNode(db, a, c.folderId).catch(() => {
      throw new AppError('automation_target_invalid', { field: 'folderId' });
    });
    if (access.node.type !== 'folder' || access.space.id !== spaceId) {
      throw new AppError('automation_target_invalid', { field: 'folderId' });
    }
  },
  matches: (c, e) => {
    const folders = Array.isArray(e.match?.folderIds) ? (e.match.folderIds as string[]) : [];
    if (c.folderId && !folders.includes(c.folderId)) return false;
    const exts = (c.extensions ?? '')
      .split(',')
      .map((x) => x.trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean);
    if (exts.length === 0) return true;
    const name = String((e.data.file as { name?: unknown } | undefined)?.name ?? '').toLowerCase();
    return exts.some((x) => name.endsWith(`.${x}`));
  },
  sample: () => ({
    file: {
      id: null,
      name: 'ornek.pdf',
      mime: 'application/pdf',
      size: 1024,
      version: 1,
      url: '/',
    },
    folder: null,
    actor: { id: null, name: 'Crewhall' },
  }),
});

registerTrigger({
  type: 'webhook.received',
  module: null,
  config: z.object({}),
  fields: [],
  variables: ['body', 'contentType'],
  matches: () => true,
  sample: () => ({ body: { ornek: true }, contentType: 'application/json' }),
});

/* ---------------------------------- actions ---------------------------------- */

const template = (max: number) => z.string().trim().min(1).max(max);

/** Membership lookup for the bot author: nobody, so every member is notified. */
const NO_USER = '00000000-0000-0000-0000-000000000000';

registerAction({
  type: 'chat.post',
  module: 'chat',
  config: z.object({ conversationId: Id, text: template(4000) }),
  fields: [
    { key: 'conversationId', kind: 'conversation', required: true, options: [], dependsOn: null },
    { key: 'text', kind: 'template', required: true, options: [], dependsOn: null },
  ],
  async validate(db, a, _spaceId, c) {
    const m = await requireMember(db, a, c.conversationId).catch(() => {
      throw new AppError('automation_target_invalid', { field: 'conversationId' });
    });
    requirePermission(a, m, 'write');
  },
  /**
   * Posted by the "Otomasyon" bot (no author, the rule's name under it), like an incoming
   * webhook message, after the owner's right to write there is checked again.
   */
  async run(ctx, c) {
    const { db } = ctx.deps;
    const owner = await requireMember(db, ctx.actor, c.conversationId);
    requirePermission(ctx.actor, owner, 'write');
    const conv = owner.conv;
    const bot: Membership = { ...(await membershipOf(db, conv, NO_USER)), isMember: true };
    const text = ctx.render(c.text).slice(0, CHAT_LIMITS.messageChars);
    const result = await db.transaction((tx) =>
      writeMessage(ctx.deps, tx, bot, {
        authorId: null,
        webhookId: null,
        kind: 'webhook',
        text,
        automation: { ruleId: ctx.rule.id, ruleName: ctx.rule.name },
      }),
    );
    await publishMessage(
      ctx.deps,
      { ...conv, lastSeq: result.msg.seq },
      'message.created',
      result.msg,
    );
    await deliverNotifications(ctx.deps, result.notes);
    return { messageId: result.msg.id, seq: result.msg.seq };
  },
});

registerAction({
  type: 'boards.create_card',
  module: 'boards',
  config: z.object({
    boardId: Id,
    columnId: Id,
    title: template(300),
    description: z.string().max(10_000).nullable().default(null),
  }),
  fields: [
    { key: 'boardId', kind: 'board', required: true, options: [], dependsOn: null },
    { key: 'columnId', kind: 'column', required: true, options: [], dependsOn: 'boardId' },
    { key: 'title', kind: 'template', required: true, options: [], dependsOn: null },
    { key: 'description', kind: 'template', required: false, options: [], dependsOn: null },
  ],
  async validate(db, a, _spaceId, c) {
    const access = await loadBoard(db, a, c.boardId).catch(() => {
      throw new AppError('automation_target_invalid', { field: 'boardId' });
    });
    requireRole(a, access.role, 'edit');
    const [col] = await db
      .select({ id: boardColumns.id })
      .from(boardColumns)
      .where(and(eq(boardColumns.id, c.columnId), eq(boardColumns.boardNodeId, c.boardId)));
    if (!col) throw new AppError('automation_target_invalid', { field: 'columnId' });
  },
  async run(ctx, c) {
    const card = await inBoardsTx(ctx.deps, (tx) =>
      createCard(tx, ctx.actor, c.boardId, {
        columnId: c.columnId,
        title: ctx.render(c.title).slice(0, 300) || ctx.rule.name,
        description: c.description ? ctx.render(c.description).slice(0, 10_000) : undefined,
        top: false,
        labels: [],
        assigneeIds: [],
        dueAt: null,
        afterId: null,
        beforeId: null,
      }),
    );
    return { cardId: card.id, number: card.number, title: card.title, url: paths.board(c.boardId) };
  },
});

registerAction({
  type: 'notify.users',
  module: null,
  config: z.object({
    userIds: z.array(Id).min(1).max(20),
    text: template(500),
  }),
  fields: [
    { key: 'userIds', kind: 'users', required: true, options: [], dependsOn: null },
    { key: 'text', kind: 'template', required: true, options: [], dependsOn: null },
  ],
  async validate(db, _a, spaceId, c) {
    const rows = await db
      .select({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), inArray(spaceMembers.userId, c.userIds)));
    if (rows.length !== new Set(c.userIds).size) {
      throw new AppError('automation_target_invalid', { field: 'userIds' });
    }
  },
  async run(ctx, c) {
    // Only people still in the space hear about its events.
    const rows = await ctx.deps.db
      .select({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .where(
        and(eq(spaceMembers.spaceId, ctx.rule.spaceId), inArray(spaceMembers.userId, c.userIds)),
      );
    const text = ctx.render(c.text).slice(0, 500);
    const url = eventUrl(ctx.event.data) ?? paths.automationRule(ctx.rule.id);
    await notify(
      ctx.deps,
      rows.map((r) => ({
        orgId: ctx.actor.org.id,
        userId: r.userId,
        type: 'automations.notify',
        category: 'alert' as const,
        actorId: null,
        target: { type: 'space' as const, id: ctx.rule.spaceId, spaceId: ctx.rule.spaceId },
        data: { name: ctx.rule.name, text, excerpt: text },
        url,
      })),
    );
    return { notified: rows.length };
  },
});

registerAction({
  type: 'webhook.send',
  module: null,
  config: z.object({
    url: z
      .url()
      .max(2000)
      .refine((u) => /^https?:\/\//i.test(u)),
  }),
  fields: [{ key: 'url', kind: 'url', required: true, options: [], dependsOn: null }],
  async run(ctx, c) {
    const status = await postWebhook(c.url, ctx);
    return { status };
  },
});

/** The page an event is about (card, form answer, file), for notification links. */
function eventUrl(data: Record<string, unknown>): string | null {
  for (const key of ['card', 'response', 'file', 'form']) {
    const v = data[key] as { url?: unknown } | undefined;
    if (v && typeof v.url === 'string' && v.url.startsWith('/')) return v.url;
  }
  return null;
}
