import { and, eq, inArray, isNull } from 'drizzle-orm';
import { readStates, spaces, users, type DbOrTx } from '@crewhall/db';
import type { resources } from '@crewhall/i18n';
import {
  CHAT_LIMITS,
  CreateCalendarEvent,
  pagePath,
  paths,
  withQuery,
  type AiActKind,
  type Locale,
} from '@crewhall/shared';
import { z } from 'zod';
import type { Deps } from '../../deps';
import type { RequestInfo } from '../../http/types';
import { AppError } from '../../http/errors';
import { personalCalendar } from '../calendar/access';
import { createEvent } from '../calendar/events';
import { createConversation, listConversations } from '../chat/conversations';
import { listMessages } from '../chat/messages';
import { mentionedIds, plainText } from '../chat/text';
import { reachableSpaceIds, type DriveActor } from '../drive/access';
import { container } from '../drive/nodes';
import { searchNodes } from '../drive/personal';
import { isModuleEnabled } from '../identity/modules';
import { deliverMessage } from '../mcp/chat-send';
import { personalSpaceId } from '../spaces';
import { canDo, canEditBody, loadPage } from '../wiki/access';
import { editPage } from '../wiki/live';
import { markdownToDoc } from '../wiki/markdown';
import { createPage } from '../wiki/pages';
import { findPages, fold } from './assistant-data';
import { extractTasksPrompt, type ChatLine } from './prompts';
import type { ModelConfig } from './providers';
import { executeRun, type AiCaller } from './run';

/**
 * More things the assistant can prepare in "Yap" mode: a calendar entry, a chat message, a page or
 * a note on a page, and tasks taken from a conversation. Like the first four kinds (actions.ts),
 * each becomes an approval request; nothing changes before the person approves it, and the
 * approved action runs as them through the module's own service, with its own permission checks.
 */

// ---------------------------------------------------------------------------------------
// What the model may write
// ---------------------------------------------------------------------------------------

const When = z.string().trim().max(40);

export const CreateEventAction = z.object({
  type: z.literal('create_event'),
  title: z.string().trim().min(1).max(200),
  /** "YYYY-MM-DDTHH:mm" in the person's zone, or "YYYY-MM-DD" for an all-day entry. */
  start: When,
  end: When.nullish(),
  duration_minutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .nullish(),
  location: z.string().trim().max(500).nullish(),
  attendees: z.array(z.string()).max(50).nullish(),
});

export const SendMessageAction = z.object({
  type: z.literal('send_message'),
  /** A colleague's name ("me" is not allowed) or a conversation's name. */
  to: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(CHAT_LIMITS.messageChars),
});

/** Markdown a page takes from the assistant at once (a note, not a book). */
const PageText = z.string().trim().min(1).max(20_000);

export const CreatePageAction = z.object({
  type: z.literal('create_page'),
  /** A space from <spaces>; null = the person's own space. */
  space: z.string().trim().max(200).nullish(),
  title: z.string().trim().min(1).max(200),
  /** Empty: a blank page. */
  text: z.string().trim().max(20_000).nullish(),
});

export const AppendPageAction = z.object({
  type: z.literal('append_page'),
  /** The page's title. */
  page: z.string().trim().min(1).max(200),
  text: PageText,
});

/**
 * Not a proposal itself: the server reads the conversation, the model lists its tasks, and they
 * become add_todo_item or create_card proposals (planActions expands it before preparing).
 */
export const ExtractTasksAction = z.object({
  type: z.literal('extract_tasks'),
  conversation: z.string().trim().min(1).max(200),
  /** "todo" (the person's to-do list) or a board key or name. */
  target: z.string().trim().max(200).nullish(),
  scope: z.enum(['unread', 'recent']).nullish(),
});

/** The new kinds, appended to the plan schema in actions.ts. */
export const MORE_ACTIONS = [
  CreateEventAction,
  SendMessageAction,
  CreatePageAction,
  AppendPageAction,
  ExtractTasksAction,
] as const;
export type MoreAction = z.infer<(typeof MORE_ACTIONS)[number]>;
export const MORE_TYPES = new Set<string>(MORE_ACTIONS.map((s) => s.shape.type.value));

