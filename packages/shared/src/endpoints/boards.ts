import { def, Empty, items, type EndpointDef } from '../endpoint-def';
import {
  AddBoardComment,
  AddCardAttachment,
  ArchivedCardsQuery,
  AttachmentTarget,
  Board,
  BoardActivity,
  BoardCard,
  BoardCardDetail,
  BoardColumn,
  BoardDetail,
  BoardRev,
  BoardSummary,
  BulkBoardCards,
  BulkResult,
  CardConversation,
  AddCardLink,
  Workload,
  WorkloadQuery,
  AddTimeEntry,
  MyTimer,
  StoppedTimer,
  TimeEntry,
  UpdateTimeEntry,
  BoardCardSearchQuery,
  CardLink,
  LinkedCard,
  CloseSprint,
  CloseSprintResult,
  CreateSprint,
  Sprint,
  SprintBurndown,
  SprintBurndownQuery,
  UpdateSprint,
  CollabToken,
  CollabTokenRequest,
  CreateBoard,
  CreateBoardCard,
  CreateBoardColumn,
  CreateDrawing,
  DeleteBoardColumnQuery,
  Drawing,
  PublicBoard,
  DrawingFileUrl,
  DrawingLibrary,
  DrawingLibraryQuery,
  DrawingScene,
  DrawingSummary,
  MoveBoardCard,
  MoveResult,
  MyBoardCard,
  MyBoardCardsQuery,
  Placement,
  SaveDrawingScene,
  SetCardAssignees,
  SetFollowing,
  UpdateBoard,
  UpdateBoardCard,
  UpdateBoardColumn,
  UpdateDrawingLibrary,
  UploadDrawingFile,
  DrawingFile,
} from '../schemas/boards';
import { PublicViewQuery } from '../schemas/wiki';
import { page, PageQuery } from '../schemas/common';

/**
 * Boards module contract (design 06, mobile 14.16-14.18; doc 17 §4, §6).
 * Only the boards session edits this file; see docs/contracts/moduller.md.
 *
 * Board and drawing nodes live in the Drive tree: rename, move, trash, share and favorites
 * go through the Drive endpoints. Outside this table: BOARDS_RAW_PATHS in schemas/boards.
 */
