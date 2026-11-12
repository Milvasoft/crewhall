import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { docToMarkdown, markdownToDoc, plainText, type EditorDoc } from '../src';
import { RichEditor, validateDoc, type RichEditorHandle } from '../src/react';
import { fakeLabels } from './helpers/labels';

/** The "/içindekiler" block. */

function mount(md: string, editable = true) {
  const ref = createRef<RichEditorHandle>();
  render(
    <RichEditor
      value={markdownToDoc(md).doc}
      labels={fakeLabels}
      editorRef={ref}
      editable={editable}
    />,
  );
  return ref.current!.getEditor();
}

const contents = () => screen.getByRole('navigation', { name: 'L:tocTitle' });

describe('table of contents block', () => {
  it('survives markdown and stays out of the text', () => {
    const md = '<!-- toc -->\n\n# Bir\n';
    const { doc } = markdownToDoc(md);
    expect(doc.content?.[0]).toEqual({ type: 'toc' });
    expect(docToMarkdown(doc as EditorDoc).trimEnd()).toBe(md.trimEnd());
    expect(plainText(doc)).toBe('Bir');
    expect(validateDoc(doc).ok).toBe(true);
  });

  it('lists the headings, indented, and follows the document', () => {
    const editor = mount('<!-- toc -->\n\n## Bir\n\n### İki');
    expect(
      within(contents())
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Bir', 'İki']);
    expect(within(contents()).getByRole('button', { name: 'İki' })).toHaveStyle({
      paddingLeft: '16px',
    });
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size, {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Üç' }],
      });
    });
    expect(within(contents()).getByRole('button', { name: 'Üç' })).toBeInTheDocument();
  });

  it('says what it is for on a page without headings', () => {
    mount('<!-- toc -->\n\nMetin');
    expect(within(contents()).getByText('L:tocEmpty')).toBeInTheDocument();
  });

  it('jumps to a heading on a read-only page too, and leaves the document alone', async () => {
    const editor = mount('<!-- toc -->\n\n# Bir\n\nMetin\n\n## İki', false);
    const before = JSON.stringify(editor.getJSON());
    const target = editor.view.dom.querySelector('h2') as HTMLElement;
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    await userEvent.click(within(contents()).getByRole('button', { name: 'İki' }));
    expect(scroll).toHaveBeenCalledOnce();
    expect(JSON.stringify(editor.getJSON())).toBe(before);
  });
});