// ---------------------------------------------------------------------------------------
// Preparing a proposal
// ---------------------------------------------------------------------------------------

export interface Prepared {
  kind: AiActKind;
  tool: string;
  payload: Record<string, unknown>;
  title: string;
  detail: string | null;
  location: string | null;
  /** What the action carries, listed on the approval. */
  items?: string[];
}

export type Sentences = (typeof resources)['tr']['email']['ai']['act'];

/** What actions.ts already knows, handed in so this file does not import it back. */
export interface MoreCtx {
  db: DbOrTx;
  a: DriveActor;
  tz: string;
  locale: Locale;
  tx: Sentences;
  /** "me" or a colleague's name → user ids, or the sentence why not. */
  resolvePeople(refs: string[]): { ids: string[] } | { error: string };
  names(ids: string[]): string;
  /** "2030-01-15T10:00" in the person's zone → UTC. */
  toUtc(local: string): Date | null;
}

const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const nextDay = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** "15 Ocak 10:00" / "15 Ocak" in the person's language and zone. */
function when(at: Date | string, ctx: MoreCtx, allDay: boolean) {
  const opts: Intl.DateTimeFormatOptions = allDay
    ? { day: 'numeric', month: 'long', timeZone: 'UTC' }
    : { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: ctx.tz };
  const date = typeof at === 'string' ? new Date(`${at}T00:00:00Z`) : at;
  return new Intl.DateTimeFormat(ctx.locale, opts).format(date);
}

async function prepareEvent(
  action: z.infer<typeof CreateEventAction>,
  ctx: MoreCtx,
): Promise<Prepared | string> {
  const { tx } = ctx;
  if (!(await isModuleEnabled(ctx.db, ctx.a.org.id, 'calendar'))) return tx.moduleOff;
  const who = ctx.resolvePeople(action.attendees ?? []);
  if ('error' in who) return who.error;
  const attendees = who.ids.filter((id) => id !== ctx.a.userId);
  const common = {
    title: action.title,
    location: action.location || null,
    attendee_ids: attendees,
  };
  const detailOf = (time: string) =>
    [time, attendees.length ? ctx.names(attendees) : null].filter(Boolean).join(' · ');

  // All day: "2030-01-15" (end exclusive, a single day ends the next day).
  if (isDay(action.start)) {
    const end = action.end && isDay(action.end) ? nextDay(action.end) : nextDay(action.start);
    if (end <= action.start) return tx.badTime.replace('{time}', action.start);
    return {
      kind: 'create_event',
      tool: 'ai_create_event',
      payload: { ...common, all_day: true, start: action.start, end, time_zone: ctx.tz },
      title: action.title,
      detail: detailOf(when(action.start, ctx, true)),
      location: action.location || null,
    };
  }
  const start = ctx.toUtc(action.start);
  if (!start || start.getTime() < Date.now() - 5 * 60_000) {
    return tx.badTime.replace('{time}', action.start);
  }
  const endAt = action.end ? ctx.toUtc(action.end) : null;
  const end =
    endAt && endAt > start
      ? endAt
      : new Date(start.getTime() + (action.duration_minutes ?? 60) * 60_000);
  return {
    kind: 'create_event',
    tool: 'ai_create_event',
    payload: {
      ...common,
      all_day: false,
      start: start.toISOString(),
      end: end.toISOString(),
      time_zone: ctx.tz,
    },
    title: action.title,
    detail: detailOf(`${when(start, ctx, false)}–${when(end, ctx, false).split(' ').at(-1)}`),
    location: action.location || null,
  };
}

const clipped = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * A message as the person: to a colleague (their direct conversation, opened on approval when
 * there is none) or to a group or channel they may write in.
 */