export const boardsEndpoints = {
  /** Public link (H15): a shared board, or a board inside a shared folder, read-only. */
  getPublicBoard: def({
    method: 'GET',
    path: '/api/v1/public/shares/:token/board',
    auth: 'public',
    query: PublicViewQuery,
    response: PublicBoard,
  }),
  // ---- Boards ---------------------------------------------------------------------------
  listBoards: def({
    method: 'GET',
    path: '/api/v1/spaces/:spaceId/boards',
    auth: 'session',
    response: items(BoardSummary),
  }),
  createBoard: def({
    method: 'POST',
    path: '/api/v1/spaces/:spaceId/boards',
    auth: 'session',
    body: CreateBoard,
    response: Board,
  }),
  /** Columns, every open card and the assignable people in one call. */
  getBoard: def({
    method: 'GET',
    path: '/api/v1/boards/:boardId',
    auth: 'session',
    response: BoardDetail,
  }),
  /** Cheap change check for clients without the WS gateway. */
  getBoardRev: def({
    method: 'GET',
    path: '/api/v1/boards/:boardId/rev',
    auth: 'session',
    response: BoardRev,
  }),
  /** Settings (labels, key, fields, sprint); space admins only. Name: any editor. */
  updateBoard: def({
    method: 'PATCH',
    path: '/api/v1/boards/:boardId',
    auth: 'session',
    body: UpdateBoard,
    response: Board,
  }),
  listArchivedBoardCards: def({
    method: 'GET',
    path: '/api/v1/boards/:boardId/archived',
    auth: 'session',
    query: ArchivedCardsQuery,
    response: page(BoardCard),
  }),
  /** Folder for uploaded card attachments ("<board> · Ekler" next to the board). */
  getBoardAttachmentFolder: def({
    method: 'POST',
    path: '/api/v1/boards/:boardId/attachment-folder',
    auth: 'session',
    response: AttachmentTarget,
  }),

  // ---- Columns --------------------------------------------------------------------------
  createBoardColumn: def({
    method: 'POST',
    path: '/api/v1/boards/:boardId/columns',
    auth: 'session',
    body: CreateBoardColumn,
    response: BoardColumn,
  }),
  updateBoardColumn: def({
    method: 'PATCH',
    path: '/api/v1/board-columns/:columnId',
    auth: 'session',
    body: UpdateBoardColumn,
    response: BoardColumn,
  }),
  moveBoardColumn: def({
    method: 'POST',
    path: '/api/v1/board-columns/:columnId/move',
    auth: 'session',
    body: Placement,
    response: BoardColumn,
  }),
  /** A column with cards needs `?moveTo=`; the last column cannot go. */
  deleteBoardColumn: def({
    method: 'DELETE',
    path: '/api/v1/board-columns/:columnId',
    auth: 'session',
    query: DeleteBoardColumnQuery,
    response: Empty,
  }),

  // ---- Cards ----------------------------------------------------------------------------
  createBoardCard: def({
    method: 'POST',
    path: '/api/v1/boards/:boardId/cards',
    auth: 'session',
    body: CreateBoardCard,
    response: BoardCard,
  }),
  /** `/b/<board>/MLV-142` addresses: the card by its number. */
  getBoardCardByNumber: def({
    method: 'GET',
    path: '/api/v1/boards/:boardId/cards/:number',
    auth: 'session',
    response: BoardCardDetail,
  }),
  getBoardCard: def({
    method: 'GET',
    path: '/api/v1/board-cards/:cardId',
    auth: 'session',
    response: BoardCardDetail,
  }),
  updateBoardCard: def({
    method: 'PATCH',
    path: '/api/v1/board-cards/:cardId',
    auth: 'session',
    body: UpdateBoardCard,
    response: BoardCardDetail,
  }),
  /** Fractional position between the neighbours is computed on the server. */
  moveBoardCard: def({
    method: 'POST',
    path: '/api/v1/board-cards/:cardId/move',
    auth: 'session',
    body: MoveBoardCard,
    response: MoveResult,
  }),
  /** Soft delete; restorable for 30 days by the board's editors. */
  deleteBoardCard: def({
    method: 'DELETE',
    path: '/api/v1/board-cards/:cardId',
    auth: 'session',
    response: Empty,
  }),
  restoreBoardCard: def({
    method: 'POST',
    path: '/api/v1/board-cards/:cardId/restore',
    auth: 'session',
    response: BoardCard,
  }),
  /** List view: move, assign, label or archive many cards at once (design 6.5). */
  bulkUpdateBoardCards: def({
    method: 'POST',
    path: '/api/v1/boards/:boardId/cards/bulk',
    auth: 'session',
    body: BulkBoardCards,
    response: BulkResult,
  }),
  setBoardCardAssignees: def({
    method: 'PUT',
    path: '/api/v1/board-cards/:cardId/assignees',
    auth: 'session',
    body: SetCardAssignees,
    response: BoardCard,
  }),
  setBoardCardFollowing: def({
    method: 'PUT',
    path: '/api/v1/board-cards/:cardId/following',
    auth: 'session',
    body: SetFollowing,
    response: Empty,
  }),
  listBoardCardActivity: def({
    method: 'GET',
    path: '/api/v1/board-cards/:cardId/activity',
    auth: 'session',
    query: PageQuery,
    response: page(BoardActivity),
  }),
  addBoardCardComment: def({
    method: 'POST',
    path: '/api/v1/board-cards/:cardId/comments',
    auth: 'session',
    body: AddBoardComment,
    response: BoardActivity,
  }),
  deleteBoardCardComment: def({
    method: 'DELETE',
    path: '/api/v1/board-card-comments/:activityId',
    auth: 'session',
    response: Empty,
  }),
  addBoardCardAttachment: def({
    method: 'POST',
    path: '/api/v1/board-cards/:cardId/attachments',
    auth: 'session',
    body: AddCardAttachment,
    response: BoardCardDetail,
  }),
  removeBoardCardAttachment: def({
    method: 'DELETE',
    path: '/api/v1/board-cards/:cardId/attachments/:nodeId',
    auth: 'session',
    response: BoardCardDetail,
  }),
  /**
   * The card's conversation (chat type `card`), created on first use. Answers
   * `boards_chat_unavailable` while the board has card chats off or chat is not installed.
   */
  openBoardCardConversation: def({
    method: 'POST',
    path: '/api/v1/board-cards/:cardId/conversation',
    auth: 'session',
    response: CardConversation,
  }),
  /** "Bana atananlar" and "Süresi yaklaşanlar" across every board the caller can see. */

  // ---- Dependencies (kararlar 2026-10-29) ----------------------------------------------
  listBoardCardLinks: def({
    method: 'GET',
    path: '/api/v1/board-cards/:cardId/links',
    auth: 'session',
    response: items(CardLink),
  }),
  /** Answers with the card's links; 409 board_link_cycle when `blocks` would loop. */
  addBoardCardLink: def({
    method: 'POST',
    path: '/api/v1/board-cards/:cardId/links',
    auth: 'session',
    body: AddCardLink,
    response: items(CardLink),
  }),
  removeBoardCardLink: def({
    method: 'DELETE',
    path: '/api/v1/board-card-links/:linkId',
    auth: 'session',
    response: Empty,
  }),
  /** Cards to link to: on boards the caller can see, by title or key. */
  searchBoardCards: def({
    method: 'GET',
    path: '/api/v1/board-card-search',
    auth: 'session',
    query: BoardCardSearchQuery,
    response: items(LinkedCard),
  }),

  // ---- Time tracking (kararlar 2026-10-29) --------------------------------------------
  listBoardCardTime: def({
    method: 'GET',
    path: '/api/v1/board-cards/:cardId/time',
    auth: 'session',
    response: items(TimeEntry),
  }),
  /** Typed in by hand (editors and up). */
  addBoardCardTime: def({
    method: 'POST',
    path: '/api/v1/board-cards/:cardId/time',
    auth: 'session',
    body: AddTimeEntry,
    response: TimeEntry,
  }),
  /** Starts the caller's timer on the card; a timer running elsewhere stops first. */
  startBoardCardTimer: def({
    method: 'POST',
    path: '/api/v1/board-cards/:cardId/timer',
    auth: 'session',
    response: TimeEntry,
  }),
  getMyBoardTimer: def({
    method: 'GET',
    path: '/api/v1/me/board-timer',
    auth: 'session',
    response: MyTimer,
  }),
  /** Stops the caller's running timer, if any; answers with the finished entry. */
  stopMyBoardTimer: def({
    method: 'POST',
    path: '/api/v1/me/board-timer/stop',
    auth: 'session',
    response: StoppedTimer,
  }),
  updateBoardTimeEntry: def({
    method: 'PATCH',
    path: '/api/v1/board-time-entries/:entryId',
    auth: 'session',
    body: UpdateTimeEntry,
    response: TimeEntry,
  }),
  deleteBoardTimeEntry: def({
    method: 'DELETE',
    path: '/api/v1/board-time-entries/:entryId',
    auth: 'session',
    response: Empty,
  }),

  // ---- Workload (kararlar 2026-10-29) ---------------------------------------------------
  getBoardWorkload: def({
    method: 'GET',
    path: '/api/v1/boards/:boardId/workload',
    auth: 'session',
    query: WorkloadQuery,
    response: Workload,
  }),
  /** Every board of the space; capacity is the default per person. */
  getSpaceBoardWorkload: def({
    method: 'GET',
    path: '/api/v1/spaces/:spaceId/board-workload',
    auth: 'session',
    query: WorkloadQuery,
    response: Workload,
  }),

  // ---- Sprints (kararlar 2026-10-29) ----------------------------------------------------
  listBoardSprints: def({
    method: 'GET',
    path: '/api/v1/boards/:boardId/sprints',
    auth: 'session',
    response: items(Sprint),
  }),
  createBoardSprint: def({
    method: 'POST',
    path: '/api/v1/boards/:boardId/sprints',
    auth: 'session',
    body: CreateSprint,
    response: Sprint,
  }),
  updateBoardSprint: def({
    method: 'PATCH',
    path: '/api/v1/board-sprints/:sprintId',
    auth: 'session',
    body: UpdateSprint,
    response: Sprint,
  }),
  /** Only a planned sprint; its cards go back to the backlog. */
  deleteBoardSprint: def({
    method: 'DELETE',
    path: '/api/v1/board-sprints/:sprintId',
    auth: 'session',
    response: Empty,
  }),
  /** Board managers; 409 board_sprint_active while another sprint runs. */
  startBoardSprint: def({
    method: 'POST',
    path: '/api/v1/board-sprints/:sprintId/start',
    auth: 'session',
    response: Sprint,
  }),
  /** Board managers; unfinished cards move to `moveTo` or the backlog. */
  closeBoardSprint: def({
    method: 'POST',
    path: '/api/v1/board-sprints/:sprintId/close',
    auth: 'session',
    body: CloseSprint,
    response: CloseSprintResult,
  }),
  getBoardSprintBurndown: def({
    method: 'GET',
    path: '/api/v1/board-sprints/:sprintId/burndown',
    auth: 'session',
    query: SprintBurndownQuery,
    response: SprintBurndown,
  }),

  listMyBoardCards: def({
    method: 'GET',
    path: '/api/v1/me/board-cards',
    auth: 'session',
    query: MyBoardCardsQuery,
    response: items(MyBoardCard),
  }),
} as const satisfies Record<string, EndpointDef>;

