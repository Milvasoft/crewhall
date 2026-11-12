/** Boards module error codes; translations go to packages/i18n/src/locales/{tr,en}/errors/boards.json. */
export const BOARDS_ERROR_CODES = [
  'board_column_not_empty',
  'board_last_column',
  'board_limit_reached',
  'board_label_unknown',
  'board_assignee_not_member',
  'board_sprint_active',
  'board_sprint_state',
  'board_link_cycle',
  'boards_chat_unavailable',
  'drawing_file_too_large',
  'drawing_file_invalid',
  'collab_document_invalid',
] as const;

export const BOARDS_ERROR_STATUS: Record<(typeof BOARDS_ERROR_CODES)[number], number> = {
  board_column_not_empty: 409,
  board_last_column: 409,
  board_limit_reached: 409,
  board_label_unknown: 422,
  board_assignee_not_member: 422,
  board_sprint_active: 409,
  board_sprint_state: 409,
  board_link_cycle: 409,
  boards_chat_unavailable: 409,
  drawing_file_too_large: 413,
  drawing_file_invalid: 422,
  collab_document_invalid: 400,
};
