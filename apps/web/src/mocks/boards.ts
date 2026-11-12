import {
  BoardSettings,
  type BoardActivity,
  type BoardCard,
  type BoardCardDetail,
  type BoardColumn,
  type BoardSettings as BoardSettingsT,
  type BoardTemplate,
  type BoardTemplateContent,
  type CardLink,
  type CardLinkType,
  type ChecklistItem,
  type LinkedCard,
  type DrawingElement,
  type EndpointName,
  type LibraryItem,
  type SpaceRole,
  type Sprint,
  type SprintBurndown,
  type TimeEntry,
  type UserSummary,
  type Workload,
  type WorkloadCell,
  DEFAULT_CAPACITY_HOURS,
} from '@crewhall/shared';
import { MockApiError, myRole, paginate, requireUser, summary, type Resolvers } from './core';
import { db, newId } from './db';
import { driveState, mockPublicNode, nodeForUser } from './drive';
import { NODE, type MockNode } from './driveSeed';
import { SPACE, USER, type MockState, type MockUser } from './seed';

/**
 * Boards and drawings part of the contract mock (design 06). Board and drawing nodes live
 * in the Drive mock tree; this store holds columns, cards, activity, scenes and libraries.
 * Positions are fractional keys like the server's.
 */

type MockColumn = BoardColumn;
interface MockCard {
  id: string;
  boardId: string;
  columnId: string;
  number: number;
  position: string;
  title: string;
  description: string;
  labels: string[];
  assigneeIds: string[];
  followers: { userId: string; muted: boolean }[];
  startAt?: string | null;
  estimateMinutes?: number | null;
  dueAt: string | null;
  points: number | null;
  priority: 'p1' | 'p2' | 'p3' | null;
  checklist: ChecklistItem[];
  attachments: { nodeId: string; addedBy: string; addedAt: string }[];
  commentCount: number;
  sprintId: string | null;
  sprintAddedAt: string | null;
  doneAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
type MockSprint = Omit<Sprint, 'cardCount'>;
interface MockTime {
  id: string;
  cardId: string;
  userId: string;
  startedAt: string;
  minutes: number | null;
  note: string;
  source: 'timer' | 'manual';
}
interface MockLink {
  id: string;
  fromCardId: string;
  toCardId: string;
  kind: 'blocks' | 'relates' | 'duplicates';
  createdAt: string;
}
interface MockBoard {
  id: string;
  settings: BoardSettingsT;
  cardSeq: number;
  rev: number;
  updatedAt: string;
}
interface MockActivity {
  id: string;
  cardId: string;
  kind: BoardActivity['kind'];
  actorId: string | null;
  text: string | null;
  data: Record<string, string | number | boolean | null>;
  createdAt: string;
  deletedAt: string | null;
}
interface MockDrawing {
  id: string;
  elements: DrawingElement[];
  sceneRev: number;
  files: { fileId: string; mime: string; dataURL: string; createdAt: string }[];
}

export interface BoardsMockState {
  boards: MockBoard[];
  columns: MockColumn[];
  cards: MockCard[];
  sprints: MockSprint[];
  links: MockLink[];
  time: MockTime[];
  activity: MockActivity[];
  drawings: MockDrawing[];
  libraries: { ownerType: 'user' | 'space'; ownerId: string; items: LibraryItem[] }[];
}

/* -------------------------------- positions -------------------------------- */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const digit = (ch: string | undefined) => (ch === undefined ? 0 : DIGITS.indexOf(ch));
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    if (n > 0) return a.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = digit(a[0]);
  const dbb = b === null || b.length === 0 ? DIGITS.length : digit(b[0]);
  if (dbb - da > 1) return DIGITS[Math.floor((da + dbb) / 2)]!;
  if (b !== null && b.length > 1) return b[0]!;
  return DIGITS[da]! + midpoint(a.slice(1), null);
}
export const keyBetween = (a: string | null, b: string | null) => midpoint(a ?? '', b);

function placeBetween<T extends { id: string; position: string }>(
  list: T[],
  p: { afterId?: string | null; beforeId?: string | null },
  selfId?: string,
  top = false,
) {
  const others = list.filter((x) => x.id !== selfId);
  const ai = p.afterId ? others.findIndex((x) => x.id === p.afterId) : -1;
  const bi = p.beforeId ? others.findIndex((x) => x.id === p.beforeId) : -1;
  if ((p.afterId && ai < 0) || (p.beforeId && bi < 0)) throw new MockApiError('invalid_target');
  if (ai >= 0) return keyBetween(others[ai]!.position, others[ai + 1]?.position ?? null);
  if (bi >= 0) return keyBetween(others[bi - 1]?.position ?? null, others[bi]!.position);
  if (top) return keyBetween(null, others[0]?.position ?? null);
  return keyBetween(others.at(-1)?.position ?? null, null);
}

const byPos = <T extends { position: string }>(a: T, b: T) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : 0;

/* ----------------------------------- seed ----------------------------------- */

const now = () => new Date().toISOString();
const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

const TEMPLATE_COLUMNS: Record<BoardTemplate, [string, number | null][]> = {
  empty: [
    ['Yapılacak', null],
    ['Yapılıyor', null],
    ['Bitti', null],
  ],
  sprint: [
    ['Sırada', null],
    ['Yapılıyor', 3],
    ['Test', null],
    ['Bitti', null],
  ],
  roadmap: [
    ['Fikir', null],
    ['Sırada', null],
    ['Yapılıyor', 3],
    ['İncelemede', 4],
    ['Bitti', null],
  ],
  bugs: [
    ['Yeni', null],
    ['Doğrulandı', null],
    ['Düzeltiliyor', 2],
    ['Kapandı', null],
  ],
};
const TEMPLATE_LABELS: Record<BoardTemplate, string[]> = {
  empty: [],
  sprint: ['Backend', 'Web', 'Mobil'],
  roadmap: ['Backend', 'Altyapı', 'UI', 'Güvenlik', 'Entegrasyon'],
  bugs: ['Mobil', 'Web', 'API'],
};
const COLORS = ['s1', 's2', 's4', 'danger', 's5', 'info', 's3', 'warning'] as const;

function settingsFor(template: BoardTemplate, key: string, cardChats = true): BoardSettingsT {
  const today = new Date();
  return {
    key,
    template,
    labels: TEMPLATE_LABELS[template].map((name, i) => ({
      id: `l${i + 1}`,
      name,
      color: COLORS[i % COLORS.length]!,
    })),
    cardChats,
    fields: { points: template === 'sprint', priority: template === 'bugs' },
    doneArchiveDays: 30,
    sprint:
      template === 'sprint'
        ? {
            name: 'Sprint 42',
            startsOn: new Date(today.getTime() - 7 * DAY).toISOString().slice(0, 10),
            endsOn: new Date(today.getTime() + 5 * DAY).toISOString().slice(0, 10),
          }
        : null,
  };
}

function addBoard(st: BoardsMockState, id: string, template: BoardTemplate, key: string) {
  const settings = settingsFor(template, key);
  const board: MockBoard = { id, settings: { ...settings, sprint: null }, cardSeq: 0, rev: 1, updatedAt: now() };
  st.boards.push(board);
  // The template's sprint becomes the board's running sprint, like the server's.
  if (settings.sprint) {
    st.sprints.push({
      id: newId(),
      boardId: id,
      ...settings.sprint,
      goal: '',
      status: 'active',
      startedAt: `${settings.sprint.startsOn}T09:00:00.000Z`,
      closedAt: null,
      result: null,
      createdAt: ago(8),
    });
  }
  let pos: string | null = null;
  TEMPLATE_COLUMNS[template].forEach(([name, wip], i, all) => {
    pos = keyBetween(pos, null);
    st.columns.push({
      id: newId(),
      boardId: id,
      name,
      position: pos,
      wipLimit: wip,
      isDone: i === all.length - 1,
    });
  });
  return board;
}

type SeedCard = Partial<MockCard> & { title: string };

function addCards(st: BoardsMockState, boardId: string, column: number, cards: SeedCard[], startAt?: number) {
  const board = st.boards.find((b) => b.id === boardId)!;
  const col = st.columns.filter((c) => c.boardId === boardId).sort(byPos)[column]!;
  let pos: string | null =
    st.cards.filter((c) => c.columnId === col.id).sort(byPos).at(-1)?.position ?? null;
  for (const c of cards) {
    pos = keyBetween(pos, null);
    const number = c.number ?? (startAt !== undefined ? startAt++ : board.cardSeq + 1);
    board.cardSeq = Math.max(board.cardSeq, number);
    const card: MockCard = {
      id: newId(),
      boardId,
      columnId: col.id,
      number,
      position: pos,
      description: '',
      labels: [],
      assigneeIds: [],
      followers: [],
      dueAt: null,
      points: null,
      priority: null,
      checklist: [],
      attachments: [],
      commentCount: 0,
      sprintId: activeOf(st, boardId)?.id ?? null,
      sprintAddedAt: activeOf(st, boardId) ? ago(8) : null,
      doneAt: col.isDone ? ago(3) : null,
      archivedAt: null,
      deletedAt: null,
      createdBy: USER.bugra,
      createdAt: ago(14),
      updatedAt: ago(1),
      ...c,
    };
    card.followers = [...new Set([card.createdBy, ...card.assigneeIds])].map((userId) => ({
      userId,
      muted: false,
    }));
    st.cards.push(card);
    st.activity.push({
      id: newId(),
      cardId: card.id,
      kind: 'created',
      actorId: card.createdBy,
      text: null,
      data: { column: col.name },
      createdAt: card.createdAt,
      deletedAt: null,
    });
  }
}

const activeOf = (st: BoardsMockState, boardId: string) =>
  st.sprints.find((x) => x.boardId === boardId && x.status === 'active');

const toSprint = (st: BoardsMockState, sp: MockSprint): Sprint => ({
  ...sp,
  cardCount: st.cards.filter((c) => c.sprintId === sp.id && !c.deletedAt).length,
});

const bySprintStart = (a: MockSprint, b: MockSprint) =>
  a.startsOn.localeCompare(b.startsOn) || a.createdAt.localeCompare(b.createdAt);

function sprintTarget(st: BoardsMockState, boardId: string, sprintId: string, plannedOnly = false) {
  const sp = st.sprints.find((x) => x.id === sprintId && x.boardId === boardId);
  if (!sp || sp.status === 'closed' || (plannedOnly && sp.status !== 'planned')) {
    throw new MockApiError('invalid_target');
  }
  return sp;
}

