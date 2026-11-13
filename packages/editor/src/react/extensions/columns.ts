import { Extension, type Editor, type NodeViewRenderer } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { columnWidths, MIN_COLUMN_WIDTH } from '../../model';
import { columnWidthAttrs } from './nodes';

/** Arrow keys on a column's resize handle move it by this many percent. */
const KEY_STEP = 5;

/** The share of each column in a set, in percent: the stored widths, or equal ones. */
export function currentWidths(columns: PMNode): number[] {
  const stored = columnWidths(
    Array.from({ length: columns.childCount }, (_, i) => columns.child(i).attrs.width),
  );
  return stored.every((w) => w !== null)
    ? (stored as number[])
    : stored.map(() => 100 / columns.childCount);
}

/**
 * Moves the border after column `index` by `delta` percent of the set, keeping both neighbours at
 * least `MIN_COLUMN_WIDTH` wide; the other columns keep their share.
 */
export function moveColumnBorder(
  widths: readonly number[],
  index: number,
  delta: number,
): number[] {
  const next = [...widths];
  const left = widths[index];
  const right = widths[index + 1];
  if (left === undefined || right === undefined) return next;
  const pair = left + right;
  const moved = Math.min(Math.max(left + delta, MIN_COLUMN_WIDTH), pair - MIN_COLUMN_WIDTH);
  next[index] = moved;
  next[index + 1] = pair - moved;
  return next;
}

/** Stores `widths` (null = equal columns) on the set holding the column at `columnPos`. */
export function setColumnWidths(
  editor: Editor,
  columnPos: number,
  widths: readonly number[] | null,
): boolean {
  const $pos = editor.state.doc.resolve(columnPos);
  const columns = $pos.parent;
  if (columns.type.name !== 'columns') return false;
  const stored = widths ? columnWidths(widths) : columns.content.content.map(() => null);
  const tr = editor.state.tr;
  columns.forEach((child, offset, i) => {
    if (child.attrs.width !== stored[i]) {
      tr.setNodeAttribute($pos.start() + offset, 'width', stored[i]);
    }
  });
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}

function applyWidth(dom: HTMLElement, value: unknown) {
  const attrs = columnWidthAttrs(value);
  if (attrs['data-width']) dom.setAttribute('data-width', attrs['data-width']);
  else dom.removeAttribute('data-width');
  if (attrs.style) dom.setAttribute('style', attrs.style);
  else dom.removeAttribute('style');
}

/**
 * A column with a handle on its right edge (hidden on the last one and outside editing, see
 * editor.css): drag it, or focus it and press ← / →, to share the width between the column and
 * the next one; a double click makes the set equal again. The drag only restyles the columns;
 * the widths are stored once, when it ends, so collaborators and undo see a single change.
 */
