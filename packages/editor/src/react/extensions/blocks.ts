import { Extension, type Editor } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model';
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { dropPoint } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import { isBlockColor, MAX_COLUMNS, type BlockColor } from '../../model';

/**
 * Block actions behind the drag handle's menu and the keyboard (Notion / Outline style): move a
 * block up or down among its siblings, duplicate, delete and turn it into another block type.
 * A "block" is a list item when the caret is in a list, otherwise a top-level block. Every
 * action is one ProseMirror transaction, so it syncs over Yjs like any other edit.
 */

const ITEM_TYPES = new Set(['listItem', 'taskItem']);

export interface BlockAt {
  pos: number;
  node: PMNode;
}

/** The block at a position given by the drag handle (the start of the node). */
export function blockAtPos(state: EditorState, pos: number): BlockAt | null {
  if (pos < 0 || pos > state.doc.content.size) return null;
  const node = state.doc.nodeAt(pos);
  return node && !node.isInline ? { pos, node } : null;
}

/** The block holding the selection: the nearest list item, else the top-level block. */
export function blockAtSelection(state: EditorState): BlockAt | null {
  const { selection } = state;
  if (selection instanceof NodeSelection && !selection.node.isInline) {
    return { pos: selection.from, node: selection.node };
  }
  const $from = selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    if (ITEM_TYPES.has($from.node(d).type.name)) {
      return { pos: $from.before(d), node: $from.node(d) };
    }
  }
  if ($from.depth < 1) return null;
  return { pos: $from.before(1), node: $from.node(1) };
}

/** Keeps the selection at the same offset inside a block that moved by `delta`. */
function shiftedSelection(tr: Transaction, before: Selection, block: BlockAt, to: number) {
  if (before instanceof NodeSelection && before.from === block.pos) {
    return NodeSelection.create(tr.doc, to);
  }
  const end = block.pos + block.node.nodeSize;
  if (before.from < block.pos || before.to > end) return null;
  const delta = to - block.pos;
  try {
    return TextSelection.create(tr.doc, before.from + delta, before.to + delta);
  } catch {
    return Selection.near(tr.doc.resolve(to + 1));
  }
}

/** Moves the block one place up (-1) or down (1) among its siblings; false at the edge. */
export function moveBlock(editor: Editor, block: BlockAt | null, dir: -1 | 1): boolean {
  if (!block) return false;
  const { state } = editor;
  const $pos: ResolvedPos = state.doc.resolve(block.pos);
  const index = $pos.index();
  const parent = $pos.parent;
  const sibling = dir < 0 ? parent.maybeChild(index - 1) : parent.maybeChild(index + 1);
  if (!sibling) return false;
  const tr = state.tr;
  tr.delete(block.pos, block.pos + block.node.nodeSize);
  const to = dir < 0 ? block.pos - sibling.nodeSize : block.pos + sibling.nodeSize;
  tr.insert(to, block.node);
  const sel = shiftedSelection(tr, state.selection, block, to);
  if (sel) tr.setSelection(sel);
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Inserts a copy right after the block and puts the caret in it. */
export function duplicateBlock(editor: Editor, block: BlockAt | null): boolean {
  if (!block) return false;
  const { state } = editor;
  const to = block.pos + block.node.nodeSize;
  const tr = state.tr.insert(to, block.node.copy(block.node.content));
  tr.setSelection(Selection.near(tr.doc.resolve(to + 1)));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Removes the block; the only item of a list removes the list, the only block leaves a paragraph. */
export function deleteBlock(editor: Editor, block: BlockAt | null): boolean {
  if (!block) return false;
  const { state } = editor;
  let { pos, node } = block;
  let $pos = state.doc.resolve(pos);
  while (ITEM_TYPES.has(node.type.name) && $pos.parent.childCount === 1 && $pos.depth > 0) {
    pos = $pos.before($pos.depth);
    node = $pos.parent;
    $pos = state.doc.resolve(pos);
  }
  const tr = state.tr;
  if ($pos.parent.type.name === 'doc' && $pos.parent.childCount === 1) {
    tr.replaceWith(pos, pos + node.nodeSize, state.schema.nodes.paragraph!.create());
  } else {
    tr.delete(pos, pos + node.nodeSize);
  }
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size))));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export type BlockKind =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'codeBlock';