const sprintUnit = (board: MockBoard) => (board.settings.fields.points ? 'points' : 'cards');
const weight = (board: MockBoard, c: MockCard) =>
  sprintUnit(board) === 'points' ? (c.points ?? 0) : 1;

/** Same rule as the server: unfinished cards move on, the result is kept. */
function closeMockSprint(st: BoardsMockState, board: MockBoard, sp: MockSprint, moveTo: string | null) {
  const cards = st.cards.filter((c) => c.sprintId === sp.id && !c.deletedAt);
  const open = cards.filter((c) => !c.doneAt && !c.archivedAt);
  for (const c of open) Object.assign(c, { sprintId: moveTo, sprintAddedAt: moveTo ? now() : null });
  Object.assign(sp, {
    status: 'closed',
    closedAt: now(),
    result: {
      unit: sprintUnit(board),
      done: cards.filter((c) => c.doneAt).reduce((n, c) => n + weight(board, c), 0),
      total: cards.reduce((n, c) => n + weight(board, c), 0),
    },
  });
  return open.length;
}

/** The server's burndown, with days in UTC. */
function mockBurndown(st: BoardsMockState, board: MockBoard, sp: MockSprint): SprintBurndown {
  const day = (iso: string) => iso.slice(0, 10);
  const cards = st.cards
    .filter((c) => c.sprintId === sp.id && !c.deletedAt)
    .map((c) => ({
      w: weight(board, c),
      added: day(c.sprintAddedAt ?? c.createdAt),
      done: c.doneAt ? day(c.doneAt) : null,
    }));
  const days: string[] = [];
  for (let d = Date.parse(`${sp.startsOn}T00:00:00Z`); d <= Date.parse(`${sp.endsOn}T00:00:00Z`); d += DAY) {
    days.push(new Date(d).toISOString().slice(0, 10));
  }
  const today = day(now());
  const scopeOn = (d: string) => cards.filter((c) => c.added <= d).reduce((n, c) => n + c.w, 0);
  const remainingOn = (d: string) =>
    cards.filter((c) => c.added <= d && !(c.done && c.done <= d)).reduce((n, c) => n + c.w, 0);
  const start = scopeOn(days[0] ?? sp.startsOn);
  const last = Math.max(1, days.length - 1);
  const lastPast = days.filter((d) => d <= today).at(-1);
  const total = lastPast ? scopeOn(lastPast) : cards.reduce((n, c) => n + c.w, 0);
  const left = lastPast ? remainingOn(lastPast) : cards.filter((c) => !c.done).reduce((n, c) => n + c.w, 0);
  return {
    sprintId: sp.id,
    unit: sprintUnit(board),
    days: days.map((date, i) => ({
      date,
      scope: scopeOn(date),
      remaining: date <= today ? remainingOn(date) : null,
      ideal: Math.round(start * (1 - i / last) * 100) / 100,
    })),
    total,
    done: total - left,
  };
}

const items = (n: number, done: number): ChecklistItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    text: `Alt görev ${i + 1}`,
    done: i < done,
    assigneeId: null,
  }));

function seedDrawingElements(): DrawingElement[] {
  const box = (id: string, x: number, y: number, text: string, bg: string, index: string) => [
    {
      id,
      type: 'rectangle',
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      index,
      x,
      y,
      width: 180,
      height: 80,
      angle: 0,
      strokeColor: '#141516',
      backgroundColor: bg,
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      roundness: { type: 3 },
      groupIds: [],
      frameId: null,
      boundElements: [{ type: 'text', id: `${id}-t` }],
      seed: 1,
      updated: Date.now(),
      link: null,
      locked: false,
    },
    {
      id: `${id}-t`,
      type: 'text',
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      index: `${index}V`,
      x: x + 20,
      y: y + 28,
      width: 140,
      height: 25,
      angle: 0,
      strokeColor: '#141516',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      boundElements: null,
      seed: 2,
      updated: Date.now(),
      link: null,
      locked: false,
      text,
      fontSize: 20,
      fontFamily: 6,
      textAlign: 'center',
      verticalAlign: 'middle',
      containerId: id,
      originalText: text,
      autoResize: true,
      lineHeight: 1.25,
    },
  ];
  return [
    ...box('web', 40, 40, 'Web', '#fde68a', 'a0'),
    ...box('api', 320, 40, 'API (Hono)', '#bfdbfe', 'a1'),
    ...box('pg', 600, 40, 'PostgreSQL', '#99f6e4', 'a2'),
    ...box('collab', 320, 200, 'Hocuspocus', '#ddd6fe', 'a3'),
  ];
}

function seed(s: MockState): BoardsMockState {
  const st: BoardsMockState = {
    boards: [],
    columns: [],
    cards: [],
    sprints: [],
    links: [],
    time: [],
    activity: [],
    drawings: [],
    libraries: [],
  };
  const b = USER.bugra;
  const c = USER.can;
  const z = USER.zeynep;
  const e = USER.elif;
  const m = USER.mert;
  addBoard(st, NODE.yolHaritasi, 'roadmap', 'MLV');
  const y = NODE.yolHaritasi;
  addCards(st, y, 0, [
    { number: 151, title: 'Çoklu kiracı için iş kotaları', labels: ['l1'], commentCount: 3 },
    { number: 149, title: 'Webhook ile iş tetikleme', labels: ['l1', 'l5'] },
    { number: 147, title: 'İş zinciri için görsel editör', labels: ['l3'], assigneeIds: [z], commentCount: 1 },
    { number: 140, title: 'Hub sohbetine iş bildirimi', commentCount: 1 },
  ], 151);
  addCards(st, y, 1, [
    { number: 144, title: "Scheduler lider seçimi PostgreSQL'e", labels: ['l1'], startAt: ago(2), dueAt: inDays(3), checklist: items(3, 0), assigneeIds: [c] },
    { number: 143, title: "Dashboard'a iş bağımlılık grafiği", labels: ['l3'], assigneeIds: [z], commentCount: 2 },
    { number: 139, title: 'Cron ifadesi doğrulayıcı', labels: ['l1'], assigneeIds: [e] },
  ], 144);
  addCards(st, y, 2, [
    {
      title: 'SSO ile giriş (OIDC)',
      number: 142,
      labels: ['l4', 'l1'],
      startAt: ago(6),
      dueAt: inDays(4),
      checklist: [
        { id: 'a', text: "Hub'da milvaion-dashboard istemcisini oluştur", done: true, assigneeId: c },
        { id: 'b', text: "Dashboard'a OpenIdConnect ara katmanı", done: true, assigneeId: c },
        { id: 'c', text: 'Rol eşleme tablosu ve testleri', done: false, assigneeId: b },
        { id: 'd', text: 'Back-channel logout ucu', done: false, assigneeId: null },
        { id: 'e', text: 'Eski kullanıcı tablosunu kaldıran migration', done: false, assigneeId: null },
      ],
      assigneeIds: [b, c],
      description:
        "Milvaion Dashboard girişleri Crewhall üzerinden OIDC ile yapılacak; ayrı kullanıcı tablosu kalkıyor. Akış: Authorization Code + PKCE, kapsamlar openid profile milvaion.jobs.\n- Rol eşleme: Hub space rolü → Milvaion rolü (Sahip/Yönetici → Admin, Düzenleyen → Operator, İzleyen → Viewer)\n- Oturum kapanınca Hub'dan back-channel logout gelir",
      createdAt: ago(17),
    },
    { number: 138, title: 'Retry politikası arayüzü', labels: ['l3'], checklist: items(4, 3), assigneeIds: [z, e], commentCount: 4 },
    { number: 136, title: 'Worker otomatik ölçekleme (KEDA)', labels: ['l2'], startAt: ago(12), dueAt: ago(3), checklist: items(4, 1), assigneeIds: [m] },
  ], 142);
  addCards(st, y, 3, [
    { number: 134, title: 'Seq alarm kuralları', labels: ['l2'], commentCount: 5, assigneeIds: [m, b] },
    { number: 131, title: "Worker'larda SIGTERM ile düzgün kapanma", labels: ['l1'], checklist: items(5, 5), assigneeIds: [e] },
  ], 134);
  addCards(
    st,
    y,
    4,
    Array.from({ length: 12 }, (_, i) => ({ title: `Tamamlanan iş ${i + 1}`, labels: ['l1'] })),
    100,
  );
  const sso = st.cards.find((x) => x.number === 142)!;
  sso.commentCount = 3;
  sso.estimateMinutes = 16 * 60;
  st.time.push(
    { id: newId(), cardId: sso.id, userId: c, startedAt: ago(5), minutes: 240, note: "Hub'da istemci ve kapsamlar", source: 'manual' },
    { id: newId(), cardId: sso.id, userId: b, startedAt: ago(2), minutes: 135, note: '', source: 'timer' },
  );
  // Timeline: the scheduler leader election has to land before SSO can finish.
  const leader = st.cards.find((x) => x.boardId === y && x.number === 144)!;
  st.links.push({ id: newId(), fromCardId: leader.id, toCardId: sso.id, kind: 'blocks', createdAt: ago(4) });
  const said = (who: string, text: string, d: number) =>
    st.activity.push({
      id: newId(),
      cardId: sso.id,
      kind: 'comment',
      actorId: who,
      text,
      data: {},
      createdAt: ago(d),
      deletedAt: null,
    });
  st.activity.push({
    id: newId(),
    cardId: sso.id,
    kind: 'moved',
    actorId: b,
    text: null,
    data: { from: 'Sırada', to: 'Yapılıyor' },
    createdAt: ago(6),
    deletedAt: null,
  });
  said(z, 'Giriş ekranında yalnızca "Crewhall ile giriş" düğmesi kalsın, kurum logosu Hub\'dan gelsin.', 5);
  said(c, "Hub'da istemciyi açtım: milvaion-dashboard, redirect /signin-oidc.", 1);
  said(b, 'Refresh token 30 gün olsun, sliding. @Elif rol eşlemesini senin testlerine bağlayalım mı?', 1);

  addBoard(st, NODE.sprint42, 'sprint', 'DMP');
  addCards(st, NODE.sprint42, 0, [
    { number: 318, title: 'Scheduler retry politikası', labels: ['l1'], dueAt: inDays(2), points: 5, assigneeIds: [b] },
    { number: 322, title: 'Dump listesinde çekerek yenile', labels: ['l3'], points: 2, assigneeIds: [USER.selin] },
    { number: 324, title: 'Test ortamı SSL yenileme', points: 1 },
  ], 318);
  addCards(st, NODE.sprint42, 1, [
    { number: 315, title: 'Push bildirim izni akışı (iOS)', labels: ['l3'], points: 8, checklist: items(3, 2), assigneeIds: [USER.selin] },
    { number: 311, title: "Hub API'ye toplu silme ucu", labels: ['l1'], points: 5, assigneeIds: [c] },
  ], 311);
  addCards(st, NODE.sprint42, 3, [
    { number: 301, title: 'Dump paylaşım linki süresi', points: 3 },
    { number: 298, title: 'Scheduler cron önizlemesi', points: 5 },
  ], 298);
  // Planning: the next sprint and cards waiting in the backlog.
  const next = newId();
  st.sprints.push({
    id: next,
    boardId: NODE.sprint42,
    name: 'Sprint 43',
    goal: 'Bildirim akışını mağazaya hazırla',
    startsOn: new Date(Date.now() + 6 * DAY).toISOString().slice(0, 10),
    endsOn: new Date(Date.now() + 19 * DAY).toISOString().slice(0, 10),
    status: 'planned',
    startedAt: null,
    closedAt: null,
    result: null,
    createdAt: ago(2),
  });
  addCards(st, NODE.sprint42, 0, [
    { number: 330, title: 'Android bildirim kanalları', points: 3, sprintId: next, sprintAddedAt: ago(2) },
    { number: 331, title: 'Dump arama geçmişi', points: 2, sprintId: null, sprintAddedAt: null },
    { number: 332, title: 'Karanlık tema kontrastı', sprintId: null, sprintAddedAt: null },
  ], 330);
  // Workload: estimates on the running sprint's cards.
  for (const [n, h] of [[318, 10], [322, 6], [315, 16], [311, 12]] as const) {
    st.cards.find((c) => c.boardId === NODE.sprint42 && c.number === n)!.estimateMinutes = h * 60;
  }
  // Dependencies: the bulk delete endpoint blocks the scheduler retry work.
  const byNumber = (n: number) => st.cards.find((c) => c.boardId === NODE.sprint42 && c.number === n)!.id;
  st.links.push({ id: newId(), fromCardId: byNumber(311), toCardId: byNumber(318), kind: 'blocks', createdAt: ago(3) });
  st.links.push({ id: newId(), fromCardId: byNumber(322), toCardId: byNumber(331), kind: 'relates', createdAt: ago(2) });

  st.drawings.push({ id: NODE.hubMimarisi, elements: seedDrawingElements(), sceneRev: 4, files: [] });
  void s;
  void SPACE;
  return st;
}

