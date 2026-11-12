import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  approvalRequests,
  boardCards,
  boards,
  cardAssignees,
  nodes,
  orgMembers,
  surfaceCards,
  users,
  type DbOrTx,
} from '@crewhall/db';
import { resolveLocale, resources } from '@crewhall/i18n';
import {
  AiActRequest,
  CreateBoardCard,
  CreateMeeting,
  MCP_LIMITS,
  TodoConfig,
  type AiActProposal,
  type AiActResult,
  type Locale,
} from '@crewhall/shared';
import { z } from 'zod';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { createCard, setAssignees } from '../boards/cards';
import { inBoardsTx } from '../boards/integrations';
import { loadNode, reachableSpaceIds, type DriveActor } from '../drive/access';
import { isModuleEnabled } from '../identity/modules';
import { createMeeting } from '../meet/meetings';
import { updateCard as updateSurfaceCard } from '../quick/surfaces';
import {
  MORE_ACTIONS,
  MORE_APPLIERS,
  MORE_TYPES,
  expandExtract,
  prepareMore,
  spacesOf,
  writableConversations,
  type MoreAction,
  type Prepared,
  type Sentences,
} from './act-tools';
import { parseReads, runReads, type AssistantRead } from './act-reads';
import {
  prepareTransfer,
  TRANSFER_ACTIONS,
  TRANSFER_APPLIERS,
  TRANSFER_TYPES,
  type TransferAction,
} from './act-transfer';
import { findTodoCard, fold, openItems, todoCardsOf, type TodoCard } from './assistant-data';
import { aiAudit } from './audit';
import { actPrompt, type ActContext } from './prompts';
import { executeRun, usableSettings, type AiCaller } from './run';
import { modelConfigOf } from './settings';

/**
 * Eylem yapan asistan (yol haritası #18). The model first reads what it needs (act-reads.ts) and
 * then turns the request, in the light of the conversation so far, into a small JSON plan; the
 * server resolves its references (people, boards, cards, pages) with the asker's own rights and
 * files each action into the MCP approval queue (`approval_requests`, action `ai.action`).
 * Nothing changes until the person approves it, here or in Hesabım › Onay bekleyenler; the
 * approved action then runs as them through the module's own service (approvals.ts → AI_APPLIERS).
 * What the answer says about a plan is written here from the real results, never by the model.
 */

type ActInput = z.output<typeof AiActRequest>;

const VIA_NAME = 'Crewhall AI';
const MAX_ACTIONS = 5;
/** Times the model may ask to read before it has to answer. Each one is a model run. */
const READ_ROUNDS = 3;
/** Carried items listed on the approval screen. */
const PREVIEW_ITEMS = 50;

// ---------------------------------------------------------------------------------------
// The plan the model writes
// ---------------------------------------------------------------------------------------

const PlannedAction = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('assign_card'),
    card: z.string(),
    assignees: z.array(z.string()).min(1).max(10),
  }),
  z.object({
    type: z.literal('create_card'),
    board: z.string(),
    title: z.string().min(1).max(200),
    description: z.string().max(2_000).nullish(),
    due: z.string().nullish(),
    assignees: z.array(z.string()).max(10).nullish(),
  }),
  z.object({
    type: z.literal('create_meeting'),
    title: z.string().min(1).max(200),
    start: z.string(),
    duration_minutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60)
      .nullish(),
    invitees: z.array(z.string()).max(50).nullish(),
  }),
  z.object({
    type: z.literal('add_todo_item'),
    todo_card: z.string().nullish(),
    text: z.string().trim().min(1).max(280),
    due: z.string().nullish(),
  }),
  ...MORE_ACTIONS,
  ...TRANSFER_ACTIONS,
]);
type PlannedAction = z.infer<typeof PlannedAction>;
type BasicAction = Exclude<PlannedAction, MoreAction | TransferAction>;
const isMore = (a: PlannedAction): a is MoreAction => MORE_TYPES.has(a.type);
const isTransfer = (a: PlannedAction): a is TransferAction => TRANSFER_TYPES.has(a.type);

const Plan = z.object({
  message: z.string().default(''),
  actions: z.array(z.unknown()).default([]),
  reads: z.array(z.unknown()).default([]),
  replaces_last: z.boolean().nullish(),
});