/** Drawings module (its own switch `drawings` since 2026-10-29; boards embed drawings too). */
export const drawingsEndpoints = {
  listDrawings: def({
    method: 'GET',
    path: '/api/v1/spaces/:spaceId/drawings',
    auth: 'session',
    response: items(DrawingSummary),
  }),
  createDrawing: def({
    method: 'POST',
    path: '/api/v1/spaces/:spaceId/drawings',
    auth: 'session',
    body: CreateDrawing,
    response: Drawing,
  }),
  getDrawing: def({
    method: 'GET',
    path: '/api/v1/drawings/:nodeId',
    auth: 'session',
    response: Drawing,
  }),
  /** Elements as stored (read-only views, export, clients without the collab server). */
  getDrawingScene: def({
    method: 'GET',
    path: '/api/v1/drawings/:nodeId/scene',
    auth: 'session',
    response: DrawingScene,
  }),
  saveDrawingScene: def({
    method: 'PUT',
    path: '/api/v1/drawings/:nodeId/scene',
    auth: 'session',
    body: SaveDrawingScene,
    response: DrawingScene,
  }),
  /** Stores an embedded image; the scene keeps only its file id. Same id = no-op. */
  uploadDrawingFile: def({
    method: 'POST',
    path: '/api/v1/drawings/:nodeId/files',
    auth: 'session',
    body: UploadDrawingFile,
    response: DrawingFile,
  }),
  getDrawingFileUrl: def({
    method: 'GET',
    path: '/api/v1/drawings/:nodeId/files/:file',
    auth: 'session',
    response: DrawingFileUrl,
  }),
  getDrawingLibrary: def({
    method: 'GET',
    path: '/api/v1/drawing-library',
    auth: 'session',
    query: DrawingLibraryQuery,
    response: DrawingLibrary,
  }),
  updateDrawingLibrary: def({
    method: 'PUT',
    path: '/api/v1/drawing-library',
    auth: 'session',
    body: UpdateDrawingLibrary,
    response: DrawingLibrary,
  }),
} as const satisfies Record<string, EndpointDef>;

/**
 * Collaboration tokens for `card:` (boards) and `drawing:` (drawings) documents. In no module
 * table: the service checks the switch of the document's own module.
 */
export const boardsCollabEndpoints = {
  /** Short-lived token for `card:<id>` and `drawing:<nodeId>` on the collab server. */
  createBoardsCollabToken: def({
    method: 'POST',
    path: '/api/v1/collab/boards-token',
    auth: 'session',
    body: CollabTokenRequest,
    response: CollabToken,
  }),
} as const satisfies Record<string, EndpointDef>;