export function boardsMockState(s: MockState = db()): BoardsMockState {
  const holder = s as MockState & { boards?: BoardsMockState };
  holder.boards ??= seed(s);
  // A mock db saved in the browser before sprints and links lacks these.
  holder.boards.sprints ??= [];
  holder.boards.links ??= [];
  holder.boards.time ??= [];
  return holder.boards;
}

/* ---------------------------------- access ---------------------------------- */

const RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };
const atLeast = (r: SpaceRole | null, min: SpaceRole) => r !== null && RANK[r] >= RANK[min];

function nodeOf(s: MockState, id: string, type: 'board' | 'drawing'): MockNode {
  const n = driveState(s).nodes.find((x) => x.id === id && x.type === type && !x.deletedAt);
  if (!n) throw new MockApiError('not_found');
  return n;
}

function access(s: MockState, u: MockUser, id: string, type: 'board' | 'drawing') {
  const node = nodeOf(s, id, type);
  const dn = nodeForUser(s, id, u.id);
  if (!dn) throw new MockApiError('not_found');
  return { node, role: dn.myRole };
}

function boardOf(s: MockState, u: MockUser, id: string) {
  const st = boardsMockState(s);
  const a = access(s, u, id, 'board');
  let board = st.boards.find((b) => b.id === id);
  // A board node from the Drive seed without content yet: an empty template.
  board ??= addBoard(st, id, 'empty', 'KRT');
  return { st, board, ...a };
}

function sprintOf(s: MockState, u: MockUser, sprintId: string) {
  const sp = boardsMockState(s).sprints.find((x) => x.id === sprintId);
  if (!sp) throw new MockApiError('not_found');
  return { a: boardOf(s, u, sp.boardId), sp };
}

/** `updateBoard({ sprint })` from clients before sprints, as on the server. */
function legacySprint(
  st: BoardsMockState,
  board: MockBoard,
  value: { name: string; startsOn: string; endsOn: string } | null,
) {
  const active = activeOf(st, board.id);
  if (value === null) {
    if (active) closeMockSprint(st, board, active, null);
    return;
  }
  if (active) {
    Object.assign(active, value);
    return;
  }
  const sp: MockSprint = {
    id: newId(),
    boardId: board.id,
    ...value,
    goal: '',
    status: 'active',
    startedAt: now(),
    closedAt: null,
    result: null,
    createdAt: now(),
  };
  st.sprints.push(sp);
  for (const c of st.cards.filter((x) => x.boardId === board.id && !x.sprintId && !x.deletedAt)) {
    Object.assign(c, { sprintId: sp.id, sprintAddedAt: now() });
  }
}

function requireEdit(role: SpaceRole | null) {
  if (!atLeast(role, 'editor')) throw new MockApiError('forbidden');
}

function requireManage(u: MockUser, a: { role: SpaceRole | null; node: MockNode }) {
  if (!(atLeast(a.role, 'admin') || (a.node.createdBy === u.id && atLeast(a.role, 'editor')))) {
    throw new MockApiError('forbidden');
  }
}

function touch(board: MockBoard, node: MockNode, userId: string) {
  board.rev++;
  board.updatedAt = now();
  node.updatedAt = board.updatedAt;
  node.updatedBy = userId;
}

function people(s: MockState, ids: string[]) {
  return ids
    .map((id) => s.users.find((x) => x.id === id))
    .filter((x): x is MockUser => !!x)
    .map(summary);
}

