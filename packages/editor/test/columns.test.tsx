import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { columnWidths, docToMarkdown, markdownToDoc, plainText, type EditorDoc } from '../src';
import { blockAtPos, outlineOf, RichEditor, type RichEditorHandle } from '../src/react';
import { moveColumnBorder } from '../src/react/extensions/columns';
import { BlockMenu } from '../src/react/ui/BlockMenu';
import { fakeLabels } from './helpers/labels';

const SOURCE = '::::columns\n:::column\n## Sol\n\nBir\n:::\n\n:::column\nİki\n:::\n::::';

function mount(text: string) {
  const ref = createRef<RichEditorHandle>();
  render(<RichEditor value={markdownToDoc(text).doc} labels={fakeLabels} editorRef={ref} />);
  return ref.current!.getEditor();
}

const backspace = (e: ReturnType<typeof mount>) =>
  act(() => {
    e.view.someProp('handleKeyDown', (f) =>
      f(e.view, new KeyboardEvent('keydown', { key: 'Backspace' })),
    );
  });

const types = (doc: EditorDoc) => doc.content?.map((n) => n.type);

describe('columns in Markdown', () => {
  it('reads and writes the same text', () => {
    const { doc, warnings } = markdownToDoc(SOURCE);
    expect(warnings).toEqual([]);
    expect(doc.content?.[0]).toMatchObject({
      type: 'columns',
      content: [{ type: 'column' }, { type: 'column' }],
    });
    expect(docToMarkdown(doc).trimEnd()).toBe(SOURCE);
  });

  it('keeps the blocks of anything that is not a valid set of columns', () => {
    const one = markdownToDoc('::::columns\n:::column\nTek\n:::\n::::').doc;
    expect(types(one)).toEqual(['paragraph']);
    const stray = markdownToDoc(':::column\nYalnız\n:::').doc;
    expect(types(stray)).toEqual(['paragraph']);
    const five = Array.from({ length: 5 }, (_, i) => `:::column\nS${i}\n:::`).join('\n\n');
    const many = markdownToDoc(`::::columns\n${five}\n::::`).doc;
    expect(many.content?.[0]?.content).toHaveLength(4);
    expect(plainText(many)).toContain('S4');
  });

  it('separates the text of columns for search', () => {
    expect(plainText(markdownToDoc(SOURCE).doc)).toBe('Sol\nBir\nİki');
  });
});

describe('columns in the editor', () => {
  it('holds the document unchanged, and its headings count for the outline', () => {
    const e = mount(SOURCE);
    expect(docToMarkdown(e.getJSON() as EditorDoc).trimEnd()).toBe(SOURCE);
    expect(outlineOf(e.state.doc).map((x) => x.text)).toEqual(['Sol']);
  });

  it('removes an empty column on Backspace and keeps the others', () => {
    const e = mount(
      '::::columns\n:::column\nBir\n:::\n\n:::column\n\n:::\n\n:::column\nÜç\n:::\n::::',
    );
    const second = e.state.doc.child(0).child(0).nodeSize + 3;
    act(() => {
      e.commands.setTextSelection(second);
    });
    expect(e.state.selection.$from.parent.content.size).toBe(0);
    backspace(e);
    expect(e.state.doc.child(0).childCount).toBe(2);
    expect(plainText(e.getJSON() as EditorDoc)).toBe('Bir\nÜç');
  });

  it('returns the last column to the page when only one would be left', () => {
    const e = mount('Önce\n\n::::columns\n:::column\nBir\n\nİki\n:::\n\n:::column\n\n:::\n::::');
    const columnsPos = e.state.doc.child(0).nodeSize;
    const empty = columnsPos + 1 + e.state.doc.child(1).child(0).nodeSize + 2;
    act(() => {
      e.commands.setTextSelection(empty);
    });
    backspace(e);
    expect(types(e.getJSON() as EditorDoc)).not.toContain('columns');
    expect(plainText(e.getJSON() as EditorDoc)).toBe('Önce\nBir\nİki');
  });

  it('does not touch a column with text', () => {
    const e = mount(SOURCE);
    act(() => {
      e.commands.setTextSelection(e.state.doc.content.size - 4);
    });
    const before = JSON.stringify(e.getJSON());
    backspace(e);
    expect(JSON.stringify(e.getJSON()).length).toBeLessThanOrEqual(before.length);
    expect(e.state.doc.child(0).childCount).toBe(2);
  });

  it('adds a column from the block menu, up to the limit', () => {
    const e = mount(SOURCE);
    const open = () =>
      render(
        <BlockMenu
          editor={e}
          block={blockAtPos(e.state, 0)!}
          anchor={new DOMRect(0, 0, 10, 10)}
          labels={fakeLabels}
          onClose={() => undefined}
        />,
      );
    const menu = open();
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'L:blockAddColumn' }));
    });
    expect(e.state.doc.child(0).childCount).toBe(3);
    menu.unmount();
    act(() => {
      e.commands.insertContentAt(e.state.doc.child(0).nodeSize - 1, {
        type: 'column',
        content: [{ type: 'paragraph' }],
      });
    });
    expect(e.state.doc.child(0).childCount).toBe(4);
    open();
    expect(screen.getByRole('menuitem', { name: 'L:blockAddColumn' })).toBeDisabled();
  });
});