async function prepareMessage(
  action: z.infer<typeof SendMessageAction>,
  ctx: MoreCtx,
): Promise<Prepared | string> {
  const { tx } = ctx;
  if (!(await isModuleEnabled(ctx.db, ctx.a.org.id, 'chat'))) return tx.moduleOff;
  const title = clipped(action.text.replace(/\s+/g, ' '), 120);
  const person = ctx.resolvePeople([action.to]);
  if ('ids' in person && person.ids.length === 1 && person.ids[0] !== ctx.a.userId) {
    const name = ctx.names(person.ids);
    return {
      kind: 'send_message',
      tool: 'ai_send_message',
      payload: { user_id: person.ids[0], text: action.text },
      title,
      detail: tx.to.replace('{name}', name),
      location: name,
    };
  }
  const { items } = await listConversations(ctx.db, ctx.a, { q: action.to, limit: 20 });
  const writable = items.filter((c) => c.permissions.write);
  const exact = writable.filter((c) => fold(c.title) === fold(action.to));
  const conv = exact.length === 1 ? exact[0] : writable.length === 1 ? writable[0] : undefined;
  if (!conv) {
    // A name the person meant as something else: say what it really is.
    const pages = await findPages(ctx.db, ctx.a, action.to).catch(() => []);
    return pages.some((p) => fold(p.name) === fold(action.to))
      ? tx.notAConversation.replace('{name}', action.to)
      : tx.unknownConversation.replace('{name}', action.to);
  }
  return {
    kind: 'send_message',
    tool: 'ai_send_message',
    payload: { conversation_id: conv.id, text: action.text },
    title,
    detail: tx.to.replace('{name}', conv.title),
    location: conv.title,
  };
}

interface SpaceRef {
  id: string;
  name: string;
}

/**
 * Shared spaces where the person may add pages (the editor role), names for create_page; their
 * own space is the default. createPage checks the right again when the proposal is applied.
 */
export async function spacesOf(db: DbOrTx, a: DriveActor): Promise<SpaceRef[]> {
  if (!(await isModuleEnabled(db, a.org.id, 'wiki'))) return [];
  const ids = await reachableSpaceIds(db, a);
  if (!ids.length) return [];
  const rows = await db
    .select({ id: spaces.id, name: spaces.name })
    .from(spaces)
    .where(
      and(
        inArray(spaces.id, ids),
        eq(spaces.kind, 'shared'),
        isNull(spaces.archivedAt),
        isNull(spaces.deletedAt),
      ),
    )
    .orderBy(spaces.name)
    .limit(40);
  const editable = await Promise.all(
    rows.map(async (row) => {
      const { role } = await container(db, a, row.id, null).catch(() => ({ role: null }));
      return canDo(a, role, 'space.edit_content') ? row : null;
    }),
  );
  return editable.filter((x): x is SpaceRef => x !== null);
}