function audience(s: MockState, node: MockNode) {
  const ids = s.spaceMembers.filter((m) => m.spaceId === node.spaceId).map((m) => m.userId);
  const d = driveState(s);
  for (const sh of d.shares) if (sh.kind === 'user' && sh.nodeId === node.id && sh.granteeId) ids.push(sh.granteeId);
  return people(s, [...new Set(ids)]).sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

function toCard(s: MockState, c: MockCard): BoardCard {
  return {
    id: c.id,
    boardId: c.boardId,
    columnId: c.columnId,
    number: c.number,
    position: c.position,
    title: c.title,
    excerpt: c.description.slice(0, 280),
    labels: c.labels,
    assignees: people(s, c.assigneeIds),
    startAt: c.startAt ?? null,
    dueAt: c.dueAt,
    points: c.points,
    priority: c.priority,
    checklist: { done: c.checklist.filter((i) => i.done).length, total: c.checklist.length },
    commentCount: c.commentCount,
    attachmentCount: c.attachments.length,
    conversationId: null,
    sprintId: c.sprintId,
    blockedBy: blockersOf(boardsMockState(s), c.id),
    estimateMinutes: c.estimateMinutes ?? null,
    spentMinutes: boardsMockState(s)
      .time.filter((e) => e.cardId === c.id)
      .reduce((n, e) => n + (e.minutes ?? 0), 0),
    doneAt: c.doneAt,
    archivedAt: c.archivedAt,
    createdBy: people(s, [c.createdBy])[0] ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function toDetail(s: MockState, u: MockUser, c: MockCard): BoardCardDetail {
  const st = boardsMockState(s);
  const board = st.boards.find((b) => b.id === c.boardId)!;
  const node = nodeOf(s, c.boardId, 'board');
  const d = driveState(s);
  const live = c.followers.filter((f) => !f.muted).map((f) => f.userId);
  return {
    ...toCard(s, c),
    description: c.description,
    checklistItems: c.checklist,
    attachments: c.attachments
      .map((a) => {
        const n = d.nodes.find((x) => x.id === a.nodeId && !x.deletedAt);
        if (!n) return null;
        return {
          nodeId: n.id,
          name: n.name,
          type: n.type,
          mime: null,
          sizeBytes: 0,
          addedBy: people(s, [a.addedBy])[0] ?? null,
          addedAt: a.addedAt,
        };
      })
      .filter((x) => x !== null),
    followerIds: live,
    following: live.includes(u.id),
    links: linksOf(s, u, c.id),
    board: {
      id: board.id,
      name: node.name,
      key: board.settings.key,
      spaceId: node.spaceId,
      myRole: nodeForUser(s, node.id, u.id)?.myRole ?? 'viewer',
    },
  };
}

/** Unfinished, live cards blocking the card (the server's count). */
const blockersOf = (st: BoardsMockState, cardId: string) =>
  st.links.filter((l) => {
    if (l.kind !== 'blocks' || l.toCardId !== cardId) return false;
    const from = st.cards.find((c) => c.id === l.fromCardId);
    return from && !from.doneAt && !from.archivedAt && !from.deletedAt;
  }).length;

function linkedCard(s: MockState, u: MockUser, id: string): LinkedCard | null {
  try {
    const { card, board, node, st } = cardOf(s, u, id);
    return {
      id: card.id,
      boardId: board.id,
      boardName: node.name,
      key: `${board.settings.key}-${card.number}`,
      title: card.title,
      columnName: st.columns.find((c) => c.id === card.columnId)?.name ?? '',
      done: card.doneAt !== null,
    };
  } catch {
    return null;
  }
}

const LINK_ORDER: CardLinkType[] = ['blocked_by', 'blocks', 'relates', 'duplicates', 'duplicated_by'];

function linksOf(s: MockState, u: MockUser, cardId: string): CardLink[] {
  const out: CardLink[] = [];
  for (const l of boardsMockState(s).links) {
    if (l.fromCardId !== cardId && l.toCardId !== cardId) continue;
    const self = l.fromCardId === cardId;
    const card = linkedCard(s, u, self ? l.toCardId : l.fromCardId);
    if (!card) continue;
    const type: CardLinkType =
      l.kind === 'relates' ? 'relates' : l.kind === 'blocks' ? (self ? 'blocks' : 'blocked_by') : self ? 'duplicates' : 'duplicated_by';
    out.push({ id: l.id, type, card, createdAt: l.createdAt });
  }
  return out.sort((x, y) => LINK_ORDER.indexOf(x.type) - LINK_ORDER.indexOf(y.type) || x.card.key.localeCompare(y.card.key, 'tr', { numeric: true }));
}

const isoAdd = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** The server's workload, with days in UTC. */
function mockWorkload(
  s: MockState,
  boardIds: string[],
  audience: UserSummary[],
  capacityHours: number,
  q: { from?: string | undefined; weeks: number },
): Workload {
  const st = boardsMockState(s);
  const today = q.from ?? now().slice(0, 10);
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const first = isoAdd(today, -weekday);
  const weeks = Array.from({ length: q.weeks }, (_, i) => isoAdd(first, i * 7));
  const end = isoAdd(first, q.weeks * 7 - 1);
  const empty = (): WorkloadCell => ({ hours: 0, cardIds: [], unestimated: 0 });
  const rows = new Map<string, { cells: WorkloadCell[]; undated: WorkloadCell }>();
  const row = (id: string) => {
    if (!rows.has(id)) rows.set(id, { cells: weeks.map(empty), undated: empty() });
    return rows.get(id)!;
  };
  for (const u of audience) row(u.id);
  const shown = new Set<string>();
  const add = (cell: WorkloadCell, cardId: string, hours: number | null) => {
    if (!cell.cardIds.includes(cardId)) {
      cell.cardIds.push(cardId);
      if (hours === null) cell.unestimated++;
    }
    cell.hours += hours ?? 0;
    shown.add(cardId);
  };
  const open = st.cards.filter((c) => boardIds.includes(c.boardId) && !c.deletedAt && !c.archivedAt && !c.doneAt);
  for (const c of open) {
    if (!c.assigneeIds.length) continue;
    const hours = c.estimateMinutes ? c.estimateMinutes / 60 : null;
    const sp = st.sprints.find((x) => x.id === c.sprintId && x.status !== 'closed');
    let from = (c.startAt ?? c.dueAt)?.slice(0, 10) ?? null;
    let to = (c.dueAt ?? c.startAt)?.slice(0, 10) ?? null;
    if (!from && sp) [from, to] = [sp.startsOn, sp.endsOn];
    if (!from || !to) {
      for (const u of c.assigneeIds) add(row(u).undated, c.id, hours === null ? null : hours / c.assigneeIds.length);
      continue;
    }
    if (to < first || from > end) continue;
    const days: string[] = [];
    for (let d = from; d <= to && days.length < 400; d = isoAdd(d, 1)) days.push(d);
    for (const u of c.assigneeIds) {
      weeks.forEach((w, i) => {
        const n = days.filter((d) => d >= w && d <= isoAdd(w, 6)).length;
        if (n) add(row(u).cells[i]!, c.id, hours === null ? null : (hours * n) / days.length / c.assigneeIds.length);
      });
    }
  }
  const round = (c: WorkloadCell) => ({ ...c, hours: Math.round(c.hours * 10) / 10 });
  return {
    weeks,
    capacityHours,
    people: [...rows.entries()]
      .flatMap(([id, r]) => {
        const user = people(s, [id])[0];
        return user ? [{ user, cells: r.cells.map(round), undated: round(r.undated) }] : [];
      })
      .sort((x, y) => x.user.name.localeCompare(y.user.name, 'tr')),
    cards: open
      .filter((c) => shown.has(c.id))
      .map((c) => ({
        id: c.id,
        boardId: c.boardId,
        key: `${st.boards.find((b) => b.id === c.boardId)!.settings.key}-${c.number}`,
        title: c.title,
        estimateMinutes: c.estimateMinutes ?? null,
      })),
  };
}

function toTime(s: MockState, u: MockUser, e: MockTime, manager: boolean): TimeEntry {
  return {
    ...e,
    user: people(s, [e.userId])[0]!,
    canEdit: e.userId === u.id || manager,
  };
}

/** The caller's running timer stops with its minutes rounded up (at least one). */
function stopMockTimer(st: BoardsMockState, userId: string) {
  const running = st.time.find((e) => e.userId === userId && e.minutes === null);
  if (running) running.minutes = Math.max(1, Math.ceil((Date.now() - Date.parse(running.startedAt)) / 60_000));
  return running ?? null;
}

function timeEntryOf(s: MockState, u: MockUser, id: string) {
  const e = boardsMockState(s).time.find((x) => x.id === id);
  if (!e) throw new MockApiError('not_found');
  const a = cardOf(s, u, e.cardId);
  const manager = atLeast(a.role, 'admin') || (a.node.createdBy === u.id && atLeast(a.role, 'editor'));
  if (e.userId === u.id) requireEdit(a.role);
  else if (!manager) throw new MockApiError('forbidden');
  return { e, a, manager };
}

function cardOf(s: MockState, u: MockUser, id: string, includeDeleted = false) {
  const st = boardsMockState(s);
  const c = st.cards.find((x) => x.id === id);
  if (!c || (c.deletedAt && !includeDeleted)) throw new MockApiError('not_found');
  return { card: c, ...boardOf(s, u, c.boardId) };
}

function log(
  st: BoardsMockState,
  card: MockCard,
  kind: BoardActivity['kind'],
  actorId: string,
  data: MockActivity['data'] = {},
  text: string | null = null,
) {
  const a: MockActivity = { id: newId(), cardId: card.id, kind, actorId, text, data, createdAt: now(), deletedAt: null };
  st.activity.push(a);
  return a;
}

function toActivity(s: MockState, a: MockActivity): BoardActivity {
  return {
    id: a.id,
    cardId: a.cardId,
    kind: a.kind,
    actor: a.actorId ? (people(s, [a.actorId])[0] ?? null) : null,
    text: a.deletedAt ? null : a.text,
    data: a.data,
    createdAt: a.createdAt,
    editedAt: null,
  };
}

function follow(card: MockCard, ids: string[]) {
  for (const id of ids) if (!card.followers.some((f) => f.userId === id)) card.followers.push({ userId: id, muted: false });
}

function toBoard(s: MockState, u: MockUser, board: MockBoard, node: MockNode, role: SpaceRole) {
  const sp = s.spaces.find((x) => x.id === node.spaceId)!;
  const active = activeOf(boardsMockState(s), board.id);
  return {
    id: node.id,
    spaceId: node.spaceId,
    parentId: node.parentId,
    name: node.name,
    settings: BoardSettings.parse({
      ...board.settings,
      sprint: active ? { name: active.name, startsOn: active.startsOn, endsOn: active.endsOn } : null,
    }),
    rev: board.rev,
    myRole: role,
    canManage: atLeast(role, 'admin') || (node.createdBy === u.id && atLeast(role, 'editor')),
    space: { id: sp.id, name: sp.name, slug: sp.slug, color: sp.color },
    createdAt: node.createdAt,
    updatedAt: board.updatedAt,
  };
}

function createNode(s: MockState, u: MockUser, spaceId: string, parentId: string | null, type: 'board' | 'drawing', name: string) {
  const role = myRole(s, spaceId, u.id);
  if (!role) throw new MockApiError('not_found');
  requireEdit(role);
  const d = driveState(s);
  const taken = (n: string) =>
    d.nodes.some((x) => x.spaceId === spaceId && x.parentId === parentId && x.name === n && !x.deletedAt);
  let final = name;
  if (taken(name)) {
    if (type === 'board') throw new MockApiError('node_name_taken');
    for (let i = 2; taken(final); i++) final = `${name} (${i})`;
  }
  const node: MockNode = {
    id: newId(),
    spaceId,
    parentId,
    type,
    name: final,
    createdBy: u.id,
    updatedBy: u.id,
    createdAt: now(),
    updatedAt: now(),
    deletedAt: null,
    deletedBy: null,
    trashedWith: null,
  };
  d.nodes.push(node);
  return node;
}

function drawingOf(s: MockState, u: MockUser, id: string) {
  const st = boardsMockState(s);
  const a = access(s, u, id, 'drawing');
  let drawing = st.drawings.find((x) => x.id === id);
  if (!drawing) {
    drawing = { id, elements: [], sceneRev: 0, files: [] };
    st.drawings.push(drawing);
  }
  return { st, drawing, ...a };
}

function toDrawing(s: MockState, dr: MockDrawing, node: MockNode, role: SpaceRole) {
  const sp = s.spaces.find((x) => x.id === node.spaceId)!;
  return {
    id: node.id,
    spaceId: node.spaceId,
    parentId: node.parentId,
    name: node.name,
    myRole: role,
    sceneRev: dr.sceneRev,
    elementCount: dr.elements.filter((e) => !e.isDeleted).length,
    thumbnail: { ready: false, rev: 0 },
    files: dr.files.map((f) => ({ fileId: f.fileId, mime: f.mime, sizeBytes: Math.round(f.dataURL.length * 0.75), createdAt: f.createdAt })),
    space: { id: sp.id, name: sp.name, slug: sp.slug, color: sp.color },
    createdBy: people(s, [node.createdBy])[0] ?? null,
    updatedBy: people(s, [node.updatedBy])[0] ?? null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

const newer = (a: DrawingElement, b: DrawingElement | undefined) =>
  !b || a.version > b.version || (a.version === b.version && (a.versionNonce ?? 0) < (b.versionNonce ?? 0));

/* --------------------------------- resolvers --------------------------------- */

type BoardsName = Extract<
  EndpointName,
  | 'listBoards'
  | 'getPublicBoard'
  | 'createBoard'
  | 'getBoard'
  | 'getBoardRev'
  | 'updateBoard'
  | 'listArchivedBoardCards'
  | 'getBoardAttachmentFolder'
  | 'createBoardColumn'
  | 'updateBoardColumn'
  | 'moveBoardColumn'
  | 'deleteBoardColumn'
  | 'createBoardCard'
  | 'getBoardCardByNumber'
  | 'getBoardCard'
  | 'updateBoardCard'
  | 'moveBoardCard'
  | 'deleteBoardCard'
  | 'restoreBoardCard'
  | 'bulkUpdateBoardCards'
  | 'setBoardCardAssignees'
  | 'setBoardCardFollowing'
  | 'listBoardCardActivity'
  | 'addBoardCardComment'
  | 'deleteBoardCardComment'
  | 'addBoardCardAttachment'
  | 'removeBoardCardAttachment'
  | 'openBoardCardConversation'
  | 'listMyBoardCards'
  | 'listBoardCardLinks'
  | 'addBoardCardLink'
  | 'removeBoardCardLink'
  | 'searchBoardCards'
  | 'listBoardCardTime'
  | 'addBoardCardTime'
  | 'startBoardCardTimer'
  | 'getMyBoardTimer'
  | 'stopMyBoardTimer'
  | 'updateBoardTimeEntry'
  | 'deleteBoardTimeEntry'
  | 'getBoardWorkload'
  | 'getSpaceBoardWorkload'
  | 'listBoardSprints'
  | 'createBoardSprint'
  | 'updateBoardSprint'
  | 'deleteBoardSprint'
  | 'startBoardSprint'
  | 'closeBoardSprint'
  | 'getBoardSprintBurndown'
  | 'listDrawings'
  | 'createDrawing'
  | 'getDrawing'
  | 'getDrawingScene'
  | 'saveDrawingScene'
  | 'uploadDrawingFile'
  | 'getDrawingFileUrl'
  | 'getDrawingLibrary'
  | 'updateDrawingLibrary'
  | 'createBoardsCollabToken'
>;

const columnsOf = (st: BoardsMockState, boardId: string) =>
  st.columns.filter((c) => c.boardId === boardId).sort(byPos);
const cardsIn = (st: BoardsMockState, columnId: string) =>
  st.cards.filter((c) => c.columnId === columnId && !c.deletedAt).sort(byPos);

export const boardsResolvers: Resolvers<BoardsName> = {
  listBoards: ({ s, params }) => {
    const u = requireUser(s);
    if (!myRole(s, params.spaceId!, u.id)) throw new MockApiError('not_found');
    const st = boardsMockState(s);
    const nodes = driveState(s)
      .nodes.filter((n) => n.spaceId === params.spaceId && n.type === 'board' && !n.deletedAt)
      .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    return {
      items: nodes.map((n) => {
        const b = st.boards.find((x) => x.id === n.id);
        return {
          id: n.id,
          spaceId: n.spaceId,
          parentId: n.parentId,
          name: n.name,
          key: b?.settings.key ?? 'KRT',
          cardCount: st.cards.filter((c) => c.boardId === n.id && !c.archivedAt && !c.deletedAt).length,
          updatedAt: b?.updatedAt ?? n.updatedAt,
        };
      }),
    };
  },
  createBoard: ({ s, params, body }) => {
    const u = requireUser(s);
    const node = createNode(s, u, params.spaceId!, body.parentId, 'board', body.name);
    const st = boardsMockState(s);
    const key =
      body.key ??
      (body.name
        .toLocaleUpperCase('tr')
        .replace(/[^A-ZÇĞİÖŞÜ]/g, '')
        .replace(/[ÇĞİÖŞÜ]/g, (ch) => ({ Ç: 'C', Ğ: 'G', İ: 'I', Ö: 'O', Ş: 'S', Ü: 'U' })[ch] ?? ch)
        .slice(0, 3) || 'KRT');
    const board = addBoard(st, node.id, body.template, key.length >= 2 ? key : 'KRT');
    board.settings.cardChats = body.cardChats;
    return toBoard(s, u, board, node, myRole(s, node.spaceId, u.id)!);
  },
  getPublicBoard: ({ s, params, query }) => {
    const { node } = mockPublicNode(s, params.token ?? '', query.grant, query.nodeId);
    if (node.type !== 'board') throw new MockApiError('bad_request');
    const st = boardsMockState(s);
    const board = st.boards.find((b) => b.id === node.id) ?? addBoard(st, node.id, 'empty', 'KRT');
    const columns = columnsOf(st, board.id);
    const colIndex = new Map(columns.map((c, i) => [c.id, i]));
    const cards = st.cards
      .filter((c) => c.boardId === board.id && !c.archivedAt && !c.deletedAt)
      .sort((a, b) => colIndex.get(a.columnId)! - colIndex.get(b.columnId)! || byPos(a, b))
      .map((c) => toCard(s, c));
    return {
      id: node.id,
      name: node.name,
      key: board.settings.key,
      labels: board.settings.labels,
      columns: columns.map((c) => ({ id: c.id, name: c.name, isDone: c.isDone })),
      cards: cards.map((c) => ({
        id: c.id,
        columnId: c.columnId,
        number: c.number,
        title: c.title,
        labels: c.labels,
        dueAt: c.dueAt,
        priority: c.priority,
        checklist: c.checklist,
        doneAt: c.doneAt,
      })),
      updatedAt: board.updatedAt,
    };
  },
  getBoard: ({ s, params }) => {
    const u = requireUser(s);
    const { st, board, node, role } = boardOf(s, u, params.boardId!);
    const columns = columnsOf(st, board.id);
    const colIndex = new Map(columns.map((c, i) => [c.id, i]));
    const cards = st.cards
      .filter((c) => c.boardId === board.id && !c.archivedAt && !c.deletedAt)
      .sort((a, b) => (colIndex.get(a.columnId)! - colIndex.get(b.columnId)!) || byPos(a, b));
    return {
      board: toBoard(s, u, board, node, role),
      columns,
      cards: cards.map((c) => toCard(s, c)),
      archivedCount: st.cards.filter((c) => c.boardId === board.id && c.archivedAt && !c.deletedAt).length,
      people: audience(s, node),
      dependencies: st.links
        .filter((l) => {
          const ends = [l.fromCardId, l.toCardId].map((id) => st.cards.find((c) => c.id === id));
          return l.kind === 'blocks' && ends.every((c) => c && c.boardId === board.id && !c.deletedAt);
        })
        .map((l) => ({ fromId: l.fromCardId, toId: l.toCardId })),
      sprints: st.sprints
        .filter((x) => x.boardId === board.id && x.status !== 'closed')
        .sort(bySprintStart)
        .map((x) => toSprint(st, x)),
    };
  },
  getBoardRev: ({ s, params }) => {
    const u = requireUser(s);
    return { rev: boardOf(s, u, params.boardId!).board.rev };
  },
  updateBoard: ({ s, params, body }) => {
    const u = requireUser(s);
    const a = boardOf(s, u, params.boardId!);
    requireEdit(a.role);
    const { name, ...rest } = body;
    if (name !== undefined) a.node.name = name;
    if (Object.values(rest).some((v) => v !== undefined)) {
      requireManage(u, a);
      const { sprint, ...plain } = rest;
      a.board.settings = {
        ...a.board.settings,
        ...Object.fromEntries(Object.entries(plain).filter(([, v]) => v !== undefined)),
      };
      if (sprint !== undefined) legacySprint(a.st, a.board, sprint);
      if (rest.labels) {
        const keep = new Set(rest.labels.map((l) => l.id));
        for (const c of a.st.cards.filter((x) => x.boardId === a.board.id)) c.labels = c.labels.filter((l) => keep.has(l));
      }
    }
    touch(a.board, a.node, u.id);
    return toBoard(s, u, a.board, a.node, a.role);
  },
  listArchivedBoardCards: ({ s, params, query }) => {
    const u = requireUser(s);
    const { st, board } = boardOf(s, u, params.boardId!);
    const all = st.cards
      .filter((c) => c.boardId === board.id && c.archivedAt && !c.deletedAt)
      .sort((a, b) => (b.archivedAt! < a.archivedAt! ? -1 : 1))
      .map((c) => toCard(s, c));
    return paginate(all, query.cursor, query.limit);
  },
  getBoardAttachmentFolder: ({ s, params }) => {
    const u = requireUser(s);
    const a = boardOf(s, u, params.boardId!);
    requireEdit(a.role);
    const d = driveState(s);
    const name = `${a.node.name} · Ekler`;
    // The app's own folder (server: system_role), found by this board's role; Drive does not list it.
    const role = `board_attachments:${a.node.id}`;
    let folder = d.nodes.find((n) => n.spaceId === a.node.spaceId && n.systemRole === role && !n.deletedAt);
    if (!folder) {
      folder = { ...a.node, id: newId(), type: 'folder', name, systemRole: role, createdBy: u.id, updatedBy: u.id, createdAt: now(), updatedAt: now() };
      d.nodes.push(folder);
    }
    return { spaceId: a.node.spaceId, folderId: folder.id };
  },

  createBoardColumn: ({ s, params, body }) => {
    const u = requireUser(s);
    const a = boardOf(s, u, params.boardId!);
    requireManage(u, a);
    const col: MockColumn = {
      id: newId(),
      boardId: a.board.id,
      name: body.name,
      position: placeBetween(columnsOf(a.st, a.board.id), body),
      wipLimit: body.wipLimit,
      isDone: body.isDone,
    };
    a.st.columns.push(col);
    touch(a.board, a.node, u.id);
    return col;
  },
  updateBoardColumn: ({ s, params, body }) => {
    const u = requireUser(s);
    const st = boardsMockState(s);
    const col = st.columns.find((c) => c.id === params.columnId);
    if (!col) throw new MockApiError('not_found');
    const a = boardOf(s, u, col.boardId);
    requireManage(u, a);
    if (body.name !== undefined) col.name = body.name;
    if (body.wipLimit !== undefined) col.wipLimit = body.wipLimit;
    if (body.isDone !== undefined && body.isDone !== col.isDone) {
      col.isDone = body.isDone;
      for (const c of cardsIn(st, col.id)) c.doneAt = body.isDone ? now() : null;
    }
    touch(a.board, a.node, u.id);
    return col;
  },
  moveBoardColumn: ({ s, params, body }) => {
    const u = requireUser(s);
    const st = boardsMockState(s);
    const col = st.columns.find((c) => c.id === params.columnId);
    if (!col) throw new MockApiError('not_found');
    const a = boardOf(s, u, col.boardId);
    requireManage(u, a);
    col.position = placeBetween(columnsOf(st, col.boardId), body, col.id);
    touch(a.board, a.node, u.id);
    return col;
  },
  deleteBoardColumn: ({ s, params, query }) => {
    const u = requireUser(s);
    const st = boardsMockState(s);
    const col = st.columns.find((c) => c.id === params.columnId);
    if (!col) throw new MockApiError('not_found');
    const a = boardOf(s, u, col.boardId);
    requireManage(u, a);
    const cols = columnsOf(st, col.boardId);
    if (cols.length <= 1) throw new MockApiError('board_last_column');
    const inside = st.cards.filter((c) => c.columnId === col.id);
    if (inside.length) {
      const target = cols.find((c) => c.id === query.moveTo && c.id !== col.id);
      if (!target) throw new MockApiError('board_column_not_empty');
      let pos = cardsIn(st, target.id).at(-1)?.position ?? null;
      for (const c of inside.sort(byPos)) {
        pos = keyBetween(pos, null);
        Object.assign(c, { columnId: target.id, position: pos, doneAt: target.isDone ? now() : null });
      }
    }
    st.columns = st.columns.filter((c) => c.id !== col.id);
    touch(a.board, a.node, u.id);
    return {};
  },

  createBoardCard: ({ s, params, body }) => {
    const u = requireUser(s);
    const a = boardOf(s, u, params.boardId!);
    requireEdit(a.role);
    const col = a.st.columns.find((c) => c.id === body.columnId && c.boardId === a.board.id);
    if (!col) throw new MockApiError('invalid_target');
    const known = new Set(a.board.settings.labels.map((l) => l.id));
    if (body.labels.some((l) => !known.has(l))) throw new MockApiError('board_label_unknown');
    const ok = new Set(audience(s, a.node).map((p) => p.id));
    if (body.assigneeIds.some((id) => !ok.has(id))) throw new MockApiError('board_assignee_not_member');
    const card: MockCard = {
      id: newId(),
      boardId: a.board.id,
      columnId: col.id,
      number: ++a.board.cardSeq,
      position: placeBetween(cardsIn(a.st, col.id), body, undefined, body.top),
      title: body.title,
      description: body.description ?? '',
      labels: body.labels,
      assigneeIds: [...new Set(body.assigneeIds)],
      followers: [],
      startAt: body.startAt ?? null,
      dueAt: body.dueAt,
      points: null,
      priority: null,
      checklist: [],
      attachments: [],
      commentCount: 0,
      sprintId:
        body.sprintId === undefined
          ? (activeOf(a.st, a.board.id)?.id ?? null)
          : body.sprintId && sprintTarget(a.st, a.board.id, body.sprintId).id,
      sprintAddedAt: null,
      doneAt: col.isDone ? now() : null,
      archivedAt: null,
      deletedAt: null,
      createdBy: u.id,
      createdAt: now(),
      updatedAt: now(),
    };
    if (card.sprintId) card.sprintAddedAt = now();
    follow(card, [u.id, ...card.assigneeIds]);
    a.st.cards.push(card);
    log(a.st, card, 'created', u.id, { column: col.name });
    touch(a.board, a.node, u.id);
    return toCard(s, card);
  },
  getBoardCardByNumber: ({ s, params }) => {
    const u = requireUser(s);
    const m = /^(?:[A-Za-z][A-Za-z0-9]{0,5}-)?(\d{1,9})$/.exec(params.number ?? '');
    if (!m) throw new MockApiError('not_found');
    const { st, board } = boardOf(s, u, params.boardId!);
    const c = st.cards.find((x) => x.boardId === board.id && x.number === Number(m[1]) && !x.deletedAt);
    if (!c) throw new MockApiError('not_found');
    return toDetail(s, u, c);
  },
  getBoardCard: ({ s, params }) => {
    const u = requireUser(s);
    return toDetail(s, u, cardOf(s, u, params.cardId!).card);
  },
  updateBoardCard: ({ s, params, body }) => {
    const u = requireUser(s);
    const a = cardOf(s, u, params.cardId!);
    requireEdit(a.role);
    const c = a.card;
    if (body.title !== undefined && body.title !== c.title) {
      log(a.st, c, 'renamed', u.id, { from: c.title, to: body.title });
      c.title = body.title;
    }
    if (body.description !== undefined) c.description = body.description;
    if (body.labels !== undefined) {
      const known = new Set(a.board.settings.labels.map((l) => l.id));
      if (body.labels.some((l) => !known.has(l))) throw new MockApiError('board_label_unknown');
      c.labels = [...new Set(body.labels)];
    }
    const start = body.startAt !== undefined ? body.startAt : (c.startAt ?? null);
    const due = body.dueAt !== undefined ? body.dueAt : c.dueAt;
    if (start && due && start > due) throw new MockApiError('validation_failed');
    if (body.dueAt !== undefined && body.dueAt !== c.dueAt) {
      c.dueAt = body.dueAt;
      log(a.st, c, 'due_changed', u.id, { dueAt: body.dueAt });
    }
    if (body.startAt !== undefined) c.startAt = body.startAt;
    if (body.points !== undefined) c.points = body.points;
    if (body.priority !== undefined) c.priority = body.priority;
    if (body.estimateMinutes !== undefined) c.estimateMinutes = body.estimateMinutes;
    if (body.sprintId !== undefined && body.sprintId !== c.sprintId) {
      if (body.sprintId) sprintTarget(a.st, a.board.id, body.sprintId);
      c.sprintId = body.sprintId;
      c.sprintAddedAt = body.sprintId ? now() : null;
    }
    if (body.checklistItems !== undefined) {
      const before = c.checklist.filter((i) => i.done).length;
      c.checklist = body.checklistItems;
      const after = c.checklist.filter((i) => i.done).length;
      if (after > before) log(a.st, c, 'checklist_done', u.id, { count: after - before });
    }
    if (body.archived !== undefined && body.archived !== (c.archivedAt !== null)) {
      c.archivedAt = body.archived ? now() : null;
      log(a.st, c, body.archived ? 'archived' : 'restored', u.id);
    }
    c.updatedAt = now();
    touch(a.board, a.node, u.id);
    return toDetail(s, u, c);
  },
  moveBoardCard: ({ s, params, body }) => {
    const u = requireUser(s);
    const a = cardOf(s, u, params.cardId!);
    requireEdit(a.role);
    const target = a.st.columns.find((x) => x.id === body.columnId && x.boardId === a.board.id);
    if (!target) throw new MockApiError('invalid_target');
    const c = a.card;
    c.position = placeBetween(cardsIn(a.st, target.id), body, c.id);
    if (target.id !== c.columnId) {
      const from = a.st.columns.find((x) => x.id === c.columnId);
      c.columnId = target.id;
      c.doneAt = target.isDone ? now() : null;
      log(a.st, c, 'moved', u.id, { from: from?.name ?? '', to: target.name, done: target.isDone });
    }
    c.updatedAt = now();
    touch(a.board, a.node, u.id);
    const count = cardsIn(a.st, target.id).filter((x) => !x.archivedAt).length;
    return {
      card: toCard(s, c),
      wip: { count, limit: target.wipLimit, exceeded: target.wipLimit !== null && count > target.wipLimit },
    };
  },
  deleteBoardCard: ({ s, params }) => {
    const u = requireUser(s);
    const a = cardOf(s, u, params.cardId!);
    requireEdit(a.role);
    a.card.deletedAt = now();
    touch(a.board, a.node, u.id);
    return {};
  },
  restoreBoardCard: ({ s, params }) => {
    const u = requireUser(s);
    const a = cardOf(s, u, params.cardId!, true);
    requireEdit(a.role);
    a.card.deletedAt = null;
    touch(a.board, a.node, u.id);
    return toCard(s, a.card);
  },
  bulkUpdateBoardCards: ({ s, params, body }) => {
    const u = requireUser(s);
    const a = boardOf(s, u, params.boardId!);
    requireEdit(a.role);
    const cards = a.st.cards.filter((c) => c.boardId === a.board.id && body.cardIds.includes(c.id) && !c.deletedAt).sort(byPos);
    const target = body.columnId ? a.st.columns.find((c) => c.id === body.columnId && c.boardId === a.board.id) : undefined;
    if (body.columnId && !target) throw new MockApiError('invalid_target');
    if (body.sprintId) sprintTarget(a.st, a.board.id, body.sprintId);
    let pos = target ? (cardsIn(a.st, target.id).filter((c) => !body.cardIds.includes(c.id)).at(-1)?.position ?? null) : null;
    for (const c of cards) {
      if (target) {
        pos = keyBetween(pos, null);
        c.position = pos;
        if (c.columnId !== target.id) {
          c.columnId = target.id;
          c.doneAt = target.isDone ? now() : null;
          log(a.st, c, 'moved', u.id, { to: target.name });
        }
      }
      if (body.addLabels) c.labels = [...new Set([...c.labels, ...body.addLabels])];
      if (body.addAssigneeIds) {
        c.assigneeIds = [...new Set([...c.assigneeIds, ...body.addAssigneeIds])];
        follow(c, body.addAssigneeIds);
      }
      if (body.archive !== undefined) c.archivedAt = body.archive ? (c.archivedAt ?? now()) : null;
      if (body.sprintId !== undefined && body.sprintId !== c.sprintId) {
        c.sprintId = body.sprintId;
        c.sprintAddedAt = body.sprintId ? now() : null;
      }
    }
    touch(a.board, a.node, u.id);
    return { updated: cards.length };
  },
  setBoardCardAssignees: ({ s, params, body }) => {
    const u = requireUser(s);
    const a = cardOf(s, u, params.cardId!);
    requireEdit(a.role);
    const ok = new Set(audience(s, a.node).map((p) => p.id));
    if (body.userIds.some((id) => !ok.has(id))) throw new MockApiError('board_assignee_not_member');
    const before = a.card.assigneeIds;
    const wanted = [...new Set(body.userIds)];
    for (const id of wanted.filter((x) => !before.includes(x))) {
      log(a.st, a.card, 'assigned', u.id, { userId: id, userName: people(s, [id])[0]?.name ?? '' });
    }
    for (const id of before.filter((x) => !wanted.includes(x))) {
      log(a.st, a.card, 'unassigned', u.id, { userId: id, userName: people(s, [id])[0]?.name ?? '' });
    }
    a.card.assigneeIds = wanted;
    follow(a.card, wanted);
    touch(a.board, a.node, u.id);
    return toCard(s, a.card);
  },
  setBoardCardFollowing: ({ s, params, body }) => {
    const u = requireUser(s);
    const a = cardOf(s, u, params.cardId!);
    const f = a.card.followers.find((x) => x.userId === u.id);
    if (f) f.muted = !body.following;
    else a.card.followers.push({ userId: u.id, muted: !body.following });
    return {};
  },
  listBoardCardActivity: ({ s, params, query }) => {
    const u = requireUser(s);
    const { st, card } = cardOf(s, u, params.cardId!);
    const all = st.activity
      .filter((x) => x.cardId === card.id && !x.deletedAt)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((x) => toActivity(s, x));
    return paginate(all, query.cursor, query.limit);
  },
  addBoardCardComment: ({ s, params, body }) => {
    const u = requireUser(s);
    const a = cardOf(s, u, params.cardId!);
    const entry = log(a.st, a.card, 'comment', u.id, {}, body.text);
    a.card.commentCount++;
    follow(a.card, [u.id]);
    touch(a.board, a.node, u.id);
    return toActivity(s, entry);
  },
  deleteBoardCardComment: ({ s, params }) => {
    const u = requireUser(s);
    const st = boardsMockState(s);
    const entry = st.activity.find((x) => x.id === params.activityId && x.kind === 'comment' && !x.deletedAt);
    if (!entry) throw new MockApiError('not_found');
    const a = cardOf(s, u, entry.cardId);
    if (entry.actorId !== u.id && !atLeast(a.role, 'admin')) throw new MockApiError('forbidden');
    entry.deletedAt = now();
    a.card.commentCount = Math.max(0, a.card.commentCount - 1);
    touch(a.board, a.node, u.id);
    return {};
  },
  addBoardCardAttachment: ({ s, params, body }) => {
    const u = requireUser(s);
    const a = cardOf(s, u, params.cardId!);
    requireEdit(a.role);
    const target = nodeForUser(s, body.nodeId, u.id);
    if (!target) throw new MockApiError('not_found');
    if (!a.card.attachments.some((x) => x.nodeId === body.nodeId)) {
      a.card.attachments.push({ nodeId: body.nodeId, addedBy: u.id, addedAt: now() });
      log(a.st, a.card, 'attachment_added', u.id, { name: target.name, nodeId: target.id });
      touch(a.board, a.node, u.id);
    }
    return toDetail(s, u, a.card);
  },
  removeBoardCardAttachment: ({ s, params }) => {
    const u = requireUser(s);
    const a = cardOf(s, u, params.cardId!);
    requireEdit(a.role);
    a.card.attachments = a.card.attachments.filter((x) => x.nodeId !== params.nodeId);
    touch(a.board, a.node, u.id);
    return toDetail(s, u, a.card);
  },
  openBoardCardConversation: () => {
    // Chat is not part of this mock yet: comments-only, like a server without chat.
    throw new MockApiError('boards_chat_unavailable');
  },
  listMyBoardCards: ({ s, query }) => {
    const u = requireUser(s);
    const st = boardsMockState(s);
    const out = [];
    for (const c of st.cards) {
      if (!c.assigneeIds.includes(u.id) || c.archivedAt || c.deletedAt) continue;
      const node = driveState(s).nodes.find((n) => n.id === c.boardId && !n.deletedAt);
      if (!node || !nodeForUser(s, node.id, u.id)) continue;
      if (query.spaceId && node.spaceId !== query.spaceId) continue;
      const col = st.columns.find((x) => x.id === c.columnId)!;
      if (col.isDone) continue;
      if (query.scope === 'due' && (!c.dueAt || Date.parse(c.dueAt) > Date.now() + 3 * DAY)) continue;
      const board = st.boards.find((b) => b.id === c.boardId)!;
      out.push({
        ...toCard(s, c),
        board: { id: node.id, name: node.name, key: board.settings.key, spaceId: node.spaceId },
        column: { id: col.id, name: col.name, isDone: col.isDone },
      });
    }
    out.sort((a, b) => (a.dueAt ?? '9') < (b.dueAt ?? '9') ? -1 : 1);
    return { items: out.slice(0, query.limit) };
  },

  listBoardCardLinks: ({ s, params }) => {
    const u = requireUser(s);
    cardOf(s, u, params.cardId!);
    return { items: linksOf(s, u, params.cardId!) };
  },
  addBoardCardLink: ({ s, params, body }) => {
    const u = requireUser(s);
    const a = cardOf(s, u, params.cardId!);
    requireEdit(a.role);
    if (body.cardId === a.card.id) throw new MockApiError('invalid_target');
    cardOf(s, u, body.cardId);
    const kind = body.type === 'blocked_by' || body.type === 'blocks' ? 'blocks' : body.type === 'relates' ? 'relates' : 'duplicates';
    const selfIsFrom = body.type !== 'blocked_by' && body.type !== 'duplicated_by';
    const from = selfIsFrom ? a.card.id : body.cardId;
    const to = selfIsFrom ? body.cardId : a.card.id;
    const same = a.st.links.some(
      (l) => l.kind === kind && ((l.fromCardId === from && l.toCardId === to) || (kind === 'relates' && l.fromCardId === to && l.toCardId === from)),
    );
    if (!same) {
      if (kind === 'blocks') {
        // Walk the blocks edges onward from `to`; reaching `from` closes a loop.
        const seen = new Set([to]);
        let frontier = [to];
        while (frontier.length) {
          if (frontier.includes(from)) throw new MockApiError('board_link_cycle');
          frontier = a.st.links.filter((l) => l.kind === 'blocks' && frontier.includes(l.fromCardId)).map((l) => l.toCardId).filter((id) => !seen.has(id));
          for (const id of frontier) seen.add(id);
        }
      }
      a.st.links.push({ id: newId(), fromCardId: from, toCardId: to, kind, createdAt: now() });
      touch(a.board, a.node, u.id);
    }
    return { items: linksOf(s, u, a.card.id) };
  },
  removeBoardCardLink: ({ s, params }) => {
    const u = requireUser(s);
    const st = boardsMockState(s);
    const link = st.links.find((l) => l.id === params.linkId);
    if (!link) throw new MockApiError('not_found');
    const a = cardOf(s, u, link.fromCardId, true);
    requireEdit(a.role);
    st.links = st.links.filter((l) => l.id !== link.id);
    touch(a.board, a.node, u.id);
    return {};
  },
  searchBoardCards: ({ s, query }) => {
    const u = requireUser(s);
    const st = boardsMockState(s);
    const words = query.q.toLocaleLowerCase('tr').split(/\s+/).filter(Boolean);
    const key = /^(?:([A-Za-z][A-Za-z0-9]{0,5})-)?(\d{1,9})$/.exec(query.q);
    const found = st.cards
      .filter((c) => !c.deletedAt)
      .filter((c) => (key && c.number === Number(key[2])) || words.every((w) => c.title.toLocaleLowerCase('tr').includes(w)))
      .sort((x, y) => Number(y.boardId === query.boardId) - Number(x.boardId === query.boardId) || y.updatedAt.localeCompare(x.updatedAt))
      .map((c) => linkedCard(s, u, c.id))
      .filter((c): c is LinkedCard => c !== null)
      .filter((c) => !key?.[1] || c.key.startsWith(`${key[1].toUpperCase()}-`));
    return { items: found.slice(0, query.limit) };
  },
  listBoardCardTime: ({ s, params }) => {
    const u = requireUser(s);
    const a = cardOf(s, u, params.cardId!);
    const manager = atLeast(a.role, 'admin') || (a.node.createdBy === u.id && atLeast(a.role, 'editor'));
    return {
      items: a.st.time
        .filter((e) => e.cardId === a.card.id)
        .sort((x, y) => y.startedAt.localeCompare(x.startedAt))
        .map((e) => toTime(s, u, e, manager)),
    };
  },
  addBoardCardTime: ({ s, params, body }) => {
    const u = requireUser(s);
    const a = cardOf(s, u, params.cardId!);
    requireEdit(a.role);
    const e: MockTime = {
      id: newId(),
      cardId: a.card.id,
      userId: u.id,
      startedAt: body.startedAt ?? now(),
      minutes: body.minutes,
      note: body.note,
      source: 'manual',
    };
    a.st.time.push(e);
    touch(a.board, a.node, u.id);
    return toTime(s, u, e, false);
  },
  startBoardCardTimer: ({ s, params }) => {
    const u = requireUser(s);
    const a = cardOf(s, u, params.cardId!);
    requireEdit(a.role);
    stopMockTimer(a.st, u.id);
    const e: MockTime = {
      id: newId(),
      cardId: a.card.id,
      userId: u.id,
      startedAt: now(),
      minutes: null,
      note: '',
      source: 'timer',
    };
    a.st.time.push(e);
    touch(a.board, a.node, u.id);
    return toTime(s, u, e, false);
  },
  getMyBoardTimer: ({ s }) => {
    const u = requireUser(s);
    const e = boardsMockState(s).time.find((x) => x.userId === u.id && x.minutes === null);
    const card = e ? linkedCard(s, u, e.cardId) : null;
    return { entry: e && card ? { ...toTime(s, u, e, false), card } : null };
  },
  stopMyBoardTimer: ({ s }) => {
    const u = requireUser(s);
    const e = stopMockTimer(boardsMockState(s), u.id);
    return { entry: e ? toTime(s, u, e, false) : null };
  },
  updateBoardTimeEntry: ({ s, params, body }) => {
    const u = requireUser(s);
    const { e, a, manager } = timeEntryOf(s, u, params.entryId!);
    if (e.minutes === null && body.minutes !== undefined) throw new MockApiError('conflict');
    if (body.minutes !== undefined) e.minutes = body.minutes;
    if (body.startedAt !== undefined) e.startedAt = body.startedAt;
    if (body.note !== undefined) e.note = body.note;
    touch(a.board, a.node, u.id);
    return toTime(s, u, e, manager);
  },
  deleteBoardTimeEntry: ({ s, params }) => {
    const u = requireUser(s);
    const { e, a } = timeEntryOf(s, u, params.entryId!);
    a.st.time = a.st.time.filter((x) => x.id !== e.id);
    touch(a.board, a.node, u.id);
    return {};
  },
  getBoardWorkload: ({ s, params, query }) => {
    const u = requireUser(s);
    const { board, node } = boardOf(s, u, params.boardId!);
    return mockWorkload(s, [board.id], audience(s, node), board.settings.capacityHours ?? DEFAULT_CAPACITY_HOURS, query);
  },
  getSpaceBoardWorkload: ({ s, params, query }) => {
    const u = requireUser(s);
    if (!myRole(s, params.spaceId!, u.id)) throw new MockApiError('not_found');
    const ids = driveState(s)
      .nodes.filter((n) => n.spaceId === params.spaceId && n.type === 'board' && !n.deletedAt)
      .map((n) => n.id);
    const members = s.spaceMembers.filter((m) => m.spaceId === params.spaceId).map((m) => m.userId);
    return mockWorkload(s, ids, people(s, members), DEFAULT_CAPACITY_HOURS, query);
  },
  listBoardSprints: ({ s, params }) => {
    const u = requireUser(s);
    const { st, board } = boardOf(s, u, params.boardId!);
    return {
      items: st.sprints
        .filter((x) => x.boardId === board.id)
        .sort(bySprintStart)
        .map((x) => toSprint(st, x)),
    };
  },
  createBoardSprint: ({ s, params, body }) => {
    const u = requireUser(s);
    const a = boardOf(s, u, params.boardId!);
    requireEdit(a.role);
    const sp: MockSprint = {
      id: newId(),
      boardId: a.board.id,
      name: body.name,
      goal: body.goal,
      startsOn: body.startsOn,
      endsOn: body.endsOn,
      status: 'planned',
      startedAt: null,
      closedAt: null,
      result: null,
      createdAt: now(),
    };
    a.st.sprints.push(sp);
    touch(a.board, a.node, u.id);
    return toSprint(a.st, sp);
  },
  updateBoardSprint: ({ s, params, body }) => {
    const u = requireUser(s);
    const { a, sp } = sprintOf(s, u, params.sprintId!);
    requireEdit(a.role);
    if (sp.status === 'closed') throw new MockApiError('board_sprint_state');
    const next = {
      ...sp,
      ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)),
    };
    if (next.endsOn < next.startsOn) throw new MockApiError('validation_failed');
    Object.assign(sp, next);
    touch(a.board, a.node, u.id);
    return toSprint(a.st, sp);
  },
  deleteBoardSprint: ({ s, params }) => {
    const u = requireUser(s);
    const { a, sp } = sprintOf(s, u, params.sprintId!);
    requireEdit(a.role);
    if (sp.status !== 'planned') throw new MockApiError('board_sprint_state');
    for (const c of a.st.cards.filter((x) => x.sprintId === sp.id)) {
      Object.assign(c, { sprintId: null, sprintAddedAt: null });
    }
    a.st.sprints = a.st.sprints.filter((x) => x.id !== sp.id);
    touch(a.board, a.node, u.id);
    return {};
  },
  startBoardSprint: ({ s, params }) => {
    const u = requireUser(s);
    const { a, sp } = sprintOf(s, u, params.sprintId!);
    requireManage(u, a);
    if (sp.status !== 'planned') throw new MockApiError('board_sprint_state');
    if (activeOf(a.st, a.board.id)) throw new MockApiError('board_sprint_active');
    Object.assign(sp, { status: 'active', startedAt: now() });
    touch(a.board, a.node, u.id);
    return toSprint(a.st, sp);
  },
  closeBoardSprint: ({ s, params, body }) => {
    const u = requireUser(s);
    const { a, sp } = sprintOf(s, u, params.sprintId!);
    requireManage(u, a);
    if (sp.status !== 'active') throw new MockApiError('board_sprint_state');
    if (body.moveTo) sprintTarget(a.st, a.board.id, body.moveTo, true);
    const moved = closeMockSprint(a.st, a.board, sp, body.moveTo);
    touch(a.board, a.node, u.id);
    return { sprint: toSprint(a.st, sp), moved };
  },
  getBoardSprintBurndown: ({ s, params }) => {
    const u = requireUser(s);
    const { a, sp } = sprintOf(s, u, params.sprintId!);
    return mockBurndown(a.st, a.board, sp);
  },

  listDrawings: ({ s, params }) => {
    const u = requireUser(s);
    if (!myRole(s, params.spaceId!, u.id)) throw new MockApiError('not_found');
    const st = boardsMockState(s);
    return {
      items: driveState(s)
        .nodes.filter((n) => n.spaceId === params.spaceId && n.type === 'drawing' && !n.deletedAt)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
        .map((n) => {
          const d = st.drawings.find((x) => x.id === n.id);
          return {
            id: n.id,
            spaceId: n.spaceId,
            parentId: n.parentId,
            name: n.name,
            elementCount: d?.elements.filter((e) => !e.isDeleted).length ?? 0,
            thumbnailReady: false,
            updatedAt: n.updatedAt,
          };
        }),
    };
  },
  createDrawing: ({ s, params, body }) => {
    const u = requireUser(s);
    const node = createNode(s, u, params.spaceId!, body.parentId, 'drawing', body.name);
    const st = boardsMockState(s);
    const d: MockDrawing = { id: node.id, elements: [], sceneRev: 0, files: [] };
    st.drawings.push(d);
    return toDrawing(s, d, node, myRole(s, node.spaceId, u.id)!);
  },
  getDrawing: ({ s, params }) => {
    const u = requireUser(s);
    const { drawing, node, role } = drawingOf(s, u, params.nodeId!);
    return toDrawing(s, drawing, node, role);
  },
  getDrawingScene: ({ s, params }) => {
    const u = requireUser(s);
    const { drawing } = drawingOf(s, u, params.nodeId!);
    return { elements: drawing.elements.filter((e) => !e.isDeleted), sceneRev: drawing.sceneRev };
  },
  saveDrawingScene: ({ s, params, body }) => {
    const u = requireUser(s);
    const { drawing, node, role } = drawingOf(s, u, params.nodeId!);
    requireEdit(role);
    const map = new Map(drawing.elements.map((e) => [e.id, e]));
    let changed = 0;
    for (const e of body.elements) {
      if (newer(e, map.get(e.id))) {
        map.set(e.id, e);
        changed++;
      }
    }
    if (changed) {
      drawing.elements = [...map.values()].sort((a, b) => ((a.index ?? '') < (b.index ?? '') ? -1 : 1));
      drawing.sceneRev++;
      node.updatedAt = now();
      node.updatedBy = u.id;
    }
    return { elements: drawing.elements.filter((e) => !e.isDeleted), sceneRev: drawing.sceneRev };
  },
  uploadDrawingFile: ({ s, params, body }) => {
    const u = requireUser(s);
    const { drawing, role } = drawingOf(s, u, params.nodeId!);
    requireEdit(role);
    let f = drawing.files.find((x) => x.fileId === body.fileId);
    if (!f) {
      const mime = /^data:([^;]+);/.exec(body.dataURL)?.[1] ?? '';
      if (!mime.startsWith('image/')) throw new MockApiError('drawing_file_invalid');
      f = { fileId: body.fileId, mime, dataURL: body.dataURL, createdAt: now() };
      drawing.files.push(f);
    }
    return { fileId: f.fileId, mime: f.mime, sizeBytes: Math.round(f.dataURL.length * 0.75), createdAt: f.createdAt };
  },
  getDrawingFileUrl: ({ s, params }) => {
    const u = requireUser(s);
    const { drawing } = drawingOf(s, u, params.nodeId!);
    const f = drawing.files.find((x) => x.fileId === params.file);
    if (!f) throw new MockApiError('not_found');
    return { url: f.dataURL.startsWith('data:') ? `https://mock.invalid/${f.fileId}` : f.dataURL, expiresAt: new Date(Date.now() + 300_000).toISOString(), mime: f.mime };
  },
  getDrawingLibrary: ({ s, query }) => {
    const u = requireUser(s);
    const st = boardsMockState(s);
    const lib = (t: 'user' | 'space', id: string) => st.libraries.find((l) => l.ownerType === t && l.ownerId === id)?.items ?? [];
    const role = query.spaceId ? myRole(s, query.spaceId, u.id) : null;
    if (query.spaceId && !role) throw new MockApiError('not_found');
    return {
      personal: lib('user', u.id),
      space: query.spaceId ? lib('space', query.spaceId) : null,
      canEditSpace: atLeast(role, 'editor'),
    };
  },
  updateDrawingLibrary: ({ s, body }) => {
    const u = requireUser(s);
    const st = boardsMockState(s);
    let ownerId = u.id;
    if (body.scope === 'space') {
      if (!body.spaceId) throw new MockApiError('validation_failed');
      requireEdit(myRole(s, body.spaceId, u.id));
      ownerId = body.spaceId;
    }
    const ownerType = body.scope === 'space' ? 'space' : 'user';
    const existing = st.libraries.find((l) => l.ownerType === ownerType && l.ownerId === ownerId);
    if (existing) existing.items = body.items;
    else st.libraries.push({ ownerType, ownerId, items: body.items });
    const role = body.spaceId ? myRole(s, body.spaceId, u.id) : null;
    const lib = (t: 'user' | 'space', id: string) => st.libraries.find((l) => l.ownerType === t && l.ownerId === id)?.items ?? [];
    return { personal: lib('user', u.id), space: body.spaceId ? lib('space', body.spaceId) : null, canEditSpace: atLeast(role, 'editor') };
  },
  createBoardsCollabToken: ({ s, body }) => {
    const u = requireUser(s);
    const [prefix, id] = body.document.split(':') as ['card' | 'drawing', string];
    let role: SpaceRole | null;
    if (prefix === 'card') role = cardOf(s, u, id).role;
    else role = drawingOf(s, u, id).role;
    // No collab server in the mock: the URL never connects, editors fall back to HTTP saves.
    return {
      token: `mock.${id}`,
      url: '',
      document: body.document,
      readOnly: !atLeast(role, 'editor'),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  },
};

/** Template gallery (roadmap 8): a board built from template content, with its starter cards. */
export function mockBoardFromTemplate(
  s: MockState,
  u: MockUser,
  spaceId: string,
  parentId: string | null,
  name: string,
  content: BoardTemplateContent,
) {
  const node = createNode(s, u, spaceId, parentId, 'board', name);
  const st = boardsMockState(s);
  const board = addBoard(st, node.id, 'empty', 'KRT');
  st.columns = st.columns.filter((c) => c.boardId !== node.id);
  let pos: string | null = null;
  for (const col of content.columns) {
    pos = keyBetween(pos, null);
    st.columns.push({
      id: newId(),
      boardId: node.id,
      name: col.name,
      position: pos,
      wipLimit: col.wipLimit,
      isDone: col.isDone,
    });
  }
  board.settings.labels = content.labels;
  board.settings.fields = content.fields;
  for (const c of content.cards) addCards(st, node.id, c.column, [{ title: c.title, labels: c.labels }]);
  return { id: node.id, name: node.name };
}

/** Template gallery: what "save board as template" keeps (no people, dates or comments). */
export function mockBoardContent(s: MockState, boardId: string): BoardTemplateContent {
  const st = boardsMockState(s);
  const board = st.boards.find((b) => b.id === boardId);
  if (!board) throw new MockApiError('not_found');
  const columns = columnsOf(st, boardId);
  const index = new Map(columns.map((c, i) => [c.id, i]));
  return {
    columns: columns.map((c) => ({ name: c.name, wipLimit: c.wipLimit, isDone: c.isDone })),
    labels: board.settings.labels,
    fields: board.settings.fields,
    cards: st.cards
      .filter((c) => c.boardId === boardId && !c.archivedAt && !c.deletedAt && index.has(c.columnId))
      .sort(byPos)
      .map((c) => ({ column: index.get(c.columnId)!, title: c.title, labels: c.labels, description: '' })),
  };
}
