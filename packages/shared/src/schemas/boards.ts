import { z } from 'zod';
import { Id, Timestamp } from './common';
import { UserSummary } from './org';
import { SpaceColor, SpaceRole } from './space';

/**
 * Boards and drawings (design 06, mobile 14.16-14.18; doc 17 §4, §6).
 *
 * A board is a `board` node: columns, cards, WIP limits. Its structure lives in relational
 * tables (the "assigned to me" card and notifications query it); a card's description is
 * the Yjs document `card:<cardId>` with a derived plain text. A drawing is a `drawing` node
 * whose Excalidraw elements live in the Yjs document `drawing:<nodeId>` (Y.Map by element
 * id); images are stored as blobs, a thumbnail is rendered by the worker.
 */

export const BOARD_LIMITS = {
  columns: 30,
  labels: 40,
  cardsPerBoard: 5000,
  checklistItems: 100,
  titleLength: 500,
  descriptionLength: 100_000,
  commentLength: 10_000,
  /** Excalidraw elements of one scene. */
  sceneElements: 20_000,
  /** One embedded image of a drawing, as decoded bytes. */
  drawingFileBytes: 8 * 1024 * 1024,
  libraryItems: 500,
} as const;

/** Days a card waits in the done column before it is archived (design 6.6). */
export const DONE_ARCHIVE_DAYS = 30;

/** Category palette for labels: space colour slots plus the status tones. */
export const LabelColor = z.enum([
  's1',
  's2',
  's3',
  's4',
  's5',
  's6',
  'info',
  'success',
  'warning',
  'danger',
]);
export type LabelColor = z.infer<typeof LabelColor>;

export const BoardLabel = z.object({
  /** Short stable id, referenced by cards. */
  id: z.string().regex(/^[a-z0-9]{1,16}$/),
  name: z.string().trim().min(1).max(40),
  color: LabelColor,
});
export type BoardLabel = z.infer<typeof BoardLabel>;

/** Templates set up columns, labels, WIP limits and fields only; never cards (design 6.7). */
export const BoardTemplate = z.enum(['empty', 'sprint', 'roadmap', 'bugs']);
export type BoardTemplate = z.infer<typeof BoardTemplate>;

export const CardPriority = z.enum(['p1', 'p2', 'p3']);
export type CardPriority = z.infer<typeof CardPriority>;

export const BoardSprint = z.object({
  name: z.string().trim().min(1).max(80),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
});
export type BoardSprint = z.infer<typeof BoardSprint>;

/**
 * Sprints of a board (kararlar 2026-10-29 "Panolarda proje yönetimi"): at most one active at a
 * time; a card without a sprint sits in the backlog. `settings.sprint` mirrors the active one.
 */
export const SprintStatus = z.enum(['planned', 'active', 'closed']);
export type SprintStatus = z.infer<typeof SprintStatus>;

/** Burndown unit: story points while the board has them, else the number of cards. */
export const SprintUnit = z.enum(['points', 'cards']);
export type SprintUnit = z.infer<typeof SprintUnit>;

export const Sprint = z.object({
  id: Id,
  boardId: Id,
  name: z.string(),
  goal: z.string(),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
  status: SprintStatus,
  startedAt: Timestamp.nullable(),
  closedAt: Timestamp.nullable(),
  /** Set when closed: how much of what the sprint held at its end was done. */
  result: z.object({ unit: SprintUnit, done: z.number(), total: z.number() }).nullable(),
  /** Live cards in the sprint, archived ones included. */
  cardCount: z.number().int(),
  createdAt: Timestamp,
});
export type Sprint = z.infer<typeof Sprint>;

const sprintFields = {
  name: z.string().trim().min(1).max(80),
  goal: z.string().trim().max(500),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
};

export const CreateSprint = z
  .object({ ...sprintFields, goal: sprintFields.goal.default('') })
  .refine((s) => s.endsOn >= s.startsOn, { path: ['endsOn'], message: 'ends_before_start' });

export const UpdateSprint = z.object(sprintFields).partial();

