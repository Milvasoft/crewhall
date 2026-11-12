import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { useCallback, useSyncExternalStore } from 'react';

/** One heading of the open document, by its live position. */
export interface OutlineItem {
  pos: number;
  level: number;
  text: string;
}

/**
 * Their headings may be out of sight (a closed toggle, another tab), so an outline skips them.
 * A toggle that is itself a heading is in sight, closed or not.
 */
const HIDDEN_CONTAINERS = new Set(['tabs', 'toggle']);

const EMPTY: OutlineItem[] = [];

/** The document's headings in order; headings without text are left out. */
export function outlineOf(doc: PMNode): OutlineItem[] {
  const items: OutlineItem[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'toggle' && node.attrs.level && node.attrs.summary.trim()) {
      items.push({ pos, level: Number(node.attrs.level), text: node.attrs.summary.trim() });
      return false;
    }
    if (HIDDEN_CONTAINERS.has(node.type.name)) return false;
    if (node.type.name !== 'heading') return true;
    const text = node
      .textBetween(0, node.content.size, '', (leaf) =>
        typeof leaf.attrs.label === 'string' ? leaf.attrs.label : '',
      )
      .trim();
    if (text) items.push({ pos, level: Number(node.attrs.level ?? 1), text });
    return false;
  });
  return items;
}

const same = (a: OutlineItem[], b: OutlineItem[]) =>
  a.length === b.length &&
  a.every((x, i) => x.pos === b[i]!.pos && x.level === b[i]!.level && x.text === b[i]!.text);

const cache = new WeakMap<Editor, { doc: PMNode; items: OutlineItem[] }>();

function snapshot(editor: Editor | null): OutlineItem[] {
  if (!editor || editor.isDestroyed) return EMPTY;
  const doc = editor.state.doc;
  const known = cache.get(editor);
  if (known?.doc === doc) return known.items;
  const next = outlineOf(doc);
  const items = known && same(known.items, next) ? known.items : next;
  cache.set(editor, { doc, items });
  return items;
}

/** The headings of a live editor, including what other people type into it. */
export function useOutline(editor: Editor | null): OutlineItem[] {
  const subscribe = useCallback(
    (changed: () => void) => {
      if (!editor) return () => undefined;
      editor.on('update', changed);
      return () => {
        editor.off('update', changed);
      };
    },
    [editor],
  );
  return useSyncExternalStore(subscribe, () => snapshot(editor));
}

/** The rendered element of the heading at `pos`, if it is on screen. */
export function headingElement(editor: Editor, pos: number): HTMLElement | null {
  if (editor.isDestroyed) return null;
  const dom = editor.view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom : null;
}

/** Brings a heading to the top of the page. The caret stays where it was. */
export function scrollToHeading(editor: Editor, pos: number): boolean {
  const el = headingElement(editor, pos);
  if (!el) return false;
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  return true;
}

/** How far an outline indents an item: its depth below the document's highest heading. */
export function outlineDepth(items: OutlineItem[], item: OutlineItem): number {
  const top = items.reduce((min, x) => Math.min(min, x.level), item.level);
  return item.level - top;
}