const firstLine = (md: string) =>
  clipped(
    md
      .replace(/[#>*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
    120,
  );

/** The space a name means among those the person may add pages to; none named = their own. */
export async function resolveSpace(
  name: string | null | undefined,
  ctx: MoreCtx,
): Promise<SpaceRef | string> {
  const { tx } = ctx;
  if (name?.trim()) {
    const list = await spacesOf(ctx.db, ctx.a);
    const exact = list.filter((x) => fold(x.name) === fold(name));
    const loose = list.filter((x) => fold(x.name).includes(fold(name)));
    return exact[0] ?? (loose.length === 1 ? loose[0]! : tx.unknownSpace.replace('{name}', name));
  }
  const id = await personalSpaceId(ctx.db, ctx.a.org.id, ctx.a.userId);
  return id ? { id, name: tx.mySpace } : tx.unknownSpace.replace('{name}', '—');
}

/** A new page in a space the person names, or in their own space. */
async function preparePage(
  action: z.infer<typeof CreatePageAction>,
  ctx: MoreCtx,
): Promise<Prepared | string> {
  const { tx } = ctx;
  if (!(await isModuleEnabled(ctx.db, ctx.a.org.id, 'wiki'))) return tx.moduleOff;
  const space = await resolveSpace(action.space, ctx);
  if (typeof space === 'string') return space;
  const text = action.text ?? '';
  return {
    kind: 'create_page',
    tool: 'ai_create_page',
    payload: { space_id: space.id, title: action.title, markdown: text, locale: ctx.locale },
    title: action.title,
    detail: text ? firstLine(text) : null,
    location: space.name,
  };
}

/** A note at the end of a page the person may edit, found by its title. */
async function prepareAppend(
  action: z.infer<typeof AppendPageAction>,
  ctx: MoreCtx,
): Promise<Prepared | string> {
  const { tx } = ctx;
  if (!(await isModuleEnabled(ctx.db, ctx.a.org.id, 'wiki'))) return tx.moduleOff;
  // By name, among the pages the person can see (Drive search: no wait for the search index).
  const { items } = await searchNodes(ctx.db, ctx.a, { q: action.page, type: 'page', limit: 10 });
  const titled = items.filter((h) => h.matchedIn === 'name');
  const exact = titled.filter((h) => fold(h.node.name) === fold(action.page));
  const hit = exact.length === 1 ? exact[0] : titled.length === 1 ? titled[0] : undefined;
  if (!hit) return tx.unknownPage.replace('{name}', action.page);
  // The right to edit the body (editor role, page not locked) now, and again when applying.
  const access = await loadPage(ctx.db, ctx.a, hit.node.id).catch(() => null);
  if (!access || !canEditBody(ctx.a, access)) {
    return tx.noAccess.replace('{title}', hit.node.name);
  }
  return {
    kind: 'append_page',
    tool: 'ai_append_page',
    payload: { node_id: hit.node.id, markdown: action.text },
    title: hit.node.name,
    detail: firstLine(action.text),
    location: hit.space.name,
  };
}

/** A proposal for one of the new kinds, or the sentence why it cannot be made. */
export async function prepareMore(action: MoreAction, ctx: MoreCtx): Promise<Prepared | string> {
  switch (action.type) {
    case 'create_event':
      return prepareEvent(action, ctx);
    case 'send_message':
      return prepareMessage(action, ctx);
    case 'create_page':
      return preparePage(action, ctx);
    case 'append_page':
      return prepareAppend(action, ctx);
    case 'extract_tasks':
      // Expanded into task proposals before this point.
      return ctx.tx.nothing;
  }
}

// ---------------------------------------------------------------------------------------
// Tasks from a conversation
// ---------------------------------------------------------------------------------------

/** Messages read for one extraction (the newest ones) and their size. */
const EXTRACT_MESSAGES = 80;
const EXTRACT_CHARS = 12_000;

const Extracted = z.object({
  summary: z.string().default(''),
  tasks: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        owner: z.string().trim().max(200).nullish(),
        due: z.string().nullish(),
      }),
    )
    .default([]),
});

/** The JSON of the extraction answer (tolerating a code fence); nothing when it is not JSON. */
export function parseExtracted(text: string): z.infer<typeof Extracted> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { summary: text.trim(), tasks: [] };
  try {
    const out = Extracted.safeParse(JSON.parse(text.slice(start, end + 1)));
    return out.success
      ? { ...out.data, tasks: out.data.tasks.slice(0, 8) }
      : { summary: '', tasks: [] };
  } catch {
    return { summary: '', tasks: [] };
  }
}

/**
 * The conversation's messages as the person sees them (membership, history and "Benim için sil"
 * by listMessages): the unread ones or the newest, oldest first, within a size limit.
 */