export const CloseSprint = z.object({
  /** A planned sprint for the unfinished cards; null sends them to the backlog. */
  moveTo: Id.nullable().default(null),
});

export const CloseSprintResult = z.object({ sprint: Sprint, moved: z.number().int() });

export const SprintBurndownQuery = z.object({
  /** IANA zone the days are counted in (the viewer's); UTC when absent or unknown. */
  tz: z.string().max(64).optional(),
});

export const SprintBurndown = z.object({
  sprintId: Id,
  unit: SprintUnit,
  /** One entry per calendar day from start to end; `remaining` is null for days to come. */
  days: z.array(
    z.object({
      date: z.iso.date(),
      /** Everything the sprint held by the end of the day. */
      scope: z.number(),
      remaining: z.number().nullable(),
      ideal: z.number(),
    }),
  ),
  total: z.number(),
  done: z.number(),
});
export type SprintBurndown = z.infer<typeof SprintBurndown>;

/** Card key prefix: `MLV` makes card 142 read `MLV-142`. */
export const BoardKey = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9]{1,5}$/);

export const BoardSettings = z.object({
  key: BoardKey,
  template: BoardTemplate,
  labels: z.array(BoardLabel).max(BOARD_LIMITS.labels),
  /** Every card opens its own conversation; off = comments only (design 6.7). */
  cardChats: z.boolean(),
  /** Optional card fields switched on by the template. */
  fields: z.object({ points: z.boolean(), priority: z.boolean() }),
  /** Cards resting in the done column are archived after this many days; null = never. */
  doneArchiveDays: z.number().int().min(1).max(365).nullable(),
  sprint: BoardSprint.nullable(),
  /** Workload: hours a person has per week on this board; 40 when absent. */
  capacityHours: z.number().int().min(1).max(168).optional(),
});
export type BoardSettings = z.infer<typeof BoardSettings>;

/** Hours a person is expected to have per week unless the board says otherwise. */
export const DEFAULT_CAPACITY_HOURS = 40;

export const BoardColumn = z.object({
  id: Id,
  boardId: Id,
  name: z.string(),
  /** Fractional key; columns sort by it in byte order. */
  position: z.string(),
  /** WIP limit: more cards is allowed but shown as a warning (design 6.2). */
  wipLimit: z.number().int().nullable(),
  /** The "completed" column: drives done_at, checklist progress and auto-archive. */
  isDone: z.boolean(),
});
export type BoardColumn = z.infer<typeof BoardColumn>;

export const ChecklistItem = z.object({
  id: z.string().regex(/^[a-z0-9]{1,16}$/),
  text: z.string().trim().min(1).max(500),
  done: z.boolean(),
  assigneeId: Id.nullable().default(null),
});
export type ChecklistItem = z.infer<typeof ChecklistItem>;