const WIDE =
  '::::columns\n:::column{width="30"}\nSol\n:::\n\n:::column{width="70"}\nSağ\n:::\n::::';

const widths = (e: ReturnType<typeof mount>) => {
  const set = e.state.doc.child(0);
  return Array.from({ length: set.childCount }, (_, i) => set.child(i).attrs.width as unknown);
};

describe('column widths', () => {
  it('reads and writes the widths of a resized set', () => {
    const { doc } = markdownToDoc(WIDE);
    expect(doc.content?.[0]?.content?.map((c) => c.attrs?.width)).toEqual([30, 70]);
    expect(docToMarkdown(doc).trimEnd()).toBe(WIDE);
  });

  it('scales widths to 100 and drops them unless every column has a valid one', () => {
    expect(columnWidths([1, 3])).toEqual([null, null]);
    expect(columnWidths(['20', '60'])).toEqual([25, 75]);
    expect(columnWidths([40, null])).toEqual([null, null]);
    expect(columnWidths([95, 5])).toEqual([null, null]);
    const half = markdownToDoc(
      '::::columns\n:::column{width="30"}\nA\n:::\n\n:::column\nB\n:::\n::::',
    ).doc;
    expect(half.content?.[0]?.content?.map((c) => c.attrs?.width ?? null)).toEqual([null, null]);
  });

  it('moves a border, keeping both neighbours at least the minimum wide', () => {
    expect(moveColumnBorder([50, 50], 0, 15)).toEqual([65, 35]);
    expect(moveColumnBorder([30, 30, 40], 1, 50)).toEqual([30, 60, 10]);
    expect(moveColumnBorder([30, 70], 0, -40)).toEqual([10, 90]);
  });

  it('keeps the widths in the editor and shows each share', () => {
    const e = mount(WIDE);
    expect(docToMarkdown(e.getJSON() as EditorDoc).trimEnd()).toBe(WIDE);
    const cells = document.querySelectorAll<HTMLElement>('[data-type="column"]');
    expect(cells[0]?.style.getPropertyValue('--ch-col')).toBe('30');
    expect(cells[1]).toHaveAttribute('data-width', '70');
  });

  it('resizes with the arrow keys on the handle and resets on a double click', () => {
    const e = mount(SOURCE);
    const handle = screen.getAllByRole('separator', { name: 'L:columnResize' })[0]!;
    act(() => {
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
    });
    expect(widths(e)).toEqual([55, 45]);
    act(() => {
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
      fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    });
    expect(widths(e)).toEqual([45, 55]);
    expect(docToMarkdown(e.getJSON() as EditorDoc)).toContain(':::column{width="45"}');
    act(() => {
      fireEvent.doubleClick(handle);
    });
    expect(widths(e)).toEqual([null, null]);
  });

  it('stores a drag once, when it ends', () => {
    const e = mount(SOURCE);
    const set = document.querySelector<HTMLElement>('[data-type="columns"]')!;
    // jsdom lays nothing out: the set is 400 px wide, without a gap.
    set.getBoundingClientRect = () => new DOMRect(0, 0, 400, 100);
    const handle = screen.getAllByRole('separator', { name: 'L:columnResize' })[0]!;
    let updates = 0;
    e.on('update', () => (updates += 1));
    act(() => {
      fireEvent.pointerDown(handle, { button: 0, clientX: 200, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 260, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientX: 280, pointerId: 1 });
    });
    expect(updates).toBe(0);
    const cells = document.querySelectorAll<HTMLElement>('[data-type="column"]');
    expect(cells[0]?.style.getPropertyValue('--ch-col')).toBe('70');
    act(() => {
      fireEvent.pointerUp(handle, { clientX: 280, pointerId: 1 });
    });
    expect(updates).toBe(1);
    expect(widths(e)).toEqual([70, 30]);
  });

  it('makes a set equal again when a column is added next to resized ones', () => {
    const e = mount(WIDE);
    act(() => {
      e.commands.insertContentAt(e.state.doc.child(0).nodeSize - 1, {
        type: 'column',
        content: [{ type: 'paragraph' }],
      });
    });
    expect(widths(e)).toEqual([null, null, null]);
  });

  it('has no handle to drag while the page is read', () => {
    const ref = createRef<RichEditorHandle>();
    render(
      <RichEditor
        value={markdownToDoc(WIDE).doc}
        labels={fakeLabels}
        editorRef={ref}
        editable={false}
      />,
    );
    expect(ref.current!.getEditor().isEditable).toBe(false);
    expect(document.querySelector('[contenteditable="true"] .ch-column-resize')).toBeNull();
  });
});