export function columnView(resizeLabel: () => string): NodeViewRenderer {
  return ({ node, editor, getPos }) => {
    const dom = document.createElement('div');
    dom.setAttribute('data-type', 'column');
    const content = document.createElement('div');
    content.className = 'ch-column-content';
    const handle = document.createElement('div');
    handle.className = 'ch-column-resize';
    handle.contentEditable = 'false';
    handle.tabIndex = 0;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-valuemin', String(MIN_COLUMN_WIDTH));
    handle.setAttribute('aria-valuemax', String(100 - MIN_COLUMN_WIDTH));
    dom.append(content, handle);

    const place = () => {
      const pos = getPos();
      if (typeof pos !== 'number') return null;
      const $pos = editor.state.doc.resolve(pos);
      const columns = $pos.parent;
      if (columns.type.name !== 'columns') return null;
      const index = $pos.index();
      return index < columns.childCount - 1 ? { pos, columns, index } : null;
    };

    const show = (n: PMNode) => {
      applyWidth(dom, n.attrs.width);
      handle.setAttribute('aria-label', resizeLabel());
      const at = place();
      if (at) {
        handle.setAttribute(
          'aria-valuenow',
          String(Math.round(currentWidths(at.columns)[at.index]!)),
        );
      }
    };
    show(node);

    let drag: {
      id: number;
      x: number;
      pos: number;
      index: number;
      start: number[];
      widths: number[];
      span: number;
      cells: HTMLElement[];
      styles: (string | null)[];
    } | null = null;

    const end = (commit: boolean) => {
      if (!drag) return;
      const { pos, widths, start, cells, styles } = drag;
      drag = null;
      handle.classList.remove('is-dragging');
      const changed = widths.some((w, i) => Math.round(w) !== Math.round(start[i]!));
      if (!(commit && changed && setColumnWidths(editor, pos, widths))) {
        cells.forEach((cell, i) => {
          const style = styles[i];
          if (style === null || style === undefined) cell.removeAttribute('style');
          else cell.setAttribute('style', style);
        });
      }
    };

    handle.addEventListener('pointerdown', (event) => {
      const at = place();
      if (!editor.isEditable || !at || event.button !== 0) return;
      event.preventDefault();
      const parent = dom.parentElement;
      if (!parent) return;
      const cells = Array.from(parent.children).filter(
        (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.type === 'column',
      );
      const gap = parseFloat(getComputedStyle(parent).columnGap) || 0;
      const span = parent.getBoundingClientRect().width - gap * (cells.length - 1);
      if (span <= 0) return;
      const start = currentWidths(at.columns);
      drag = {
        id: event.pointerId,
        x: event.clientX,
        pos: at.pos,
        index: at.index,
        start,
        widths: start,
        span,
        cells,
        styles: cells.map((cell) => cell.getAttribute('style')),
      };
      handle.setPointerCapture?.(event.pointerId);
      handle.classList.add('is-dragging');
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const delta = ((event.clientX - drag.x) / drag.span) * 100;
      drag.widths = moveColumnBorder(drag.start, drag.index, delta);
      drag.cells.forEach((cell, i) => cell.style.setProperty('--ch-col', String(drag!.widths[i])));
    });
    handle.addEventListener('pointerup', () => end(true));
    handle.addEventListener('pointercancel', () => end(false));
    handle.addEventListener('lostpointercapture', () => end(true));
    handle.addEventListener('dblclick', (event) => {
      const at = place();
      if (!editor.isEditable || !at) return;
      event.preventDefault();
      setColumnWidths(editor, at.pos, null);
    });
    handle.addEventListener('keydown', (event) => {
      const at = place();
      if (!editor.isEditable || !at) return;
      const step =
        event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : 0;
      if (!step) return;
      event.preventDefault();
      setColumnWidths(editor, at.pos, moveColumnBorder(currentWidths(at.columns), at.index, step));
    });

    return {
      dom,
      contentDOM: content,
      update(next) {
        if (next.type !== node.type) return false;
        // A drag in progress keeps its preview until it ends.
        if (!drag) show(next);
        return true;
      },
      stopEvent: (event) => event.target instanceof Node && handle.contains(event.target),
      // The column's own attributes (restyled while dragging) and the handle are not content.
      ignoreMutation: (mutation) =>
        (mutation.type === 'attributes' && mutation.target === dom) ||
        (mutation.type !== 'selection' && handle.contains(mutation.target)),
      destroy: () => end(false),
    };
  };
}

/** Each set of columns keeps widths for all of its columns or for none (`columnWidths`). */
function normalizeColumns(tr: Transaction): Transaction | null {
  let changed = false;
  tr.doc.descendants((node, pos) => {
    if (node.type.name === 'columns') {
      const stored = columnWidths(node.content.content.map((c) => c.attrs.width));
      node.forEach((child, offset, i) => {
        if (child.attrs.width !== stored[i]) {
          tr.setNodeAttribute(pos + 1 + offset, 'width', stored[i]);
          changed = true;
        }
      });
    }
    return !node.isTextblock && !node.isAtom;
  });
  return changed ? tr : null;
}

export const ColumnWidths = Extension.create({
  name: 'columnWidths',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('columnWidths'),
        appendTransaction: (trs, _old, state) =>
          trs.some((tr) => tr.docChanged) ? normalizeColumns(state.tr) : null,
      }),
    ];
  },
});