export const BoardCard = z.object({
  id: Id,
  boardId: Id,
  columnId: Id,
  /** Per-board sequence: with the board key it reads `MLV-142`. */
  number: z.number().int(),
  position: z.string(),
  title: z.string(),
  /** Plain text derived from the description document (first 280 characters). */
  excerpt: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(UserSummary),
  /** Planned start (timeline); the end is `dueAt`. Absent from servers before timelines. */
  startAt: Timestamp.nullable().optional(),
  dueAt: Timestamp.nullable(),
  points: z.number().int().nullable(),
  priority: CardPriority.nullable(),
  checklist: z.object({ done: z.number().int(), total: z.number().int() }),
  commentCount: z.number().int(),
  attachmentCount: z.number().int(),
  /** Card conversation (chat type `card`), opened with the first message. */
  conversationId: Id.nullable(),
  /** Sprint the card is planned in; null = backlog. Absent from servers before sprints. */
  sprintId: Id.nullable().optional(),
  /** Unfinished cards blocking this one (the "engelli" badge). */
  blockedBy: z.number().int().optional(),
  /** Planned effort; time tracking compares the logged minutes with it. */
  estimateMinutes: z.number().int().nullable().optional(),
  /** Minutes of finished time entries. */
  spentMinutes: z.number().int().optional(),
  doneAt: Timestamp.nullable(),
  archivedAt: Timestamp.nullable(),
  createdBy: UserSummary.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type BoardCard = z.infer<typeof BoardCard>;

/**
 * Card dependencies (kararlar 2026-10-29): `blocks` is directed, `relates` is not,
 * `duplicates` points at the original. Links may cross boards within the org; a reader
 * only sees the cards they can open.
 */
export const CardLinkKind = z.enum(['blocks', 'relates', 'duplicates']);
export type CardLinkKind = z.infer<typeof CardLinkKind>;

/** A link as read from one card. */
export const CardLinkType = z.enum([
  'blocks',
  'blocked_by',
  'relates',
  'duplicates',
  'duplicated_by',
]);
export type CardLinkType = z.infer<typeof CardLinkType>;

export const LinkedCard = z.object({
  id: Id,
  boardId: Id,
  boardName: z.string(),
  /** `MLV-142`. */
  key: z.string(),
  title: z.string(),
  columnName: z.string(),
  done: z.boolean(),
});
export type LinkedCard = z.infer<typeof LinkedCard>;

export const CardLink = z.object({
  id: Id,
  type: CardLinkType,
  card: LinkedCard,
  createdAt: Timestamp,
});
export type CardLink = z.infer<typeof CardLink>;

export const AddCardLink = z.object({ cardId: Id, type: CardLinkType });

export const BoardCardSearchQuery = z.object({
  /** Title words or a key (`MLV-142`, `142`). */
  q: z.string().trim().min(1).max(100),
  /** Cards of this board come first. */
  boardId: Id.optional(),
  limit: z.coerce.number().int().min(1).max(30).default(15),
});

/**
 * Time tracking (kararlar 2026-10-29): entries per card and person, from a timer or typed
 * in. One running timer per person (`minutes` null while it runs).
 */
export const TIME_LIMITS = {
  /** One entry: a day at most. */
  entryMinutes: 24 * 60,
  estimateMinutes: 100_000,
  noteLength: 500,
} as const;

export const TimeEntry = z.object({
  id: Id,
  cardId: Id,
  user: UserSummary,
  startedAt: Timestamp,
  /** Null while the timer runs. */
  minutes: z.number().int().nullable(),
  note: z.string(),
  source: z.enum(['timer', 'manual']),
  /** Own entries, or every entry for board managers. */
  canEdit: z.boolean(),
});
export type TimeEntry = z.infer<typeof TimeEntry>;

export const AddTimeEntry = z.object({
  minutes: z.number().int().min(1).max(TIME_LIMITS.entryMinutes),
  /** When the work was done; now when absent. */
  startedAt: Timestamp.optional(),
  note: z.string().trim().max(TIME_LIMITS.noteLength).default(''),
});

export const UpdateTimeEntry = z
  .object({
    minutes: z.number().int().min(1).max(TIME_LIMITS.entryMinutes),
    startedAt: Timestamp,
    note: z.string().trim().max(TIME_LIMITS.noteLength),
  })
  .partial();

/** The caller's running timer, with the card it runs on. */
export const MyTimer = z.object({
  entry: TimeEntry.extend({ card: LinkedCard }).nullable(),
});
export type MyTimer = z.infer<typeof MyTimer>;

export const StoppedTimer = z.object({ entry: TimeEntry.nullable() });

/**
 * Workload (kararlar 2026-10-29): estimated hours of open, assigned cards per person and
 * week. A card spreads over the days from its start to its due date (one date: that day's
 * week; none: its sprint's dates) and splits between its assignees. Cards without an
 * estimate are counted, not guessed.
 */
export const WorkloadQuery = z.object({
  /** Any day of the first week (weeks start on Monday); this week when absent. */
  from: z.iso.date().optional(),
  weeks: z.coerce.number().int().min(1).max(26).default(8),
  /** IANA zone the days are counted in; UTC when absent or unknown. */
  tz: z.string().max(64).optional(),
});

export const WorkloadCell = z.object({
  hours: z.number(),
  /** Cards touching the cell, with and without an estimate. */
  cardIds: z.array(Id),
  unestimated: z.number().int(),
});
export type WorkloadCell = z.infer<typeof WorkloadCell>;

export const Workload = z.object({
  /** Mondays of the weeks, in order. */
  weeks: z.array(z.iso.date()),
  capacityHours: z.number().int(),
  people: z.array(
    z.object({
      user: UserSummary,
      cells: z.array(WorkloadCell),
      /** Open assigned cards with no dates and no running or planned sprint. */
      undated: WorkloadCell,
    }),
  ),
  cards: z.array(
    z.object({
      id: Id,
      boardId: Id,
      key: z.string(),
      title: z.string(),
      estimateMinutes: z.number().int().nullable(),
    }),
  ),
});
export type Workload = z.infer<typeof Workload>;

export const BoardCardAttachment = z.object({
  nodeId: Id,
  name: z.string(),
  type: z.enum(['folder', 'file', 'page', 'board', 'drawing']),
  mime: z.string().nullable(),
  sizeBytes: z.number().int(),
  addedBy: UserSummary.nullable(),
  addedAt: Timestamp,
});
export type BoardCardAttachment = z.infer<typeof BoardCardAttachment>;

export const BoardCardDetail = BoardCard.extend({
  description: z.string(),
  checklistItems: z.array(ChecklistItem),
  attachments: z.array(BoardCardAttachment),
  followerIds: z.array(Id),
  following: z.boolean(),
  /** Links to cards the reader can see. Absent from servers before dependencies. */
  links: z.array(CardLink).optional(),
  board: z.object({
    id: Id,
    name: z.string(),
    key: z.string(),
    spaceId: Id,
    myRole: SpaceRole,
  }),
});
export type BoardCardDetail = z.infer<typeof BoardCardDetail>;

export const Board = z.object({
  id: Id,
  spaceId: Id,
  parentId: Id.nullable(),
  name: z.string(),
  settings: BoardSettings,
  /** Bumped on every change of columns, cards or settings (cheap "has it changed?"). */
  rev: z.number().int(),
  myRole: SpaceRole,
  /** Columns, labels, WIP and fields: space admins or the board's creator (design 6.6). */
  canManage: z.boolean(),
  space: z.object({ id: Id, name: z.string(), slug: z.string(), color: SpaceColor }),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Board = z.infer<typeof Board>;

/**
 * A board opened from a public link (H15): columns and the cards' titles, keys, labels and
 * dates only; no people, descriptions or comments.
 */
export const PublicBoard = z.object({
  id: Id,
  name: z.string(),
  key: z.string(),
  labels: z.array(BoardLabel),
  columns: z.array(z.object({ id: Id, name: z.string(), isDone: z.boolean() })),
  cards: z.array(
    z.object({
      id: Id,
      columnId: Id,
      number: z.number().int(),
      title: z.string(),
      labels: z.array(z.string()),
      dueAt: Timestamp.nullable(),
      priority: CardPriority.nullable(),
      checklist: z.object({ done: z.number().int(), total: z.number().int() }),
      doneAt: Timestamp.nullable(),
    }),
  ),
  updatedAt: Timestamp,
});
export type PublicBoard = z.infer<typeof PublicBoard>;

export const BoardDetail = z.object({
  board: Board,
  columns: z.array(BoardColumn),
  /** Every live card that is not archived, in column and position order. */
  cards: z.array(BoardCard),
  archivedCount: z.number().int(),
  /** People who can be assigned: space members and people the board is shared with. */
  people: z.array(UserSummary),
  /** Planned and active sprints, by start date. Absent from servers before sprints. */
  sprints: z.array(Sprint).optional(),
  /** `blocks` links between cards of this board (timeline arrows). */
  dependencies: z.array(z.object({ fromId: Id, toId: Id })).optional(),
});
export type BoardDetail = z.infer<typeof BoardDetail>;

export const BoardSummary = z.object({
  id: Id,
  spaceId: Id,
  parentId: Id.nullable(),
  name: z.string(),
  key: z.string(),
  cardCount: z.number().int(),
  updatedAt: Timestamp,
});
export type BoardSummary = z.infer<typeof BoardSummary>;

export const BoardRev = z.object({ rev: z.number().int() });

export const CreateBoard = z.object({
  parentId: Id.nullable().default(null),
  name: z.string().trim().min(1).max(200),
  template: BoardTemplate.default('empty'),
  cardChats: z.boolean().default(true),
  key: BoardKey.optional(),
  /** IANA zone whose "today" a template's first sprint starts on (the creator's); their saved zone when absent or unknown. */
  tz: z.string().max(64).optional(),
});

export const UpdateBoard = z
  .object({
    name: z.string().trim().min(1).max(200),
    key: BoardKey,
    labels: z.array(BoardLabel).max(BOARD_LIMITS.labels),
    cardChats: z.boolean(),
    fields: z.object({ points: z.boolean(), priority: z.boolean() }),
    doneArchiveDays: z.number().int().min(1).max(365).nullable(),
    sprint: BoardSprint.nullable(),
    capacityHours: z.number().int().min(1).max(168),
  })
  .partial();

/** Place between two neighbours; both null = end of the list. */
export const Placement = z.object({
  afterId: Id.nullable().default(null),
  beforeId: Id.nullable().default(null),
});

export const CreateBoardColumn = Placement.extend({
  name: z.string().trim().min(1).max(80),
  wipLimit: z.number().int().min(1).max(999).nullable().default(null),
  isDone: z.boolean().default(false),
});

export const UpdateBoardColumn = z
  .object({
    name: z.string().trim().min(1).max(80),
    wipLimit: z.number().int().min(1).max(999).nullable(),
    isDone: z.boolean(),
  })
  .partial();

export const DeleteBoardColumnQuery = z.object({
  /** Where the column's cards go; required when it still has cards. */
  moveTo: Id.optional(),
});

export const CreateBoardCard = Placement.extend({
  columnId: Id,
  title: z.string().trim().min(1).max(BOARD_LIMITS.titleLength),
  /** Inserted at the top of the column instead of the end (ignored with neighbours). */
  top: z.boolean().default(false),
  description: z.string().max(BOARD_LIMITS.descriptionLength).optional(),
  labels: z.array(z.string()).max(20).default([]),
  assigneeIds: z.array(Id).max(20).default([]),
  dueAt: Timestamp.nullable().default(null),
  /** Not after `dueAt`. */
  startAt: Timestamp.nullable().optional(),
  /** Absent: the active sprint, if any (cards made on the board); null: the backlog. */
  sprintId: Id.nullable().optional(),
});

export const UpdateBoardCard = z
  .object({
    title: z.string().trim().min(1).max(BOARD_LIMITS.titleLength),
    /** Replaces the description document's content (HTTP and MCP writers). */
    description: z.string().max(BOARD_LIMITS.descriptionLength),
    labels: z.array(z.string()).max(20),
    dueAt: Timestamp.nullable(),
    /** Not after `dueAt` (validation_failed). */
    startAt: Timestamp.nullable(),
    estimateMinutes: z.number().int().min(0).max(TIME_LIMITS.estimateMinutes).nullable(),
    points: z.number().int().min(0).max(999).nullable(),
    priority: CardPriority.nullable(),
    checklistItems: z.array(ChecklistItem).max(BOARD_LIMITS.checklistItems),
    archived: z.boolean(),
    /** A planned or the active sprint of the card's board; null = backlog. */
    sprintId: Id.nullable(),
  })
  .partial();

export const MoveBoardCard = Placement.extend({ columnId: Id });

export const MoveResult = z.object({
  card: BoardCard,
  /** Target column after the move: a limit is a warning, never a refusal. */
  wip: z.object({
    count: z.number().int(),
    limit: z.number().int().nullable(),
    exceeded: z.boolean(),
  }),
});
export type MoveResult = z.infer<typeof MoveResult>;

export const SetCardAssignees = z.object({ userIds: z.array(Id).max(20) });

export const BulkBoardCards = z.object({
  cardIds: z.array(Id).min(1).max(200),
  columnId: Id.optional(),
  addAssigneeIds: z.array(Id).max(20).optional(),
  addLabels: z.array(z.string()).max(20).optional(),
  archive: z.boolean().optional(),
  /** Planning: a planned or the active sprint; null = backlog. */
  sprintId: Id.nullable().optional(),
});
export const BulkResult = z.object({ updated: z.number().int() });

export const BoardActivityKind = z.enum([
  'created',
  'moved',
  'renamed',
  'assigned',
  'unassigned',
  'due_changed',
  'checklist_done',
  'archived',
  'restored',
  'comment',
  'attachment_added',
]);
export type BoardActivityKind = z.infer<typeof BoardActivityKind>;

/** One line of a card's activity: system lines and comments (comments-only boards). */
export const BoardActivity = z.object({
  id: Id,
  cardId: Id,
  kind: BoardActivityKind,
  actor: UserSummary.nullable(),
  /** Comment text, for `comment`. */
  text: z.string().nullable(),
  /** Flat values for the i18n line: fromColumn, toColumn, userName, dueAt, count… */
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  createdAt: Timestamp,
  editedAt: Timestamp.nullable(),
});
export type BoardActivity = z.infer<typeof BoardActivity>;

export const AddBoardComment = z.object({
  text: z.string().trim().min(1).max(BOARD_LIMITS.commentLength),
});

export const AddCardAttachment = z.object({ nodeId: Id });

export const SetFollowing = z.object({ following: z.boolean() });

export const CardConversation = z.object({ conversationId: Id });

export const AttachmentTarget = z.object({ spaceId: Id, folderId: Id });

export const MyBoardCardsQuery = z.object({
  /** assigned: open cards assigned to me; due: mine due within 3 days or overdue. */
  scope: z.enum(['assigned', 'due']).default('assigned'),
  spaceId: Id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const MyBoardCard = BoardCard.extend({
  board: z.object({ id: Id, name: z.string(), key: z.string(), spaceId: Id }),
  column: z.object({ id: Id, name: z.string(), isDone: z.boolean() }),
});
export type MyBoardCard = z.infer<typeof MyBoardCard>;

export const ArchivedCardsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---- Drawings -----------------------------------------------------------------------------

/**
 * An Excalidraw element as stored in the scene map. The server only relies on the fields
 * below (merging by version, thumbnails); every other property is kept as is.
 */
export const DrawingElement = z
  .object({
    id: z.string().min(1).max(64),
    type: z.string().min(1).max(32),
    version: z.number().int(),
    versionNonce: z.number().int().optional(),
    isDeleted: z.boolean().optional(),
    /** Fractional order key (Excalidraw 0.17+). */
    index: z.string().nullable().optional(),
  })
  .loose();
export type DrawingElement = z.infer<typeof DrawingElement>;

export const DrawingFile = z.object({
  fileId: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int(),
  createdAt: Timestamp,
});

export const Drawing = z.object({
  id: Id,
  spaceId: Id,
  parentId: Id.nullable(),
  name: z.string(),
  myRole: SpaceRole,
  /** Bumped with every stored change of the scene. */
  sceneRev: z.number().int(),
  elementCount: z.number().int(),
  /** Thumbnail for Drive: ready once the worker rendered `thumbnailRev`. */
  thumbnail: z.object({ ready: z.boolean(), rev: z.number().int() }),
  files: z.array(DrawingFile),
  space: z.object({ id: Id, name: z.string(), slug: z.string(), color: SpaceColor }),
  createdBy: UserSummary.nullable(),
  updatedBy: UserSummary.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Drawing = z.infer<typeof Drawing>;

export const DrawingSummary = z.object({
  id: Id,
  spaceId: Id,
  parentId: Id.nullable(),
  name: z.string(),
  elementCount: z.number().int(),
  thumbnailReady: z.boolean(),
  updatedAt: Timestamp,
});
export type DrawingSummary = z.infer<typeof DrawingSummary>;

export const CreateDrawing = z.object({
  parentId: Id.nullable().default(null),
  name: z.string().trim().min(1).max(200),
});

export const DrawingScene = z.object({
  elements: z.array(DrawingElement).max(BOARD_LIMITS.sceneElements),
  sceneRev: z.number().int(),
});
export type DrawingScene = z.infer<typeof DrawingScene>;

/**
 * HTTP write of elements (no live session: MCP, import, fallback). Merged per element:
 * the higher version wins, like the collaborative path.
 */
export const SaveDrawingScene = z.object({
  elements: z.array(DrawingElement).max(BOARD_LIMITS.sceneElements),
});

export const UploadDrawingFile = z.object({
  fileId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  /** `data:<mime>;base64,…` as Excalidraw keeps it. */
  dataURL: z.string().max(Math.ceil((BOARD_LIMITS.drawingFileBytes * 4) / 3) + 200),
});

export const DrawingFileUrl = z.object({ url: z.url(), expiresAt: Timestamp, mime: z.string() });

export const LibraryScope = z.enum(['personal', 'space']);

export const DrawingLibraryQuery = z.object({ spaceId: Id.optional() });

/** Excalidraw library items (`.excalidrawlib` "libraryItems"), kept as JSON. */
export const LibraryItem = z
  .object({
    id: z.string().min(1).max(64),
    status: z.enum(['published', 'unpublished']).optional(),
    elements: z.array(DrawingElement).max(2000),
    name: z.string().max(200).optional(),
    created: z.number().optional(),
  })
  .loose();
export type LibraryItem = z.infer<typeof LibraryItem>;

export const DrawingLibrary = z.object({
  personal: z.array(LibraryItem),
  /** Null when no space was asked for. */
  space: z.array(LibraryItem).nullable(),
  canEditSpace: z.boolean(),
});
export type DrawingLibrary = z.infer<typeof DrawingLibrary>;

export const UpdateDrawingLibrary = z.object({
  scope: LibraryScope,
  spaceId: Id.optional(),
  items: z.array(LibraryItem).max(BOARD_LIMITS.libraryItems),
});

// ---- Collaboration ----------------------------------------------------------------------

/** Yjs document names served by the collab server for this module (doc 17 §3). */
export const BoardsCollabDocument = z
  .string()
  .regex(/^(card|drawing):[0-9a-f-]{36}$/, 'card:<id> or drawing:<nodeId>');

export const CollabTokenRequest = z.object({ document: BoardsCollabDocument });

export const CollabToken = z.object({
  token: z.string(),
  /** WebSocket URL of the collab server, or a path on the hub's origin (`resolveCollabUrl`). */
  url: z.string(),
  document: z.string(),
  readOnly: z.boolean(),
  expiresAt: Timestamp,
});
export type CollabToken = z.infer<typeof CollabToken>;

// ---- Events and notifications ----------------------------------------------------------------

/** Notification types of this module (`web.chat.notifications.<type>` style keys). */
export const BOARDS_NOTIFICATION_TYPES = [
  'boards.assigned',
  'boards.comment',
  'boards.due_soon',
] as const;

/**
 * WS events for the chat gateway's WsServerEvent union (added there when merged). Until
 * then clients poll `getBoardRev`.
 */
export const BoardsWsEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('board.changed'), boardId: Id, rev: z.number().int() }),
  z.object({ type: z.literal('drawing.thumbnail'), nodeId: Id, rev: z.number().int() }),
]);
export type BoardsWsEvent = z.infer<typeof BoardsWsEvent>;

/** Non-JSON routes of the module (302 to signed URLs, session cookie). */
export const BOARDS_RAW_PATHS = {
  drawingFile: '/api/v1/drawings/:nodeId/files/:file/raw',
  drawingThumbnail: '/api/v1/drawings/:nodeId/thumbnail/raw',
} as const;
