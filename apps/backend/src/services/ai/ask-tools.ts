import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { surfaceCards, surfaces, users, type DbOrTx } from '@crewhall/db';
import {
  ContactQuery,
  DirectoryQuery,
  MailMessagesQuery,
  OccurrencesQuery,
  TodoConfig,
  type AiSearchHit,
  type AiSearchKind,
  type ModuleKey,
  type NodeType,
  can,
  paths,
  withQuery,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { myCards } from '../boards/cards';
import { listOccurrences } from '../calendar/occurrences';
import { unreadSummary } from '../chat/conversations';
import { listContacts } from '../contacts/contacts';
import { listDirectory } from '../contacts/directory';
import { searchNodes } from '../drive/personal';
import { isModuleEnabled } from '../identity/modules';
import { requireMailbox } from '../mail/accounts';
import { listMessages as listMail } from '../mail/messages';
import { listHistory, listMeetings } from '../meet/meetings';
import { orgContext } from '../membership';
import { searchTableRows } from '../tables/ask';
import { localToUtc } from './actions';
import { homeCards, homeCardsText, pageMarkdown, resolvePage } from './assistant-data';
import { transcriptState } from './meeting';
import type { ModelTool, ToolCall } from './providers';
import type { AiCaller } from './run';

/**
 * Read-only tools of "Crewhall'a sor": live, structured data the search index does not hold
 * (the calendar, assigned work, past meetings, unread chats, people, table rows). The model asks for them
 * by function calling; each one runs as the asker through the module's own service, so it sees
 * exactly what the person sees in the app. The vault is never read. Every item found becomes a
 * numbered source the answer cites and the panel links to.
 */

export type AskToolName =
  | 'upcoming_events'
  | 'my_tasks'
  | 'recent_meetings'
  | 'unread_summary'
  | 'search_people'
  | 'search_files'
  | 'unread_mail'
  | 'search_tables'
  | 'home_cards'
  | 'read_page';

const TOOLS: Record<AskToolName, ModelTool & { modules: ModuleKey[] }> = {
  upcoming_events: {
    name: 'upcoming_events',
    description: 'Calendar events and meetings of the person (default: the next 7 days).',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'First day YYYY-MM-DD' },
        to: { type: 'string', description: 'Last day YYYY-MM-DD' },
        query: { type: 'string', description: 'Title words' },
      },
    },
    modules: ['calendar', 'meet'],
  },
  my_tasks: {
    name: 'my_tasks',
    description: 'Open board cards assigned to the person and open home to-do items.',
    parameters: {
      type: 'object',
      properties: {
        due: { type: 'string', enum: ['any', 'overdue', 'soon'], description: 'soon: 3 days' },
      },
    },
    modules: [],
  },
  recent_meetings: {
    name: 'recent_meetings',
    description: 'Past meetings, newest first, with summary and decisions when noted.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '1-10, default 5' } },
    },
    modules: ['meet'],
  },
  unread_summary: {
    name: 'unread_summary',
    description: 'Chats with unread messages and mention counts.',
    parameters: { type: 'object', properties: {} },
    modules: ['chat'],
  },
  search_people: {
    name: 'search_people',
    description: 'Colleagues and outside contacts by name, company, team or role.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search words' } },
      required: ['query'],
    },
    modules: ['contacts'],
  },
  search_files: {
    name: 'search_files',
    description: 'Files, folders and pages in Drive by name.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name words' },
        type: { type: 'string', enum: ['any', 'file', 'folder', 'page'] },
      },
      required: ['query'],
    },
    modules: [],
  },
  unread_mail: {
    name: 'unread_mail',
    description: "Unread messages in the person's mail inbox: sender, subject, date.",
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '1-15, default 10' } },
    },
    modules: ['mail'],
  },
  search_tables: {
    name: 'search_tables',
    description:
      'Rows of the space tables (CRM, inventory, hiring, assets…) the person can see, by words or a table name.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search words or a table name' } },
      required: ['query'],
    },
    modules: ['tables'],
  },
  home_cards: {
    name: 'home_cards',
    description:
      "Every card on the person's home page with what is on it: to-do cards and their items, notes, link lists.",
    parameters: { type: 'object', properties: {} },
    modules: [],
  },
  read_page: {
    name: 'read_page',
    description: 'The body of a wiki page, found by its title, optionally within a space.',
    parameters: {
      type: 'object',
      properties: {
        page: { type: 'string', description: "The page's title" },
        space: { type: 'string', description: 'A space name' },
      },
      required: ['page'],
    },
    modules: ['wiki'],
  },
};

