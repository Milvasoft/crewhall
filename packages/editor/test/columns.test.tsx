import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { docToMarkdown, markdownToDoc, plainText, type EditorDoc } from '../src';
import { blockAtPos, outlineOf, RichEditor, type RichEditorHandle } from '../src/react';
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