export const BLOCK_KINDS: BlockKind[] = [
  'paragraph',
  'heading1',
  'heading2',
  'heading3',
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'codeBlock',
];

/** Text blocks (and list items holding one) can change type; tables, images … cannot. */
export function canTurnInto(block: BlockAt | null): boolean {
  if (!block) return false;
  const { node } = block;
  if (node.isTextblock) return true;
  return ITEM_TYPES.has(node.type.name) && Boolean(node.firstChild?.isTextblock);
}

/** The current kind, to mark it in the menu. */
export function blockKind(block: BlockAt | null, state: EditorState): BlockKind | null {
  if (!block) return null;
  const { node } = block;
  if (ITEM_TYPES.has(node.type.name)) {
    const list = state.doc.resolve(block.pos).parent.type.name;
    return list === 'bulletList' || list === 'orderedList' || list === 'taskList' ? list : null;
  }
  if (node.type.name === 'heading') {
    const level = Number(node.attrs.level);
    return level === 1 ? 'heading1' : level === 2 ? 'heading2' : level === 3 ? 'heading3' : null;
  }
  if (node.type.name === 'paragraph' || node.type.name === 'codeBlock') return node.type.name;
  return null;
}

/** Turns the block into another kind with the caret in its first text block. */
export function turnBlockInto(editor: Editor, block: BlockAt | null, kind: BlockKind): boolean {
  if (!canTurnInto(block) || !block) return false;
  const inner = block.node.isTextblock ? block.pos + 1 : block.pos + 2;
  const chain = editor.chain().focus().setTextSelection(inner);
  const current = blockKind(block, editor.state);
  if (current === kind) return true;
  // Leave a list first, so "list → heading" gives a heading, not a heading inside the list.
  const inList = ITEM_TYPES.has(block.node.type.name);
  const lifted =
    inList && !kind.endsWith('List') ? chain.liftListItem(block.node.type.name) : chain;
  switch (kind) {
    case 'paragraph':
      return lifted.setParagraph().run();
    case 'heading1':
      return lifted.setHeading({ level: 1 }).run();
    case 'heading2':
      return lifted.setHeading({ level: 2 }).run();
    case 'heading3':
      return lifted.setHeading({ level: 3 }).run();
    case 'bulletList':
      return lifted.toggleBulletList().run();
    case 'orderedList':
      return lifted.toggleOrderedList().run();
    case 'taskList':
      return lifted.toggleTaskList().run();
    case 'blockquote':
      return lifted.setParagraph().toggleBlockquote().run();
    case 'codeBlock':
      return lifted.setCodeBlock().run();
  }
}

/** A toggle's kind: its heading level, or null for a plain one. */
export type ToggleLevel = 1 | 2 | 3 | null;

export const TOGGLE_LEVELS: ToggleLevel[] = [null, 1, 2, 3];

/**
 * A paragraph or heading can become a toggle when its text fits the toggle's one-line summary
 * (no images) and its place can hold a toggle (a list item's first block cannot).
 */
export function canTurnIntoToggle(block: BlockAt | null, state: EditorState): boolean {
  if (!block) return false;
  const { node } = block;
  const toggle = state.schema.nodes.toggle;
  if (!toggle) return false;
  if (node.type === toggle) return true;
  if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return false;
  let plain = true;
  node.forEach((child) => {
    if (!child.isText && child.type.name !== 'mention' && child.type.name !== 'hardBreak') {
      plain = false;
    }
  });
  if (!plain) return false;
  const $pos = state.doc.resolve(block.pos);
  return $pos.parent.canReplaceWith($pos.index(), $pos.index() + 1, toggle);
}

/** The block's toggle kind; undefined when it is not a toggle. */
export function toggleLevel(block: BlockAt | null): ToggleLevel | undefined {
  if (block?.node.type.name !== 'toggle') return undefined;
  const level = Number(block.node.attrs.level);
  return level === 1 || level === 2 || level === 3 ? level : null;
}

/**
 * Makes the block a toggle of that kind: a toggle only changes its kind; the text of a paragraph
 * or heading becomes the summary, without its formatting, and the caret goes into the new body.
 */