const NAMES = Object.keys(TOOLS) as AskToolName[];
export const isAskTool = (name: string): name is AskToolName => NAMES.includes(name as AskToolName);

/** The tools of the modules this org has on (my_tasks needs boards or the home page only). */
export async function availableTools(db: DbOrTx, orgId: string): Promise<ModelTool[]> {
  const out: ModelTool[] = [];
  for (const name of NAMES) {
    const { modules, ...tool } = TOOLS[name];
    const on = await Promise.all(modules.map((m) => isModuleEnabled(db, orgId, m)));
    // A tool with several modules needs one of them (the calendar or meetings).
    if (modules.length === 0 || on.some(Boolean)) out.push(tool);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Without function calling: the question's intent picks the tools
// ---------------------------------------------------------------------------------------

const INTENTS: [AskToolName, RegExp][] = [
  [
    'upcoming_events',
    /toplant|takvim|etkinlik|randevu|bugün|yarın|bu hafta|haftaya|meeting|calendar|event|appointment|today|tomorrow|this week|schedule/i,
  ],
  [
    'my_tasks',
    /görev|iş(ler|im)|atanmış|atanan|yapılacak|teslim|son tarih|bugün ne var|task|assigned|to-?do|deadline|due|what.*today/i,
  ],
  [
    'recent_meetings',
    /(geçen|son|önceki|dünkü) toplant|karar|tutanak|last meeting|past meeting|decided|minutes/i,
  ],
  ['unread_summary', /okunmamış|okumadığım|yeni mesaj|mesajlar|unread|new messages/i],
  [
    'search_tables',
    /tablo|kayıt|satır|envanter|stok|demirbaş|müşteri|aday|başvuru|table|record|row|inventory|stock|asset|customer|candidate/i,
  ],
  [
    'search_people',
    /kim(dir)?\b|telefon|numara|e-?posta adresi|rehber|iletişim|who is|phone|email of|contact/i,
  ],
  ['search_files', /dosya|klasör|belge|sunum|excel|pdf|nerede|file|folder|document|where is/i],
  ['unread_mail', /posta|e-?mail|mail(ler)?im|gelen kutu|inbox/i],
  [
    'home_cards',
    /ana ?sayfa|kart(ım|ımda|larım)|yapılacaklar kart|home page|my cards|to-?do card/i,
  ],
];

/** Words that only say what is asked, not what to look for. */
const STOP =
  /^(kim|kimdir|telefon|numara|numarası|who|is|the|dosya|dosyası|dosyasını|klasör|klasörü|nerede|where|file|folder|bul|göster|hangi|bir|ve)$/i;

/**
 * For models without function calling (some own servers): the tools the question plainly asks
 * for. "Kim" questions search people by the question's longest words.
 */
export function toolsForIntent(question: string, available: ModelTool[]): ToolCall[] {
  const names = new Set(available.map((t) => t.name));
  const calls: ToolCall[] = [];
  for (const [name, re] of INTENTS) {
    if (!names.has(name) || !re.test(question)) continue;
    if (name === 'search_tables') {
      calls.push({ name, args: { query: question.slice(0, 200) } });
      continue;
    }
    if (name === 'search_people' || name === 'search_files') {
      const words = question
        .replace(/[?!.,;:'’"]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.test(w))
        .sort((a, b) => b.length - a.length);
      if (words[0]) calls.push({ name, args: { query: words[0] } });
      continue;
    }
    calls.push({ name, args: {} });
  }
  return calls;
}

// ---------------------------------------------------------------------------------------
// Running the tools
// ---------------------------------------------------------------------------------------

/** One item a tool found: what the model reads, and the source the panel links to. */
export interface LiveSource {
  hit: Omit<AiSearchHit, 'updatedAt'> & { updatedAt: string };
  text: string;
}

/** What one tool call did, for the model: what was checked and what came back. */
export interface ToolRun {
  name: AskToolName;
  checked: string;
  sources: LiveSource[];
}

/** Items per tool: enough to answer, short enough to keep the answer cheap. */
const MAX = {
  pageChars: 6_000,
  events: 8,
  cards: 10,
  todos: 10,
  meetings: 5,
  unread: 8,
  people: 5,
  files: 8,
  mail: 10,
  rows: 10,
};

function hit(
  kind: AiSearchKind,
  refId: string,
  title: string,
  extra: Partial<AiSearchHit> = {},
): LiveSource['hit'] {
  return {
    kind,
    refId,
    title,
    snippet: extra.snippet ?? '',
    nodeId: null,
    spaceId: null,
    conversationId: null,
    seq: null,
    boardId: null,
    cardNumber: null,
    updatedAt: new Date().toISOString(),
    path: null,
    at: null,
    ...extra,
  };
}

/** "2026-10-24 14:00, Saturday" in the person's zone (dates only for all-day items). */
function localTime(iso: string, tz: string, dateOnly = false) {
  if (dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(d);
  if (dateOnly) return `${day}, ${weekday}`;
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  return `${day} ${time}, ${weekday}`;
}

const today = (tz: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const DAY = 86_400_000;
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const fold = (s: string) => s.toLocaleLowerCase('tr');

interface Ctx {
  deps: Deps;
  caller: AiCaller;
  tz: string;
  email: string;
}

async function upcomingEvents(c: Ctx, args: Record<string, unknown>): Promise<ToolRun> {
  const fromDay = isDate(args.from) ? args.from : null;
  const toDay = isDate(args.to) ? args.to : null;
  const now = new Date();
  // From the start of `from` (or now), to the end of `to` (or 7 days on); at most 62 days.
  const from = fromDay ? (localToUtc(`${fromDay}T00:00`, c.tz) ?? now) : now;
  let to = toDay
    ? new Date((localToUtc(`${toDay}T00:00`, c.tz) ?? now).getTime() + DAY)
    : new Date(from.getTime() + 7 * DAY);
  if (to.getTime() <= from.getTime()) to = new Date(from.getTime() + DAY);
  if (to.getTime() - from.getTime() > 62 * DAY) to = new Date(from.getTime() + 62 * DAY);
  const query = typeof args.query === 'string' ? fold(args.query.trim()) : '';
  const checked = `upcoming_events ${localTime(from.toISOString(), c.tz)} → ${localTime(to.toISOString(), c.tz)}${query ? ` "${query}"` : ''}`;
  const { db } = c.deps;
  const a = { org: c.caller.org, actor: c.caller.actor, userId: c.caller.userId };
  const [calendarOn, meetOn] = await Promise.all([
    isModuleEnabled(db, a.org.id, 'calendar'),
    isModuleEnabled(db, a.org.id, 'meet'),
  ]);

  const sources: LiveSource[] = [];
  if (calendarOn) {
    const { items } = await listOccurrences(
      db,
      { ...a, userName: c.caller.userName, userEmail: c.email },
      OccurrencesQuery.parse({
        from: from.toISOString(),
        to: to.toISOString(),
        meetings: meetOn ? 'true' : 'false',
        cards: 'false',
      }),
    );
    for (const o of items) {
      if (o.hidden || !o.title) continue;
      if (query && !fold(o.title).includes(query)) continue;
      if (Date.parse(o.end) < now.getTime() && !o.allDay) continue;
      const startDay = o.start.slice(0, 10);
      const meeting = o.source === 'meeting';
      sources.push({
        hit: hit(meeting ? 'meeting' : 'event', o.sourceId, o.title, {
          snippet: o.location ?? '',
          at: o.allDay ? new Date(`${startDay}T00:00:00Z`).toISOString() : o.start,
          path: o.url ?? withQuery(paths.calendar(), { event: o.sourceId, date: startDay }),
        }),
        text: [
          `${meeting ? 'Meeting' : 'Event'}: ${o.title}`,
          o.allDay
            ? `All day ${localTime(o.start, c.tz, true)}`
            : `${localTime(o.start, c.tz)} to ${localTime(o.end, c.tz)}`,
          o.location ? `Location: ${o.location}` : null,
          o.myResponse ? `Your response: ${o.myResponse}` : null,
          o.flag === 'live' ? 'Happening now' : null,
        ]
          .filter(Boolean)
          .join(' · '),
      });
      if (sources.length >= MAX.events) break;
    }
  } else if (meetOn) {
    const { items } = await listMeetings(
      c.deps,
      { ...a, userName: c.caller.userName },
      { view: 'upcoming', limit: 50 },
    );
    for (const m of items) {
      if (!m.startsAt) continue;
      const at = Date.parse(m.startsAt);
      if (at < from.getTime() || at >= to.getTime()) continue;
      if (query && !fold(m.title).includes(query)) continue;
      sources.push({
        hit: hit('meeting', m.id, m.title, {
          at: m.startsAt,
          path: paths.meetingRoom(m.slug),
        }),
        text: `Meeting: ${m.title} · ${localTime(m.startsAt, c.tz)} · ${m.durationMinutes ?? 30} min ${m.host ? ` · host ${m.host.name}` : ''}`,
      });
      if (sources.length >= MAX.events) break;
    }
  }
  return { name: 'upcoming_events', checked, sources };
}

async function myTasks(c: Ctx, args: Record<string, unknown>): Promise<ToolRun> {
  const due = args.due === 'overdue' || args.due === 'soon' ? args.due : 'any';
  const { db } = c.deps;
  const a = { org: c.caller.org, actor: c.caller.actor, userId: c.caller.userId };
  const sources: LiveSource[] = [];
  const now = Date.now();

  if (await isModuleEnabled(db, a.org.id, 'boards')) {
    const { items } = await myCards(db, a, {
      scope: due === 'any' ? 'assigned' : 'due',
      limit: 50,
    });
    for (const card of items) {
      if (due === 'overdue' && !(card.dueAt && Date.parse(card.dueAt) < now)) continue;
      const ref = `${card.board.key}-${card.number}`;
      sources.push({
        hit: hit('card', card.id, `${ref} ${card.title}`, {
          boardId: card.board.id,
          cardNumber: card.number,
          spaceId: card.board.spaceId,
          at: card.dueAt,
          path: paths.boardCard(card.board.id, ref),
        }),
        text: [
          `Board card ${ref}: ${card.title}`,
          `Board: ${card.board.name}, column: ${card.column.name}`,
          card.dueAt ? `Due ${localTime(card.dueAt, c.tz)}` : 'No due date',
          card.dueAt && Date.parse(card.dueAt) < now ? 'OVERDUE' : null,
          card.priority ? `Priority: ${card.priority}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      });
      if (sources.length >= MAX.cards) break;
    }
  }

  // To-do items have no due date, so they belong to "any" only.
  if (due === 'any') {
    const lists = await db
      .select({ id: surfaceCards.id, config: surfaceCards.config })
      .from(surfaceCards)
      .innerJoin(surfaces, eq(surfaces.id, surfaceCards.surfaceId))
      .where(
        and(
          eq(surfaces.orgId, a.org.id),
          eq(surfaces.ownerType, 'user'),
          eq(surfaces.ownerId, a.userId),
          eq(surfaceCards.type, 'todo'),
          isNull(surfaceCards.pinnedFromCardId),
          isNull(surfaceCards.deletedAt),
        ),
      );
    let todos = 0;
    for (const list of lists) {
      const config = TodoConfig.safeParse(list.config);
      if (!config.success) continue;
      for (const item of config.data.items) {
        if (item.done || todos >= MAX.todos) continue;
        todos++;
        sources.push({
          hit: hit('todo', item.id, item.text, { snippet: config.data.title, path: '/' }),
          text: `To-do item on the home page list "${config.data.title}": ${item.text}`,
        });
      }
    }
  }
  return { name: 'my_tasks', checked: `my_tasks due=${due}`, sources };
}

async function recentMeetings(c: Ctx, args: Record<string, unknown>): Promise<ToolRun> {
  const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
  const a = {
    org: c.caller.org,
    actor: c.caller.actor,
    userId: c.caller.userId,
    userName: c.caller.userName,
  };
  const { items } = await listHistory(c.deps, a, { limit });
  const sources: LiveSource[] = [];
  for (const s of items.slice(0, MAX.meetings)) {
    const notes: string[] = [];
    for (const r of s.recordings) {
      // The notes come with the recording: whoever cannot open the file does not get them.
      const state = await transcriptState(c.deps, c.caller, r.id).catch(() => null);
      const t = state?.transcript;
      if (t?.status !== 'ready') continue;
      if (t.summary) notes.push(`Summary: ${t.summary}`);
      if (t.decisions.length) notes.push(`Decisions: ${t.decisions.join('; ')}`);
    }
    sources.push({
      hit: hit('meeting', s.id, s.title, {
        spaceId: s.spaceId,
        at: s.startedAt,
        path: paths.meetingSummary(s.id),
      }),
      text: [
        `Past meeting: ${s.title}`,
        `${localTime(s.startedAt, c.tz)}, ${Math.round((s.durationSeconds ?? 0) / 60)} min`,
        s.participants.length
          ? `Participants: ${s.participants.map((p) => p.name).join(', ')}`
          : null,
        ...notes,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  return { name: 'recent_meetings', checked: `recent_meetings limit=${limit}`, sources };
}

async function unread(c: Ctx): Promise<ToolRun> {
  const a = { org: c.caller.org, actor: c.caller.actor, userId: c.caller.userId };
  const conversations = await unreadSummary(c.deps.db, a);
  const now = Date.now();
  const open = conversations
    .filter((v) => {
      const muted = v.my.mutedUntil && Date.parse(v.my.mutedUntil) > now;
      return v.my.unread > 0 && (!muted || v.my.unreadMentions > 0);
    })
    .sort((x, y) => y.my.unreadMentions - x.my.unreadMentions || y.my.unread - x.my.unread);
  const total = open.reduce((n, v) => n + v.my.unread, 0);
  return {
    name: 'unread_summary',
    checked: `unread_summary: ${open.length} conversations, ${total} unread messages in total`,
    sources: open.slice(0, MAX.unread).map((v) => ({
      hit: hit('message', v.id, v.title, {
        conversationId: v.id,
        at: v.lastMessageAt,
        path: paths.chatConversation(v.id),
      }),
      text: `Conversation "${v.title}": ${v.my.unread} unread${v.my.unreadMentions ? `, ${v.my.unreadMentions} mentioning you` : ''}${v.lastMessageAt ? `, last message ${localTime(v.lastMessageAt, c.tz)}` : ''}`,
    })),
  };
}

async function people(c: Ctx, args: Record<string, unknown>): Promise<ToolRun> {
  const query = typeof args.query === 'string' ? args.query.trim().slice(0, 100) : '';
  if (!query) return { name: 'search_people', checked: 'search_people (no query)', sources: [] };
  const a = {
    org: c.caller.org,
    actor: c.caller.actor,
    userId: c.caller.userId,
    userName: c.caller.userName,
    userEmail: c.email,
  };
  const sources: LiveSource[] = [];
  // Each list checks its own right (directory.read, contacts membership); a refusal is empty.
  const directory = await listDirectory(
    c.deps.db,
    a,
    DirectoryQuery.parse({ q: query, limit: MAX.people }),
  ).catch(() => ({ items: [] }));
  for (const p of directory.items) {
    sources.push({
      hit: hit('person', p.user.id, p.user.name, {
        snippet: [p.title, p.department].filter(Boolean).join(' · '),
        path: paths.person(p.user.id),
      }),
      text: [
        `Colleague: ${p.user.name}`,
        p.title,
        p.department,
        p.team,
        `Email: ${p.user.email}`,
        p.phone ? `Phone: ${p.phone}` : null,
        p.mobile ? `Mobile: ${p.mobile}` : null,
        p.location,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  const contacts = await listContacts(
    c.deps.db,
    a,
    ContactQuery.parse({ q: query, limit: MAX.people }),
  ).catch(() => ({ items: [] }));
  for (const p of contacts.items) {
    sources.push({
      hit: hit('contact', p.id, p.displayName, {
        snippet: [p.jobTitle, p.company?.name].filter(Boolean).join(' · '),
        path: paths.contactsPeople(),
      }),
      text: [
        `Outside contact: ${p.displayName}`,
        p.jobTitle,
        p.company?.name,
        p.emails.length ? `Email: ${p.emails.map((e) => e.value).join(', ')}` : null,
        p.phones.length ? `Phone: ${p.phones.map((e) => e.value).join(', ')}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  return { name: 'search_people', checked: `search_people "${query}"`, sources };
}

/** Node types the panel can open, as source kinds. */
const KIND_OF_NODE: Partial<Record<NodeType, AiSearchKind>> = {
  file: 'file',
  folder: 'folder',
  page: 'page',
  board: 'board',
  drawing: 'drawing',
};

/** Drive items by name, only where the person can see them (Drive's own search). */
async function files(c: Ctx, args: Record<string, unknown>): Promise<ToolRun> {
  const query = typeof args.query === 'string' ? args.query.trim().slice(0, 100) : '';
  if (!query) return { name: 'search_files', checked: 'search_files (no query)', sources: [] };
  const type =
    args.type === 'file' || args.type === 'folder' || args.type === 'page' ? args.type : undefined;
  const a = { org: c.caller.org, actor: c.caller.actor, userId: c.caller.userId };
  const { items } = await searchNodes(c.deps.db, a, { q: query, type, limit: MAX.files });
  const sources: LiveSource[] = [];
  for (const h of items) {
    const kind = KIND_OF_NODE[h.node.type];
    if (!kind) continue;
    const where = [h.space.name, ...h.path.map((p) => p.name)].join(' › ');
    sources.push({
      hit: hit(kind, h.node.id, h.node.name, {
        snippet: where,
        nodeId: h.node.id,
        spaceId: h.node.spaceId,
      }),
      text: `${kind === 'folder' ? 'Folder' : kind === 'page' ? 'Page' : 'File'}: ${h.node.name} · in ${where} · updated ${localTime(h.node.updatedAt, c.tz, true)}`,
    });
  }
  return { name: 'search_files', checked: `search_files "${query}"`, sources };
}

/** The person's own home page, card by card. The vault's cards are never read. */
async function homeCardsTool(c: Ctx): Promise<ToolRun> {
  const a = { org: c.caller.org, actor: c.caller.actor, userId: c.caller.userId };
  const cards = await homeCards(c.deps.db, a);
  return {
    name: 'home_cards',
    checked: 'home_cards',
    sources: cards.map((card) => ({
      hit: hit('todo', card.id, card.title || card.type, {
        snippet: card.lines.slice(0, 3).join(' · '),
        path: paths.home(),
      }),
      text: homeCardsText([card]),
    })),
  };
}

/** A page's body, by its title, with the person's rights. */
async function readPageTool(c: Ctx, args: Record<string, unknown>): Promise<ToolRun> {
  const page = typeof args.page === 'string' ? args.page.trim().slice(0, 200) : '';
  if (!page) return { name: 'read_page', checked: 'read_page (no title)', sources: [] };
  const space = typeof args.space === 'string' ? args.space : null;
  const a = { org: c.caller.org, actor: c.caller.actor, userId: c.caller.userId };
  const match = await resolvePage(c.deps.db, a, page, space);
  const checked = `read_page "${page}"`;
  if (!match) return { name: 'read_page', checked: `${checked} (no such page)`, sources: [] };
  const pages = 'candidates' in match ? match.candidates.slice(0, 3) : [match.page];
  const sources: LiveSource[] = [];
  for (const p of pages) {
    const body = await pageMarkdown(c.deps.db, a, p.id);
    sources.push({
      hit: hit('page', p.id, p.name, { snippet: body.slice(0, 160), nodeId: p.id }),
      text: `Page: ${p.name} · in ${p.space}\n${body.slice(0, MAX.pageChars) || '(the page is empty)'}`,
    });
  }
  return { name: 'read_page', checked, sources };
}

/**
 * The newest unread messages of the person's own inbox: sender, subject and date only (reading
 * bodies would open every message and could mark it read). Mail is the person's own; guests and
 * people without the directory right have no mail.
 */
async function unreadMail(c: Ctx, args: Record<string, unknown>): Promise<ToolRun> {
  const limit = Math.min(15, Math.max(1, Number(args.limit) || MAX.mail));
  const { actor, org } = c.caller;
  if (
    actor.orgRole === 'guest' ||
    !can(actor, 'org.view_directory', { type: 'org', org: orgContext(org) })
  ) {
    return { name: 'unread_mail', checked: 'unread_mail (no mail for this person)', sources: [] };
  }
  const mailbox = await requireMailbox(c.deps, org.id, c.caller.userId).catch(() => null);
  if (!mailbox) {
    return { name: 'unread_mail', checked: 'unread_mail (no mail account set up)', sources: [] };
  }
  const { items } = await listMail(
    c.deps,
    mailbox,
    MailMessagesQuery.parse({ folder: 'INBOX', unread: 'true', limit }),
  );
  return {
    name: 'unread_mail',
    checked: `unread_mail: ${items.length} newest unread`,
    sources: items.map((m) => {
      const from = m.from
        ? m.from.name
          ? `${m.from.name} <${m.from.address}>`
          : m.from.address
        : '?';
      return {
        hit: hit('mail', randomUUID(), m.subject || '—', {
          snippet: m.from?.name ?? m.from?.address ?? '',
          at: m.date,
          path: withQuery(paths.mail(), { folder: m.folder, uid: m.uid }),
        }),
        text: `Unread mail from ${from}: "${m.subject}"${m.date ? ` · ${localTime(m.date, c.tz)}` : ''}${m.hasAttachments ? ' · with attachments' : ''}`,
      };
    }),
  };
}

async function tableRows(c: Ctx, args: Record<string, unknown>): Promise<ToolRun> {
  const query = typeof args.query === 'string' ? args.query.trim().slice(0, 200) : '';
  if (!query) return { name: 'search_tables', checked: 'search_tables (no query)', sources: [] };
  const a = { org: c.caller.org, actor: c.caller.actor, userId: c.caller.userId };
  const rows = await searchTableRows(c.deps.db, a, query, MAX.rows);
  return {
    name: 'search_tables',
    checked: `search_tables "${query}": ${rows.length} rows`,
    sources: rows.map((r) => ({
      hit: hit('row', r.rowId, r.title || r.tableName, {
        snippet: r.tableName,
        spaceId: r.spaceId,
        path: r.url,
      }),
      text: `Table "${r.tableName}" row "${r.title}": ${r.text}`,
    })),
  };
}

/**
 * Runs the calls (known tools only, each at most once) as the asker. A failing tool is reported
 * as empty instead of failing the answer.
 */
export async function runTools(
  deps: Deps,
  caller: AiCaller,
  calls: ToolCall[],
  tz: string,
): Promise<ToolRun[]> {
  const known = calls.filter(
    (x, i) => isAskTool(x.name) && calls.findIndex((y) => y.name === x.name) === i,
  );
  if (!known.length) return [];
  const [me] = await deps.db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, caller.userId));
  const ctx: Ctx = { deps, caller, tz, email: me?.email ?? '' };
  return Promise.all(
    known.map(async (call): Promise<ToolRun> => {
      const name = call.name as AskToolName;
      try {
        switch (name) {
          case 'upcoming_events':
            return await upcomingEvents(ctx, call.args);
          case 'my_tasks':
            return await myTasks(ctx, call.args);
          case 'recent_meetings':
            return await recentMeetings(ctx, call.args);
          case 'unread_summary':
            return await unread(ctx);
          case 'search_people':
            return await people(ctx, call.args);
          case 'search_files':
            return await files(ctx, call.args);
          case 'unread_mail':
            return await unreadMail(ctx, call.args);
          case 'search_tables':
            return await tableRows(ctx, call.args);
          case 'home_cards':
            return await homeCardsTool(ctx);
          case 'read_page':
            return await readPageTool(ctx, call.args);
        }
      } catch (err) {
        deps.logger.warn({ err, tool: name }, 'ask tool failed');
        return { name, checked: `${name} (not available)`, sources: [] };
      }
    }),
  );
}

export { today as todayIn };
