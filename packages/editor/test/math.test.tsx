import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { docToMarkdown, markdownToDoc, plainText, type EditorDoc } from '../src';
import { RichEditor, type RichEditorHandle } from '../src/react';
import { fakeLabels } from './helpers/labels';

function mount(text: string, editable = true) {
  const ref = createRef<RichEditorHandle>();
  const utils = render(
    <RichEditor
      value={markdownToDoc(text).doc}
      labels={fakeLabels}
      editorRef={ref}
      editable={editable}
    />,
  );
  return { ...utils, editor: ref.current!.getEditor() };
}

const first = (text: string) => markdownToDoc(text).doc.content?.[0];

describe('formulas in Markdown', () => {
  it('reads a block and an inline formula and writes them back', () => {
    const source = '$$\nE = mc^2\n$$\n\nEnerji $$x^2$$ olur.';
    const { doc } = markdownToDoc(source);
    expect(doc.content?.[0]).toEqual({ type: 'mathBlock', attrs: { latex: 'E = mc^2' } });
    expect(doc.content?.[1]?.content?.[1]).toEqual({ type: 'mathInline', attrs: { latex: 'x^2' } });
    expect(docToMarkdown(doc).trimEnd()).toBe(source);
    expect(plainText(doc)).toContain('E = mc^2');
  });

  it('reads a formula alone on its line as a block', () => {
    expect(first('$$a+b$$')).toEqual({ type: 'mathBlock', attrs: { latex: 'a+b' } });
  });

  it('leaves prices as text', () => {
    const source = '$5 ve $10 arası';
    expect(first(source)).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: source }],
    });
    expect(docToMarkdown(markdownToDoc(source).doc).trimEnd()).toBe(source);
  });

  it('escapes two dollars in text, so they stay text', () => {
    const doc: EditorDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a $$b$$ c' }] }],
    };
    const md = docToMarkdown(doc);
    expect(markdownToDoc(md).doc.content?.[0]).toEqual(doc.content?.[0]);
  });
});

describe('formulas in the editor', () => {
  it('draws the formula with KaTeX', async () => {
    const { container } = mount('$$\nx^2\n$$');
    await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull());
    expect(container.querySelector('.ch-math--block')).not.toBeNull();
  });

  it('shows a mistake in place instead of breaking the page, and no active links', async () => {
    const { container } = mount(
      '$$\n\\badcommand{x}\n$$\n\n$$\n\\href{javascript:alert(1)}{y}\n$$\n\nSonra',
    );
    await waitFor(() => expect(container.querySelectorAll('.katex')).toHaveLength(2));
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container).toHaveTextContent('Sonra');
  });

  it('edits the formula from a click, and Enter closes the panel', async () => {
    const { container, editor } = mount('$$\nx\n$$');
    await waitFor(() => expect(container.querySelector('.ch-math-output')).not.toBeNull());
    fireEvent.click(container.querySelector('.ch-math-output')!);
    const input = screen.getByRole('textbox', { name: 'L:mathPlaceholder' });
    act(() => {
      fireEvent.change(input, { target: { value: 'y^2' } });
    });
    expect(editor.getJSON().content?.[0]?.attrs).toEqual({ latex: 'y^2' });
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(screen.queryByRole('textbox', { name: 'L:mathPlaceholder' })).toBeNull();
  });

  it('removes a formula left empty', async () => {
    const { container, editor } = mount('$$\nx\n$$\n\nSonra');
    await waitFor(() => expect(container.querySelector('.ch-math-output')).not.toBeNull());
    fireEvent.click(container.querySelector('.ch-math-output')!);
    const input = screen.getByRole('textbox', { name: 'L:mathPlaceholder' });
    act(() => {
      fireEvent.change(input, { target: { value: ' ' } });
    });
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });
    expect(editor.getJSON().content?.[0]?.type).toBe('paragraph');
  });

  it('has no panel when read-only', async () => {
    const { container } = mount('$$\nx\n$$', false);
    await waitFor(() => expect(container.querySelector('.ch-math-output')).not.toBeNull());
    fireEvent.click(container.querySelector('.ch-math-output')!);
    expect(screen.queryByRole('textbox', { name: 'L:mathPlaceholder' })).toBeNull();
  });

  it('turns $$x$$ typed in a line into a formula', async () => {
    const { editor } = mount('');
    const { view } = editor;
    for (const ch of '$$a+b$$') {
      act(() => {
        const { from, to } = view.state.selection;
        const deflt = () => view.state.tr.insertText(ch, from, to);
        const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, deflt));
        if (!handled) view.dispatch(deflt());
      });
    }
    await waitFor(() =>
      expect(editor.getJSON().content?.[0]?.content?.[0]).toEqual({
        type: 'mathInline',
        attrs: { latex: 'a+b' },
      }),
    );
  });
});