export function turnBlockIntoToggle(
  editor: Editor,
  block: BlockAt | null,
  level: ToggleLevel,
): boolean {
  const { state } = editor;
  if (!block || !canTurnIntoToggle(block, state)) return false;
  const toggle = state.schema.nodes.toggle!;
  const tr = state.tr;
  if (block.node.type === toggle) {
    tr.setNodeAttribute(block.pos, 'level', level);
  } else {
    const summary = block.node
      .textBetween(0, block.node.content.size, ' ', (leaf) =>
        leaf.type.name === 'hardBreak' ? ' ' : String(leaf.attrs.label ?? ''),
      )
      .trim();
    tr.replaceWith(
      block.pos,
      block.pos + block.node.nodeSize,
      toggle.create({ summary, level }, state.schema.nodes.paragraph!.create()),
    );
    tr.setSelection(Selection.near(tr.doc.resolve(block.pos + 1)));
  }
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus(undefined, { scrollIntoView: false });
  return true;
}

/** A selection covering text of more than a caret, so a change applies to all of it. */
export function hasBlockRange(state: EditorState): boolean {
  const { selection } = state;
  return !selection.empty && !(selection instanceof NodeSelection);
}

/** What the selected text blocks are, when they are all the same kind. */
export function selectionKind(state: EditorState): BlockKind | null {
  const { from, to } = state.selection;
  const kinds = new Set<BlockKind | null>();
  state.doc.nodesBetween(from, Math.max(to, from + 1), (node, pos) => {
    if (!node.isTextblock) return true;
    const around = blockAround(state, pos + 1);
    kinds.add(
      around && ITEM_TYPES.has(around.node.type.name)
        ? blockKind(around, state)
        : blockKind({ pos, node }, state),
    );
    return false;
  });
  return kinds.size === 1 ? [...kinds][0]! : null;
}

/**
 * Turns every text block in the selection into one kind, in one transaction: lists become one
 * list, a code block takes all the lines. Blocks leave their old list or quote first.
 */
export function turnSelectionInto(editor: Editor, kind: BlockKind): boolean {
  const chain = editor.chain().focus().clearNodes();
  switch (kind) {
    case 'paragraph':
      return chain.run();
    case 'heading1':
      return chain.setNode('heading', { level: 1 }).run();
    case 'heading2':
      return chain.setNode('heading', { level: 2 }).run();
    case 'heading3':
      return chain.setNode('heading', { level: 3 }).run();
    case 'bulletList':
      return chain.toggleBulletList().run();
    case 'orderedList':
      return chain.toggleOrderedList().run();
    case 'taskList':
      return chain.toggleTaskList().run();
    case 'blockquote':
      return chain.toggleBlockquote().run();
    case 'codeBlock':
      return chain
        .command(({ tr, state, dispatch }) => {
          const { $from, $to } = tr.selection;
          const from = $from.before($from.depth);
          const to = $to.after($to.depth);
          const lines: string[] = [];
          tr.doc.nodesBetween(from, to, (node) => {
            if (!node.isTextblock) return true;
            lines.push(node.textContent);
            return false;
          });
          const text = lines.join('\n');
          const code = state.schema.nodes.codeBlock!.create(
            null,
            text ? state.schema.text(text) : null,
          );
          if (dispatch) {
            tr.replaceWith(from, to, code);
            tr.setSelection(Selection.near(tr.doc.resolve(from + 1)));
          }
          return true;
        })
        .run();
  }
}

