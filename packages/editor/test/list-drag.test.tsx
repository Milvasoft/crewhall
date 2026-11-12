import { act, render } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { docToMarkdown, markdownToDoc, type EditorDoc } from '../src';
import { blockAtSelection, dropListItem, RichEditor, type RichEditorHandle } from '../src/react';
import { fakeLabels } from './helpers/labels';

/** H17: each list item is dragged on its own (same list, other list, out of the list, nested). */

const doc = (md: string): EditorDoc => markdownToDoc(md).doc;

function mount(md: string, props: Partial<Parameters<typeof RichEditor>[0]> = {}) {
  const ref = createRef<RichEditorHandle>();
  render(<RichEditor value={doc(md)} labels={fakeLabels} editorRef={ref} {...props} />);
  return () => ref.current!.getEditor();
}

const md = (e: Editor) => docToMarkdown(e.getJSON() as EditorDoc).trim();

/** Start of the text block holding `text`. */
function textPos(e: Editor, text: string): number {
  let found = -1;
  e.state.doc.descendants((node: PMNode, pos: number) => {
    if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1;
    return found < 0;
  });
  if (found < 0) throw new Error(`no block "${text}"`);
  return found;
}

/** What the grip does on dragstart + drop: select the item, then drop its slice at `at`. */
function dragItem(e: Editor, text: string, at: number) {
  const inside = textPos(e, text);
  const $pos = e.state.doc.resolve(inside);
  const itemPos = $pos.before($pos.depth - 1);
  const item = e.state.doc.nodeAt(itemPos)!;
  const sel = NodeSelection.create(e.state.doc, itemPos);
  act(() => {
    e.view.dispatch(e.state.tr.setSelection(sel));
    const slice = e.state.doc.slice(itemPos, itemPos + item.nodeSize);
    expect(dropListItem(e.view, slice, at, true, sel)).toBe(true);
  });
}

describe('dragging single list items', () => {
  it('reorders items inside their list', () => {
    const e = mount('- elma\n- armut\n- ayva')();
    dragItem(e, 'ayva', textPos(e, 'elma'));
    expect(md(e)).toBe('- ayva\n- elma\n- armut');
  });

  it('turns a plain item into a to-do item when dropped in a to-do list, and back', () => {
    const e = mount('- elma\n- armut\n\nAra\n\n- [ ] süt\n- [x] ekmek')();
    dragItem(e, 'armut', textPos(e, 'ekmek'));
    expect(md(e)).toContain('- [ ] armut');
    expect(md(e).startsWith('- elma\n\nAra')).toBe(true);
    dragItem(e, 'süt', textPos(e, 'elma'));
    expect(md(e).split('\n')[0]).toBe('- süt');
  });

  it('becomes a paragraph outside lists', () => {
    const e = mount('Üst\n\n- elma\n- armut\n\nAlt')();
    dragItem(e, 'armut', textPos(e, 'Üst'));
    expect(e.state.doc.content.content.map((n) => n.type.name)).toEqual([
      'paragraph',
      'paragraph',
      'bulletList',
      'paragraph',
    ]);
    expect(md(e)).toContain('armut\n\nÜst');
    expect(md(e)).toContain('- elma\n\nAlt');
  });

  it('goes into a nested list at that level', () => {
    const e = mount('- meyve\n  - elma\n  - armut\n- sebze')();
    dragItem(e, 'sebze', textPos(e, 'armut'));
    expect(md(e)).toBe('- meyve\n  - elma\n  - sebze\n  - armut');
  });

  it('Alt+↑ / Alt+↓ move the item under the caret', () => {
    const e = mount('- bir\n- iki\n- üç')();
    act(() => {
      e.commands.setTextSelection(textPos(e, 'üç'));
    });
    expect(blockAtSelection(e.state)?.node.type.name).toBe('listItem');
  });

  it('syncs a drop over Yjs', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u));
    b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u));
    const first = mount('', { collaboration: { doc: a } });
    const second = mount('', { collaboration: { doc: b } });
    act(() => {
      first().commands.setContent(doc('- [ ] bir\n- [ ] iki\n- [x] üç'));
    });
    dragItem(first(), 'üç', textPos(first(), 'bir'));
    expect(md(second())).toBe('- [x] üç\n- [ ] bir\n- [ ] iki');
  });
});
