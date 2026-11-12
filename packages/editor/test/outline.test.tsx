import { act, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { markdownToDoc } from '../src';
import {
  outlineDepth,
  outlineOf,
  RichEditor,
  scrollToHeading,
  useOutline,
  type RichEditorHandle,
} from '../src/react';
import type { Editor } from '@tiptap/core';
import { fakeLabels } from './helpers/labels';

function mount(md: string) {
  const ref = createRef<RichEditorHandle>();
  render(<RichEditor value={markdownToDoc(md).doc} labels={fakeLabels} editorRef={ref} />);
  return ref.current!.getEditor();
}

function Live({ editor }: { editor: Editor }) {
  const items = useOutline(editor);
  return <p data-testid="live">{items.map((x) => x.text).join('|')}</p>;
}

describe('page outline', () => {
  it('lists the headings in order with their level and position', () => {
    const editor = mount('# Bir\n\nMetin\n\n## İki\n\n### Üç');
    const items = outlineOf(editor.state.doc);
    expect(items.map((x) => [x.text, x.level])).toEqual([
      ['Bir', 1],
      ['İki', 2],
      ['Üç', 3],
    ]);
    for (const item of items) {
      expect(editor.state.doc.nodeAt(item.pos)?.type.name).toBe('heading');
    }
  });

  it('leaves out empty headings and those that a closed block may hide', () => {
    const editor = mount(
      '# Dışarıda\n\n:::toggle[Aç]\n## Açılırda\n:::\n\n:::note\n## Notta\n:::\n\n## ',
    );
    expect(outlineOf(editor.state.doc).map((x) => x.text)).toEqual(['Dışarıda', 'Notta']);
  });

  it('lists a toggle heading, closed or not, but not what is inside it', () => {
    const editor = mount(
      '# Bir\n\n:::toggle[Kurulum]{level=2}\n### İçeride\n:::\n\n:::toggle{level=2}\nBaşlıksız\n:::',
    );
    const items = outlineOf(editor.state.doc);
    expect(items.map((x) => [x.text, x.level])).toEqual([
      ['Bir', 1],
      ['Kurulum', 2],
    ]);
    expect(editor.state.doc.nodeAt(items[1]!.pos)?.type.name).toBe('toggle');
    expect(scrollToHeading(editor, items[1]!.pos)).toBe(true);
  });

  it('indents below the highest heading of the page, not below h1', () => {
    const editor = mount('## İki\n\n### Üç');
    const items = outlineOf(editor.state.doc);
    expect(items.map((x) => outlineDepth(items, x))).toEqual([0, 1]);
  });

  it('follows the document as it changes', () => {
    const editor = mount('# Bir');
    render(<Live editor={editor} />);
    expect(screen.getByTestId('live')).toHaveTextContent('Bir');
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size, {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'İki' }],
      });
    });
    expect(screen.getByTestId('live')).toHaveTextContent('Bir|İki');
  });

  it('scrolls to a heading without moving the caret', () => {
    const editor = mount('# Bir\n\nMetin\n\n## İki');
    const item = outlineOf(editor.state.doc)[1]!;
    const before = editor.state.selection.from;
    const scroll = vi.fn();
    const el = editor.view.nodeDOM(item.pos) as HTMLElement;
    el.scrollIntoView = scroll;
    expect(scrollToHeading(editor, item.pos)).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
    expect(editor.state.selection.from).toBe(before);
  });
});