/** Adds an empty column at the end and puts the caret in it; false at the limit. */
export function addColumn(editor: Editor, block: BlockAt | null): boolean {
  const { state } = editor;
  if (block?.node.type.name !== 'columns' || block.node.childCount >= MAX_COLUMNS) return false;
  const { column, paragraph } = state.schema.nodes;
  const at = block.pos + block.node.nodeSize - 1;
  const tr = state.tr.insert(at, column!.create(null, paragraph!.create()));
  tr.setSelection(Selection.near(tr.doc.resolve(at + 1)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.commands.focus(undefined, { scrollIntoView: false });
  return true;
}

/**
 * Backspace in the only, empty block of a column removes the column; with one column left its
 * blocks return to the page. Nothing is lost, as the column being removed is empty.
 */
function removeEmptyColumn(editor: Editor): boolean {
  const { state } = editor;
  const { selection } = state;
  const { $from } = selection;
  if (!selection.empty || $from.parentOffset !== 0 || $from.parent.content.size > 0) return false;
  if ($from.depth < 2 || $from.node(-1).type.name !== 'column') return false;
  const column = $from.node(-1);
  if (column.childCount !== 1) return false;
  const columns = $from.node(-2);
  const columnPos = $from.before(-1);
  const columnsPos = $from.before(-2);
  const tr = state.tr;
  if (columns.childCount > 2) {
    tr.delete(columnPos, columnPos + column.nodeSize);
    tr.setSelection(Selection.near(tr.doc.resolve(Math.max(columnPos - 1, 0)), -1));
  } else {
    const other = columns.child($from.index(-2) === 0 ? 1 : 0);
    tr.replaceWith(columnsPos, columnsPos + columns.nodeSize, other.content);
    tr.setSelection(Selection.near(tr.doc.resolve(columnsPos + 1)));
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export const ColumnKeys = Extension.create({
  name: 'columnKeys',
  priority: 1000,
  addKeyboardShortcuts() {
    return { Backspace: () => removeEmptyColumn(this.editor) };
  },
});

/**
 * Alt+Shift+↑ / ↓ (and the older Alt+↑ / ↓) move the block under the caret (doc 05 "satırları
 * taşı").
 */
export const BlockKeys = Extension.create({
  name: 'blockKeys',
  addKeyboardShortcuts() {
    const up = () => moveBlock(this.editor, blockAtSelection(this.editor.state), -1);
    const down = () => moveBlock(this.editor, blockAtSelection(this.editor.state), 1);
    return {
      'Alt-Shift-ArrowUp': up,
      'Alt-Shift-ArrowDown': down,
      'Alt-ArrowUp': up,
      'Alt-ArrowDown': down,
    };
  },
});

/* ---------------------------------- copy, color ---------------------------------- */

/**
 * Selects the block and copies it like Ctrl+C would (ProseMirror puts HTML and text on the
 * clipboard), so pasting it back recreates the block. Runs inside the menu's click.
 */
export function copyBlock(editor: Editor, block: BlockAt | null): boolean {
  if (!block) return false;
  const { view } = editor;
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, block.pos)));
  view.focus();
  return typeof document.execCommand === 'function' && document.execCommand('copy');
}

/** Node types the color mark does not reach (no marked text inside). */
const NO_COLOR = new Set([
  'codeBlock',
  'mermaid',
  'horizontalRule',
  'htmlBlock',
  'embed',
  'truncate',
  'toc',
  'unknownBlock',
]);

/** Whether the block has text the color mark can go on. */
export function canColor(block: BlockAt, state: EditorState): boolean {
  const type = state.schema.marks.color;
  if (!type || NO_COLOR.has(block.node.type.name)) return false;
  let ok = false;
  block.node.descendants((n, _pos, parent) => {
    if (ok) return false;
    if (n.isText && parent?.type.allowsMarkType(type)) ok = true;
    return !ok;
  });
  if (!ok && block.node.isTextblock) ok = block.node.type.allowsMarkType(type);
  return ok;
}

/** The color every text of the block has, or null (none, or mixed). */
export function blockColor(block: BlockAt): BlockColor | null {
  let found: string | null | undefined;
  block.node.descendants((n) => {
    if (!n.isText) return true;
    const c = n.marks.find((m) => m.type.name === 'color')?.attrs.color as string | undefined;
    found = found === undefined || found === (c ?? null) ? (c ?? null) : null;
    return false;
  });
  return isBlockColor(found) ? found : null;
}

/** Colors the whole block's text (null removes it); one transaction. */
export function colorBlock(editor: Editor, block: BlockAt | null, color: BlockColor | null) {
  const type = editor.state.schema.marks.color;
  if (!block || !type) return false;
  const from = block.pos + 1;
  const to = block.pos + block.node.nodeSize - 1;
  const tr = editor.state.tr.removeMark(from, to, type);
  if (color) tr.addMark(from, to, type.create({ color }));
  editor.view.dispatch(tr);
  return true;
}

/* ------------------------------ move to a drop point ------------------------------ */

/** The block around `pos`: the nearest list item, else the top-level block. */
export function blockAround(state: EditorState, pos: number): BlockAt | null {
  if (pos < 0 || pos > state.doc.content.size) return null;
  const $pos = state.doc.resolve(pos);
  for (let d = $pos.depth; d > 0; d--) {
    if (ITEM_TYPES.has($pos.node(d).type.name)) return { pos: $pos.before(d), node: $pos.node(d) };
  }
  if ($pos.depth < 1) {
    const node = state.doc.nodeAt(pos);
    return node && !node.isInline ? { pos, node } : null;
  }
  return { pos: $pos.before(1), node: $pos.node(1) };
}

/**
 * Moves a block to the boundary `at` (a position between blocks, e.g. before or after another
 * block) in one transaction, so it syncs over Yjs and undoes in one step. A list item follows
 * the list-item drop rules (H17); other blocks land at the nearest valid place.
 */
export function moveBlockTo(view: EditorView, block: BlockAt, at: number): boolean {
  const end = block.pos + block.node.nodeSize;
  if (at >= block.pos && at <= end) return false;
  const dragged = NodeSelection.create(view.state.doc, block.pos);
  const slice = new Slice(Fragment.from(block.node), 0, 0);
  if (dropListItem(view, slice, at, true, dragged)) return true;
  const tr = view.state.tr.delete(block.pos, end);
  const mapped = tr.mapping.map(at);
  const insertAt = dropPoint(tr.doc, mapped, slice) ?? mapped;
  tr.insert(insertAt, block.node);
  tr.setSelection(NodeSelection.create(tr.doc, insertAt));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/* ------------------------------ list item drops ------------------------------ */

/** The item type each list holds. */
const ITEM_OF: Record<string, 'listItem' | 'taskItem'> = {
  bulletList: 'listItem',
  orderedList: 'listItem',
  taskList: 'taskItem',
};

/** The dragged list item, when the drag is exactly one item (the grip of a list item). */
function draggedItem(slice: Slice): PMNode | null {
  if (slice.content.childCount !== 1) return null;
  const node = slice.content.firstChild!;
  return ITEM_TYPES.has(node.type.name) ? node : null;
}

/** The nearest list around `pos`, or null outside lists. */
function listAround(doc: PMNode, pos: number): PMNode | null {
  const $pos = doc.resolve(pos);
  for (let d = $pos.depth; d >= 0; d--) {
    if (ITEM_OF[$pos.node(d).type.name]) return $pos.node(d);
  }
  return null;
}

/**
 * Drops one dragged list item (H17): into a list it becomes that list's item type (a to-do item
 * in a bullet list becomes a plain item and back), outside lists its content (a paragraph, and
 * a nested list if it had one) is placed as blocks. Returns false for any other drag.
 */
export function dropListItem(
  view: EditorView,
  slice: Slice,
  at: number,
  moved: boolean,
  dragged: NodeSelection | undefined,
): boolean {
  const item = draggedItem(slice);
  if (!item) return false;
  const { state } = view;
  const tr = state.tr;
  if (moved) {
    if (dragged) dragged.replace(tr);
    else tr.deleteSelection();
  }
  const pos = tr.mapping.map(at);
  const list = listAround(tr.doc, Math.min(pos, tr.doc.content.size));
  let content: Fragment;
  if (list) {
    const kind = ITEM_OF[list.type.name]!;
    const node =
      item.type.name === kind
        ? item
        : state.schema.nodes[kind]!.create(
            kind === 'taskItem' ? { checked: false } : null,
            item.content,
          );
    content = Fragment.from(node);
  } else {
    content = item.content;
  }
  const insertAt = dropPoint(tr.doc, pos, new Slice(content, 0, 0)) ?? pos;
  tr.insert(insertAt, content);
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(insertAt + 1, tr.doc.content.size)), 1));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Drops of single list items from their grip (see dropListItem). */
export const ListItemDrop = Extension.create({
  name: 'listItemDrop',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('listItemDrop'),
        props: {
          handleDrop: (view, event, slice, moved) => {
            const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
            if (!coords) return false;
            // view.dragging also carries the dragged NodeSelection (not in its type).
            const dragging = view.dragging as { node?: NodeSelection } | null;
            return dropListItem(view, slice, coords.pos, moved, dragging?.node);
          },
        },
      }),
    ];
  },
});