export interface ParsedPlan {
  message: string;
  actions: PlannedAction[];
  reads: AssistantRead[];
  replacesLast: boolean;
}

/** The JSON object in the answer (tolerating a code fence); unknown actions are dropped. */
export function parsePlan(text: string): ParsedPlan {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const plan = Plan.safeParse(JSON.parse(text.slice(start, end + 1)));
      if (plan.success) {
        return {
          message: plan.data.message.trim(),
          actions: plan.data.actions
            .map((a) => PlannedAction.safeParse(a))
            .flatMap((r) => (r.success ? [r.data] : []))
            .slice(0, MAX_ACTIONS),
          reads: parseReads(plan.data.reads),
          replacesLast: plan.data.replaces_last === true,
        };
      }
    } catch {
      // Not JSON: the text is the message.
    }
  }
  return { message: text.trim(), actions: [], reads: [], replacesLast: false };
}

// ---------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------

export function validZone(tz: string | undefined) {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Offset of `tz` from UTC at `at`, in milliseconds. */
function zoneOffset(at: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const v = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return asUtc - at;
}

/** "2026-10-23T10:00" read in `tz` → UTC instant; null when it is not such a string. */
export function localToUtc(local: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(local.trim());
  if (!m) return null;
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  if (Number.isNaN(guess)) return null;
  const first = guess - zoneOffset(guess, tz);
  return new Date(guess - zoneOffset(first, tz));
}

/** Now as the person sees it: "2026-10-22 23:40, Thursday (Europe/Istanbul)". */
export function nowIn(tz: string, now = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
  return `${f.replace(',', '')}, ${weekday} (${tz})`;
}

// ---------------------------------------------------------------------------------------
// What the model may refer to
// ---------------------------------------------------------------------------------------

interface Person {
  id: string;
  name: string;
  email: string;
}
interface BoardRef {
  id: string;
  key: string;
  name: string;
  spaceId: string;
}

async function people(db: DbOrTx, orgId: string): Promise<Person[]> {
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(and(eq(orgMembers.organizationId, orgId), eq(orgMembers.status, 'active')))
    .limit(500);
}

/** Boards in spaces the person reaches (each one is checked again before it is used). */
async function boardsOf(db: DbOrTx, a: DriveActor): Promise<BoardRef[]> {
  const spaceIds = await reachableSpaceIds(db, a);
  if (!spaceIds.length) return [];
  const rows = await db
    .select({
      id: nodes.id,
      name: nodes.name,
      spaceId: nodes.spaceId,
      key: sql<string>`coalesce(${boards.settings}->>'key', '')`,
    })
    .from(boards)
    .innerJoin(nodes, eq(nodes.id, boards.nodeId))
    .where(
      and(eq(boards.orgId, a.org.id), inArray(nodes.spaceId, spaceIds), isNull(nodes.deletedAt)),
    )
    .limit(100);
  return rows;
}

const ME = new Set(['me', 'myself', 'ben', 'beni', 'bana', 'bende', 'kendim', 'kendimi']);

function findPerson(list: Person[], ref: string, me: string): Person | null {
  const r = fold(ref);
  if (ME.has(r)) return list.find((p) => p.id === me) ?? null;
  const exact = list.filter((p) => fold(p.email) === r || fold(p.name) === r);
  if (exact.length === 1) return exact[0]!;
  const first = list.filter(
    (p) => fold(p.name).split(/\s+/)[0] === r || fold(p.name).startsWith(r),
  );
  return first.length === 1 ? first[0]! : null;
}

function findBoard(list: BoardRef[], ref: string): BoardRef | null {
  const r = fold(ref);
  const hit = list.filter((b) => fold(b.key) === r || fold(b.name) === r);
  if (hit.length === 1) return hit[0]!;
  const loose = list.filter((b) => fold(b.name).includes(r));
  return loose.length === 1 ? loose[0]! : null;
}

// ---------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------

async function prepare(
  db: DbOrTx,
  a: DriveActor,
  action: BasicAction,
  ctx: {
    people: Person[];
    boards: BoardRef[];
    todoCards: TodoCard[];
    tz: string;
    locale: Locale;
    tx: Sentences;
  },
): Promise<Prepared | string> {
  const { tx } = ctx;
  const names = (ids: string[]) =>
    ids.map((id) => ctx.people.find((p) => p.id === id)?.name ?? '?').join(', ');
  const resolvePeople = (refs: string[]) => {
    const ids: string[] = [];
    for (const ref of refs) {
      const p = findPerson(ctx.people, ref, a.userId);
      if (!p) return { error: tx.unknownPerson.replace('{name}', ref) };
      ids.push(p.id);
    }
    return { ids: [...new Set(ids)] };
  };

  if (action.type === 'assign_card') {
    const m = /^([A-Za-z][A-Za-z0-9]{0,5})-(\d{1,9})$/.exec(action.card.trim());
    const board = m ? ctx.boards.find((b) => fold(b.key) === fold(m[1]!)) : undefined;
    if (!m || !board) return tx.unknownCard.replace('{card}', action.card);
    const [card] = await db
      .select({ id: boardCards.id, title: boardCards.title, number: boardCards.number })
      .from(boardCards)
      .where(
        and(
          eq(boardCards.boardNodeId, board.id),
          eq(boardCards.number, Number(m[2])),
          isNull(boardCards.deletedAt),
        ),
      );
    if (!card) return tx.unknownCard.replace('{card}', action.card);
    const who = resolvePeople(action.assignees);
    if ('error' in who) return who.error!;
    return {
      kind: 'assign_card',
      tool: 'ai_assign_card',
      payload: { card_id: card.id, add_user_ids: who.ids },
      title: `${board.key}-${card.number} ${card.title}`,
      detail: tx.assign.replace('{names}', names(who.ids)),
      location: board.name,
    };
  }

  if (action.type === 'create_card') {
    const board = findBoard(ctx.boards, action.board);
    if (!board) return tx.unknownBoard.replace('{board}', action.board);
    const who = resolvePeople(action.assignees ?? []);
    if ('error' in who) return who.error!;
    const due = action.due && /^\d{4}-\d{2}-\d{2}$/.test(action.due) ? action.due : null;
    return {
      kind: 'create_card',
      tool: 'ai_create_card',
      payload: {
        board_id: board.id,
        title: action.title.trim(),
        description: action.description?.trim() ?? '',
        due_at: due ? new Date(`${due}T09:00:00Z`).toISOString() : null,
        assignee_ids: who.ids,
      },
      title: action.title.trim(),
      detail:
        [who.ids.length ? tx.assign.replace('{names}', names(who.ids)) : null, due]
          .filter(Boolean)
          .join(' · ') || null,
      location: board.name,
    };
  }

  if (action.type === 'add_todo_item') {
    if (!ctx.todoCards.length) return tx.noTodoCard;
    const card = findTodoCard(ctx.todoCards, action.todo_card);
    if (!card) {
      return action.todo_card?.trim()
        ? tx.unknownTodoCard.replace('{card}', action.todo_card.trim())
        : tx.whichTodoCard.replace('{cards}', ctx.todoCards.map((c) => c.title).join(', '));
    }
    // To-do items have no date field: a due date goes into the text, as a person would write it.
    const due = action.due && /^\d{4}-\d{2}-\d{2}$/.test(action.due) ? action.due : null;
    const dueLabel = due
      ? new Intl.DateTimeFormat(ctx.locale, {
          day: 'numeric',
          month: 'long',
          timeZone: 'UTC',
        }).format(new Date(`${due}T00:00:00Z`))
      : null;
    const text = (dueLabel ? `${action.text.trim()} (${dueLabel})` : action.text.trim()).slice(
      0,
      300,
    );
    return {
      kind: 'add_todo_item',
      tool: 'ai_add_todo_item',
      payload: { card_id: card.id, text },
      title: text,
      detail: tx.todoOn.replace('{card}', card.title),
      location: card.title,
    };
  }

  const startsAt = localToUtc(action.start, ctx.tz);
  if (!startsAt || startsAt.getTime() < Date.now() - 5 * 60_000) {
    return tx.badTime.replace('{time}', action.start);
  }
  const who = resolvePeople(action.invitees ?? []);
  if ('error' in who) return who.error!;
  const invitees = who.ids.filter((id) => id !== a.userId);
  const duration = action.duration_minutes ?? 30;
  return {
    kind: 'create_meeting',
    tool: 'ai_create_meeting',
    payload: {
      title: action.title.trim(),
      starts_at: startsAt.toISOString(),
      duration_minutes: duration,
      invitee_ids: invitees,
    },
    title: action.title.trim(),
    detail: [
      `${action.start.replace('T', ' ').slice(0, 16)} (${ctx.tz}) · ${duration} dk`,
      invitees.length ? names(invitees) : null,
    ]
      .filter(Boolean)
      .join(' · '),
    location: null,
  };
}

const payloadHash = (payload: Record<string, unknown>) =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex');

// ---- The conversation so far ------------------------------------------------------------

type PastTurn = NonNullable<ActInput['history']>[number];
type ProposalStatus = 'pending' | 'done' | 'rejected' | 'failed' | 'expired';

/** What really happened to the proposals named in the history: only the person's own count. */
async function proposalStatuses(db: DbOrTx, a: DriveActor, history: PastTurn[]) {
  const ids = history.flatMap((t) => t.proposals.map((p) => p.approvalId));
  const out = new Map<string, ProposalStatus>();
  if (!ids.length) return out;
  const rows = await db
    .select({
      id: approvalRequests.id,
      status: approvalRequests.status,
      expiresAt: approvalRequests.expiresAt,
    })
    .from(approvalRequests)
    .where(
      and(
        inArray(approvalRequests.id, ids),
        eq(approvalRequests.userId, a.userId),
        eq(approvalRequests.orgId, a.org.id),
        eq(approvalRequests.action, 'ai.action'),
      ),
    );
  for (const r of rows) {
    out.set(
      r.id,
      r.status === 'pending'
        ? r.expiresAt > new Date()
          ? 'pending'
          : 'expired'
        : r.status === 'applied' || r.status === 'approved'
          ? 'done'
          : r.status === 'rejected'
            ? 'rejected'
            : r.status === 'expired' || r.status === 'stale'
              ? 'expired'
              : 'failed',
    );
  }
  return out;
}

/**
 * The proposals a short reply is about: those still waiting on the newest turn that made any. A
 * later turn that asked the person something takes over: "evet" then answers that question.
 */
function openProposals(history: PastTurn[], statuses: Map<string, ProposalStatus>): string[] {
  for (const turn of [...history].reverse().slice(0, 3)) {
    if (turn.proposals.length) {
      return turn.proposals.map((p) => p.approvalId).filter((id) => statuses.get(id) === 'pending');
    }
    if (/\?\s*$/.test(turn.message)) return [];
  }
  return [];
}

function historyText(history: PastTurn[], statuses: Map<string, ProposalStatus>) {
  return history
    .map((t) =>
      [
        `Person: ${t.request}`,
        t.message ? `You: ${t.message.slice(0, 1_500)}` : null,
        ...t.proposals.map(
          (p) =>
            `Prepared (${statuses.get(p.approvalId) ?? 'unknown'}): ${p.kind}: ${p.title}${p.detail ? ` — ${p.detail}` : ''}`,
        ),
        ...t.skipped.map((s) => `Could not prepare: ${s}`),
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

const YES_WORDS = new Set(
  'evet e ee tamam tmm olur yap yapalım yapın yapıver hadi haydi onayla onaylıyorum onay devam gönder gonder ok okay okey aynen kesinlikle uygula yes yep yeah do go ahead confirm approve sure'.split(
    ' ',
  ),
);
const NO_WORDS = new Set(
  'hayır hayir yok yapma vazgeç vazgeçtim vazgec vazgectim iptal reddet istemiyorum istemem boşver bosver gerek no nope cancel reject never mind dont'.split(
    ' ',
  ),
);
/** Said along with a yes or a no without changing it. */
const FILLER = new Set(
  'yok et bunu onu şunu hepsini hepsi lütfen artık o zaman please it them all that this'.split(' '),
);

/** A whole message that only says yes or no ("yok yap hadi", "tamam gönder", "vazgeçtim"). */
export function shortReply(text: string): 'yes' | 'no' | null {
  const words = text
    .toLocaleLowerCase('tr')
    .split(/[^\p{L}]+/u)
    .filter(Boolean);
  if (!words.length || words.length > 6) return null;
  const known = (set: Set<string>) => words.every((w) => set.has(w) || FILLER.has(w));
  if (known(YES_WORDS) && words.some((w) => YES_WORDS.has(w))) return 'yes';
  if (known(NO_WORDS)) return 'no';
  return null;
}

/** "Yaptım" from a model that prepared nothing: what the person must not be told. */
const CLAIM_MINE =
  /(?<!\p{L})(aktardım|oluşturdum|ekledim|gönderdim|taşıdım|tamamladım|hallettim|yaptım|i(?:'ve| have)? (?:added|created|sent|moved|finished|done))(?!\p{L})/iu;
const CLAIM_PASSIVE =
  /(?<!\p{L})(aktarıldı|oluşturuldu|eklendi|gönderildi|taşındı|tamamlandı)(?!\p{L})/iu;

function honestAnswer(message: string, didRead: boolean, tx: Sentences) {
  if (!message) return tx.nothing;
  if (CLAIM_MINE.test(message)) return tx.nothingDone;
  // After reading, "eklendi" may be a quote from the page.
  if (!didRead && CLAIM_PASSIVE.test(message)) return tx.nothingDone;
  return message;
}

/** A page made and added to in one plan is one page: its text would have nowhere else to go. */
function mergePageSteps(actions: PlannedAction[]) {
  const out: PlannedAction[] = [];
  for (const action of actions) {
    if (action.type === 'append_page') {
      const made = out.find(
        (x): x is Extract<PlannedAction, { type: 'create_page' }> =>
          x.type === 'create_page' && fold(x.title) === fold(action.page),
      );
      if (made) {
        made.text = [made.text, action.text].filter(Boolean).join('\n\n');
        continue;
      }
    }
    out.push(action);
  }
  return out;
}

export async function planActions(
  deps: Deps,
  caller: AiCaller,
  body: ActInput,
  req: RequestInfo,
): Promise<AiActResult> {
  if (!(await isModuleEnabled(deps.db, caller.org.id, 'mcp'))) {
    // The approval queue belongs to the MCP module.
    throw new AppError('module_disabled', { module: 'mcp' });
  }
  if (caller.actor.orgRole === 'guest') throw new AppError('forbidden');
  const settings = await usableSettings(deps, caller);
  const a: DriveActor = { org: caller.org, actor: caller.actor, userId: caller.userId };
  const locale: Locale = body.locale ?? resolveLocale(req.locale);
  const tz = validZone(body.timeZone);
  const tx = resources[locale].email.ai.act;

  const history = body.history ?? [];
  const statuses = await proposalStatuses(deps.db, a, history);
  const open = openProposals(history, statuses);

  // "Evet" to what is waiting needs no model. The client presses the buttons, so the approval
  // endpoint and its passkey or password check stay what they are.
  const reply = open.length ? shortReply(body.request) : null;
  if (reply) {
    return {
      runId: null,
      message: reply === 'yes' ? tx.approving : tx.rejecting,
      proposals: [],
      skipped: [],
      decided: reply === 'yes' ? { approve: open, reject: [] } : { approve: [], reject: open },
    };
  }

  const [list, boardList, todoCards, conversations, spaceList] = await Promise.all([
    people(deps.db, a.org.id),
    boardsOf(deps.db, a),
    todoCardsOf(deps.db, a),
    writableConversations(deps.db, a),
    spacesOf(deps.db, a),
  ]);
  const boardByRef = (ref: string) => findBoard(boardList, ref);
  const context: ActContext = {
    now: nowIn(tz),
    me: caller.userName,
    people: list.map((p) => p.name),
    boards: boardList.map((b) => ({ key: b.key, name: b.name })),
    todoCards: todoCards.map((c) => ({ title: c.title, open: openItems(c).length })),
    conversations,
    spaces: spaceList.map((x) => x.name),
    history: historyText(history, statuses),
    reads: [],
    lastRound: false,
  };

  // Planning decides what the person is asked to approve: the main model, not the fast one.
  const config = modelConfigOf(deps, settings);
  const ask = () =>
    executeRun(
      deps,
      caller,
      {
        kind: 'model',
        action: 'act',
        config,
        prompt: actPrompt(body.request, context, locale),
        target: { type: 'question', id: null },
      },
      req,
      {},
    );
  let out = await ask();
  let plan = parsePlan(out.text);
  for (let round = 1; plan.reads.length && round <= READ_ROUNDS; round += 1) {
    context.reads.push(
      ...(await runReads(plan.reads, { deps, caller, a, tz, findBoard: boardByRef })),
    );
    context.lastRound = round === READ_ROUNDS;
    out = await ask();
    plan = parsePlan(out.text);
  }

  // "Sohbeti özetle, görevleri çıkar": the conversation's tasks become ordinary actions.
  const summaries: string[] = [];
  const early: string[] = [];
  const expanded: PlannedAction[] = [];
  for (const action of plan.actions) {
    if (action.type !== 'extract_tasks') {
      expanded.push(action);
      continue;
    }
    const got = await expandExtract(action, {
      deps,
      caller,
      a,
      req,
      config: modelConfigOf(deps, settings, { fast: true }),
      now: context.now,
      locale,
      tx,
    });
    if (typeof got === 'string') {
      early.push(got);
      continue;
    }
    if (got.summary) summaries.push(got.summary);
    if (got.none) early.push(got.none);
    for (const raw of got.actions) {
      const parsed = PlannedAction.safeParse(raw);
      if (parsed.success) expanded.push(parsed.data);
    }
  }
  const actions = mergePageSteps(expanded).slice(0, MAX_ACTIONS + 8);

  const proposals: AiActProposal[] = [];
  const skipped: string[] = [...early];
  const moreCtx = {
    db: deps.db,
    a,
    tz,
    locale,
    tx,
    resolvePeople(refs: string[]) {
      const ids: string[] = [];
      for (const ref of refs) {
        const p = findPerson(list, ref, a.userId);
        if (!p) return { error: tx.unknownPerson.replace('{name}', ref) };
        ids.push(p.id);
      }
      return { ids: [...new Set(ids)] };
    },
    names: (ids: string[]) =>
      ids.map((id) => list.find((p) => p.id === id)?.name ?? '?').join(', '),
    toUtc: (local: string) => localToUtc(local, tz),
    todoCards,
    findBoard: boardByRef,
  };
  for (const action of actions) {
    const prepared = isTransfer(action)
      ? await prepareTransfer(action, moreCtx)
      : isMore(action)
        ? await prepareMore(action, moreCtx)
        : await prepare(deps.db, a, action, {
            people: list,
            boards: boardList,
            todoCards,
            tz,
            locale,
            tx,
          });
    if (typeof prepared === 'string') {
      skipped.push(prepared);
      continue;
    }
    // Boards are checked with the person's rights now too: no proposal for what they cannot see.
    const boardId = prepared.payload.board_id ?? null;
    if (typeof boardId === 'string') {
      const ok = await loadNode(deps.db, a, boardId).then(
        () => true,
        () => false,
      );
      if (!ok) {
        skipped.push(tx.noAccess.replace('{title}', prepared.title));
        continue;
      }
    }
    const [row] = await deps.db
      .insert(approvalRequests)
      .values({
        orgId: a.org.id,
        userId: a.userId,
        viaName: VIA_NAME,
        action: 'ai.action',
        tool: prepared.tool,
        payload: prepared.payload,
        payloadHash: payloadHash(prepared.payload),
        preview: {
          title: `${tx.kinds[prepared.kind]}: ${prepared.title}`,
          target: prepared.title,
          items: [
            {
              kind: prepared.kind,
              label: prepared.title,
              detail: prepared.detail,
              location: prepared.location,
            },
            // What it carries, there to read before approving.
            ...(prepared.items ?? []).slice(0, PREVIEW_ITEMS).map((label) => ({
              kind: 'item',
              label,
              detail: null,
              location: null,
            })),
          ],
        },
        targetRevs: {},
        clientNote: body.request.slice(0, 1_000),
        expiresAt: new Date(Date.now() + MCP_LIMITS.approvalTtlHours * 60 * 60 * 1000),
      })
      .returning({ id: approvalRequests.id });
    await aiAudit(
      deps.db,
      {
        orgId: a.org.id,
        actorId: a.userId,
        action: 'ai.action.propose',
        targetType: 'approval_request',
        targetId: row!.id,
        meta: { kind: prepared.kind },
        via: { kind: 'ai', runId: out.runId },
      },
      req,
    );
    proposals.push({
      approvalId: row!.id,
      kind: prepared.kind,
      title: prepared.title,
      detail: prepared.detail,
    });
  }

  // The model's words are its answer only when it prepared nothing. About a plan, the server says
  // what really came of it, so "aktardım" can never stand next to a card still waiting.
  const replaced = plan.replacesLast && proposals.length > 0 ? open : [];
  const message = proposals.length
    ? [
        tx.proposedN.replace('{n}', String(proposals.length)),
        ...(replaced.length ? [tx.replacing] : []),
        ...summaries,
      ].join(' ')
    : skipped.length
      ? [...summaries, tx.notPrepared].join(' ')
      : honestAnswer(plan.message, context.reads.length > 0, tx);
  return {
    runId: out.runId,
    message,
    proposals,
    skipped,
    ...(replaced.length ? { decided: { approve: [], reject: replaced } } : {}),
  };
}

// ---------------------------------------------------------------------------------------
// After approval (called by the MCP approval queue)
// ---------------------------------------------------------------------------------------

interface ApplyResult {
  result: Record<string, unknown>;
}

/** Appliers for the MCP approval queue, by tool name (approvals.ts APPLY). */
export const AI_APPLIERS: Record<
  string,
  (live: Deps, a: DriveActor, payload: Record<string, unknown>) => Promise<ApplyResult>
> = {
  async ai_assign_card(live, a, payload) {
    const cardId = String(payload.card_id);
    const add = z.array(z.uuid()).parse(payload.add_user_ids);
    const current = (
      await live.db
        .select({ userId: cardAssignees.userId })
        .from(cardAssignees)
        .where(eq(cardAssignees.cardId, cardId))
    ).map((r) => r.userId);
    await inBoardsTx(live, (tx) => setAssignees(tx, a, cardId, [...current, ...add]));
    const [card] = await live.db
      .select({ boardId: boardCards.boardNodeId, number: boardCards.number })
      .from(boardCards)
      .where(eq(boardCards.id, cardId));
    return {
      result: {
        card_id: cardId,
        board_id: card?.boardId ?? null,
        number: card?.number ?? null,
        assignee_ids: [...new Set([...current, ...add])],
      },
    };
  },
  async ai_create_card(live, a, payload) {
    const boardId = String(payload.board_id);
    const [column] = await live.db
      .execute<{ id: string }>(
        sql`
      select id from board_columns where board_node_id = ${boardId}
      order by position collate "C" limit 1`,
      )
      .then((r) => r.rows);
    if (!column) throw new AppError('not_found');
    const card = await inBoardsTx(live, (tx) =>
      createCard(
        tx,
        a,
        boardId,
        CreateBoardCard.parse({
          columnId: column.id,
          title: payload.title,
          description: payload.description ?? '',
          dueAt: payload.due_at ?? null,
          assigneeIds: payload.assignee_ids ?? [],
        }),
      ),
    );
    return { result: { card_id: card.id, board_id: boardId, number: card.number } };
  },
  async ai_create_meeting(live, a, payload) {
    const [person] = await live.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, a.userId));
    const meeting = await createMeeting(
      live,
      { ...a, userName: person?.name ?? '' },
      CreateMeeting.parse({
        mode: 'scheduled',
        title: payload.title,
        startsAt: payload.starts_at,
        durationMinutes: payload.duration_minutes,
        invitees: { userIds: payload.invitee_ids ?? [], emails: [] },
      }),
    );
    return { result: { meeting_id: meeting.id } };
  },
  ...MORE_APPLIERS,
  ...TRANSFER_APPLIERS,
  async ai_add_todo_item(live, a, payload) {
    const cardId = z.uuid().parse(payload.card_id);
    const text = z.string().trim().min(1).max(300).parse(payload.text);
    const item = { id: randomUUID(), text, done: false, doneAt: null };
    await live.db.transaction(async (tx) => {
      const [card] = await tx
        .select({ config: surfaceCards.config, type: surfaceCards.type })
        .from(surfaceCards)
        .where(and(eq(surfaceCards.id, cardId), isNull(surfaceCards.deletedAt)))
        .for('update');
      if (!card || card.type !== 'todo') throw new AppError('not_found');
      const config = TodoConfig.parse(card.config);
      // The quick-access service checks that the card is on a surface the person may edit
      // and that the list stays within its limit (validation_failed past 200 items).
      await updateSurfaceCard(tx, a, cardId, {
        config: { ...config, items: [...config.items, item] },
      });
    });
    return { result: { card_id: cardId, item_id: item.id } };
  },
};