async function transcriptOf(
  db: DbOrTx,
  a: DriveActor,
  conversationId: string,
  scope: 'unread' | 'recent',
): Promise<ChatLine[]> {
  let afterSeq: number | undefined;
  if (scope === 'unread') {
    const [state] = await db
      .select({ seq: readStates.lastReadSeq })
      .from(readStates)
      .where(and(eq(readStates.conversationId, conversationId), eq(readStates.userId, a.userId)));
    afterSeq = state?.seq ?? undefined;
  }
  const page = await listMessages(db, a, conversationId, {
    ...(afterSeq !== undefined ? { afterSeq } : {}),
    limit: EXTRACT_MESSAGES,
  });
  const visible = page.items.filter((m) => m.kind !== 'system' && !m.deletedAt);
  const names = new Map<string, string>();
  for (const m of visible) if (m.author) names.set(m.author.id, m.author.name);
  const unknown = mentionedIds(visible.map((m) => m.text)).filter((id) => !names.has(id));
  if (unknown.length) {
    const rows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, unknown));
    for (const r of rows) names.set(r.id, r.name);
  }
  const lines: ChatLine[] = [];
  let size = 0;
  for (const m of [...visible].reverse()) {
    const text = plainText(m.text, names).trim();
    if (!text) continue;
    size += text.length + 40;
    if (size > EXTRACT_CHARS) break;
    lines.push({
      at: new Date(m.createdAt),
      author: m.author?.name ?? m.webhook?.name ?? '?',
      text,
    });
  }
  return lines.reverse();
}

export interface ExtractCtx {
  deps: Deps;
  caller: AiCaller;
  a: DriveActor;
  req: RequestInfo;
  config: ModelConfig;
  now: string;
  locale: Locale;
  tx: Sentences;
}

/**
 * "Sohbeti özetle, görevleri çıkar": reads the conversation (a group, a channel or the direct
 * conversation with a colleague) and turns its tasks into plan actions for the person's to-do
 * list or a board. The summary goes into the answer. One more model run, counted to the quota.
 */
export async function expandExtract(
  action: z.infer<typeof ExtractTasksAction>,
  ctx: ExtractCtx,
): Promise<{ summary: string; actions: unknown[]; none?: string } | string> {
  const { tx } = ctx;
  if (!(await isModuleEnabled(ctx.deps.db, ctx.a.org.id, 'chat'))) return tx.moduleOff;
  const { items } = await listConversations(ctx.deps.db, ctx.a, {
    q: action.conversation,
    limit: 20,
  });
  const exact = items.filter((c) => fold(c.title) === fold(action.conversation));
  const conv = exact.length === 1 ? exact[0] : items.length === 1 ? items[0] : undefined;
  if (!conv) {
    // "Yapılacaklar Listesi" is no conversation: a page by that name is what was meant.
    const pages = await findPages(ctx.deps.db, ctx.a, action.conversation).catch(() => []);
    if (pages.length) {
      return {
        summary: '',
        actions: [{ type: 'page_to_tasks', page: action.conversation, target: action.target }],
      };
    }
    return tx.unknownConversation.replace('{name}', action.conversation);
  }
  const lines = await transcriptOf(ctx.deps.db, ctx.a, conv.id, action.scope ?? 'recent');
  if (!lines.length) return tx.nothingToRead.replace('{name}', conv.title);

  const out = await executeRun(
    ctx.deps,
    ctx.caller,
    {
      kind: 'model',
      action: 'act',
      config: ctx.config,
      prompt: extractTasksPrompt(lines, {
        conversation: conv.title,
        now: ctx.now,
        locale: ctx.locale,
      }),
      target: { type: 'conversation', id: conv.id },
      messages: lines.length,
    },
    ctx.req,
    {},
  );
  const found = parseExtracted(out.text);
  if (!found.tasks.length) {
    return found.summary
      ? { summary: found.summary, actions: [], none: tx.noTasks.replace('{name}', conv.title) }
      : tx.noTasks.replace('{name}', conv.title);
  }
  const target = action.target?.trim() ?? '';
  const toTodo = !target || /^(todo|yapılacak(lar|larım)?|to-?do)$/i.test(target);
  const actions = found.tasks.map((task) =>
    toTodo
      ? {
          type: 'add_todo_item',
          todo_card: null,
          text: task.owner ? `${task.title} (${task.owner})` : task.title,
          due: task.due ?? null,
        }
      : {
          type: 'create_card',
          board: target,
          title: task.title,
          due: task.due ?? null,
          assignees: task.owner ? [task.owner] : [],
        },
  );
  return { summary: found.summary, actions };
}

