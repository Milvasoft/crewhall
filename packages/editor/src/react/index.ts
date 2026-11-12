/**
 * @crewhall/editor/react: the block editor (Tiptap 3, MIT core only) for the portal and wiki
 * document model. Import the styles once: `import '@crewhall/editor/styles.css'`.
 */
export { RichEditor, type RichEditorHandle, type RichEditorProps } from './RichEditor';
export { editorLabelKeys, type EditorLabels } from './labels';
export type { PickedVideo } from './ui/context';
export {
  createExtensions,
  filterSlashItems,
  looksLikeMarkdown,
  markdownToBlocks,
  type CollaborationCaretProvider,
  type CollaborationOptions,
  type CreateExtensionsOptions,
  type SlashItem,
  type ViewNodeName,
} from './extensions';
export { editorSchema, validateDoc } from './validate';
export {
  BLOCK_KINDS,
  blockAround,
  blockAtPos,
  blockAtSelection,
  blockColor,
  blockKind,
  canColor,
  canTurnInto,
  canTurnIntoToggle,
  colorBlock,
  copyBlock,
  deleteBlock,
  dropListItem,
  duplicateBlock,
  moveBlock,
  moveBlockTo,
  selectionKind,
  turnBlockInto,
  turnBlockIntoToggle,
  turnSelectionInto,
  type BlockAt,
  type BlockKind,
} from './extensions/blocks';
export { dropTarget, LONG_PRESS_MS, TouchBlockDrag } from './extensions/touch-drag';
export {
  clearFind,
  findMatches,
  findState,
  replaceAll,
  replaceCurrent,
  setFind,
  stepFind,
} from './extensions/find';
export {
  headingElement,
  outlineDepth,
  outlineOf,
  scrollToHeading,
  useOutline,
  type OutlineItem,
} from './outline';
export {
  AssistHighlight,
  applyAssistResult,
  assistRange,
  markdownBefore,
  rangeMarkdown,
  setAssistRange,
  type AssistApplyMode,
  type AssistRange,
} from './assist';