/** Groups and channels the person may write in, newest first: names the model may use. */
export async function writableConversations(db: DbOrTx, a: DriveActor, max = 15) {
  if (!(await isModuleEnabled(db, a.org.id, 'chat'))) return [];
  const { items } = await listConversations(db, a, { limit: 60 });
  return items
    .filter((c) => c.type !== 'direct' && c.permissions.write && c.title)
    .slice(0, max)
    .map((c) => c.title);
}

// ---------------------------------------------------------------------------------------
// After approval
// ---------------------------------------------------------------------------------------

interface ApplyResult {
  result: Record<string, unknown>;
}

async function person(db: DbOrTx, userId: string) {
  const [u] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!u) throw new AppError('not_found');
  return u;
}

const EventPayload = z.object({
  title: z.string(),
  location: z.string().nullable(),
  attendee_ids: z.array(z.uuid()),
  all_day: z.boolean(),
  start: z.string(),
  end: z.string(),
  time_zone: z.string(),
});

const MessagePayload = z.union([
  z.object({ conversation_id: z.uuid(), text: z.string() }),
  z.object({ user_id: z.uuid(), text: z.string() }),
]);

const PagePayload = z.object({
  space_id: z.uuid(),
  title: z.string(),
  markdown: z.string(),
  locale: z.enum(['tr', 'en']).default('tr'),
});

const AppendPayload = z.object({ node_id: z.uuid(), markdown: z.string() });

/** Appliers of the new kinds, by tool name (merged into AI_APPLIERS). */
export const MORE_APPLIERS: Record<
  string,
  (live: Deps, a: DriveActor, payload: Record<string, unknown>) => Promise<ApplyResult>
> = {
  async ai_create_event(live, a, payload) {
    const p = EventPayload.parse(payload);
    const me = await person(live.db, a.userId);
    const cal = { ...a, userName: me.name, userEmail: me.email };
    // In the person's own calendar; createEvent checks the right to write there again.
    const calendar = await personalCalendar(live.db, cal);
    const event = await createEvent(
      live,
      cal,
      CreateCalendarEvent.parse({
        calendarId: calendar.id,
        title: p.title,
        location: p.location,
        allDay: p.all_day,
        start: p.start,
        end: p.end,
        timeZone: p.time_zone,
        attendees: { userIds: p.attendee_ids, emails: [] },
      }),
    );
    return {
      result: {
        event_id: event.id,
        path: withQuery(paths.calendar(), {
          event: event.seriesId ?? event.id,
          date: p.start.slice(0, 10),
        }),
      },
    };
  },
  async ai_send_message(live, a, payload) {
    const p = MessagePayload.parse(payload);
    // A direct conversation is opened (or found) only now, after the approval.
    const conversationId =
      'conversation_id' in p
        ? p.conversation_id
        : (await createConversation(live, a, { type: 'direct', userId: p.user_id })).id;
    // sendMessage checks membership and the right to write again.
    const { msg } = await deliverMessage(
      live,
      a,
      { conversation_id: conversationId, text: p.text },
      { kind: 'ai', client: 'Crewhall AI' },
    );
    return {
      result: {
        conversation_id: conversationId,
        message_id: msg.id,
        seq: msg.seq,
        path: paths.chatConversation(conversationId),
      },
    };
  },
  async ai_create_page(live, a, payload) {
    const p = PagePayload.parse(payload);
    // createPage checks the right to add content to the space again.
    const page = await createPage(
      live,
      a,
      p.space_id,
      { parentId: null, name: p.title, markdown: p.markdown },
      { source: 'api', locale: p.locale },
    );
    return { result: { node_id: page.id, path: pagePath({ id: page.id, name: page.name }) } };
  },
  async ai_append_page(live, a, payload) {
    const p = AppendPayload.parse(payload);
    const access = await loadPage(live.db, a, p.node_id);
    if (!canEditBody(a, access)) throw new AppError('forbidden');
    await editPage(live, p.node_id, {
      op: 'append',
      doc: markdownToDoc(p.markdown),
      userId: a.userId,
      source: 'api',
    });
    return {
      result: {
        node_id: p.node_id,
        path: pagePath({ id: access.node.id, name: access.node.name }),
      },
    };
  },
};
