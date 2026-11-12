import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { docToMarkdown, markdownToDoc, type EditorDoc } from '../src';
import {
  blockAtPos,
  RichEditor,
  selectionKind,
  turnSelectionInto,
  type RichEditorHandle,
} from '../src/react';
import { BlockMenu } from '../src/react/ui/BlockMenu';
import { fakeLabels } from './helpers/labels';

/** "Türünü değiştir": one block or a whole selection, from the handle, the toolbar or "/". */

const doc = (md: string): EditorDoc => markdownToDoc(md).doc;

function mount(md: string, props: Partial<Parameters<typeof RichEditor>[0]> = {}) {
  const ref = createRef<RichEditorHandle>();
  const utils = render(
    <RichEditor value={doc(md)} labels={fakeLabels} editorRef={ref} {...props} />,
  );
  return { ...utils, editor: () => ref.current!.getEditor() };
}
type Ed = ReturnType<ReturnType<typeof mount>['editor']>;

const md = (e: Ed) => docToMarkdown(e.getJSON() as EditorDoc).trimEnd();

/** Selects from the first text to the last text of the document. */
const selectAllText = (e: Ed) =>
  act(() => {
    let first = -1;
    let last = -1;
    e.state.doc.descendants((n, pos) => {
      if (!n.isTextblock) return true;
      if (first < 0) first = pos + 1;
      if (n.textContent) last = pos + 1 + n.content.size;
      return false;
    });
    e.commands.setTextSelection({ from: first, to: last });
  });

/** A real selection in the first paragraph, which is what opens the toolbar. */
function selectInDom(e: Ed, from: number, to: number) {
  act(() => {
    e.commands.focus();
    e.commands.setTextSelection({ from, to });
    const p = e.view.dom.querySelector('p')!;
    const range = document.createRange();
    range.setStart(p.firstChild!, from - 1);
    range.setEnd(p.firstChild!, to - 1);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    e.view.dispatch(e.state.tr.setMeta('test', true));
  });
}

/** Types like a user: each character goes through ProseMirror's text input handlers. */
function typeText(e: Ed, text: string) {
  const { view } = e;
  for (const ch of text) {
    act(() => {
      const { from, to } = view.state.selection;
      const deflt = () => view.state.tr.insertText(ch, from, to);
      const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, deflt));
      if (!handled) view.dispatch(deflt());
    });
  }
}

describe('turnSelectionInto', () => {
  it('turns several paragraphs into headings', () => {
    const { editor } = mount('Bir\n\nİki');
    selectAllText(editor());
    act(() => {
      turnSelectionInto(editor(), 'heading2');
    });
    expect(md(editor())).toBe('## Bir\n\n## İki');
    expect(selectionKind(editor().state)).toBe('heading2');
  });

  it('turns several paragraphs into one list and a list back into paragraphs', () => {
    const { editor } = mount('Bir\n\nİki');
    selectAllText(editor());
    act(() => {
      turnSelectionInto(editor(), 'taskList');
    });
    expect(md(editor())).toBe('- [ ] Bir\n- [ ] İki');
    selectAllText(editor());
    expect(selectionKind(editor().state)).toBe('taskList');
    act(() => {
      turnSelectionInto(editor(), 'bulletList');
    });
    expect(md(editor())).toBe('- Bir\n- İki');
    selectAllText(editor());
    act(() => {
      turnSelectionInto(editor(), 'paragraph');
    });
    expect(md(editor())).toBe('Bir\n\nİki');
  });

  it('wraps a mixed selection in a quote and joins lines in one code block', () => {
    const { editor } = mount('# Başlık\n\n- madde');
    selectAllText(editor());
    expect(selectionKind(editor().state)).toBeNull();
    act(() => {
      turnSelectionInto(editor(), 'blockquote');
    });
    expect(md(editor())).toBe('> Başlık\n>\n> madde');
    selectAllText(editor());
    act(() => {
      turnSelectionInto(editor(), 'codeBlock');
    });
    expect(md(editor())).toBe('```\nBaşlık\nmadde\n```');
  });

  it('is one undo step, also over Yjs', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u));
    b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u));
    const first = mount('', { collaboration: { doc: a } });
    const second = mount('', { collaboration: { doc: b } });
    act(() => {
      second.editor().commands.setContent(doc('Bir\n\nİki'));
    });
    selectAllText(first.editor());
    act(() => {
      turnSelectionInto(first.editor(), 'orderedList');
    });
    expect(md(second.editor())).toBe('1. Bir\n2. İki');
    act(() => {
      first.editor().commands.undo();
    });
    expect(md(second.editor())).toBe('Bir\n\nİki');
  });
});

describe('where it is offered', () => {
  const menu = (e: Ed, props: Partial<Parameters<typeof BlockMenu>[0]> = {}) =>
    render(
      <BlockMenu
        editor={e}
        block={blockAtPos(e.state, 0)!}
        anchor={new DOMRect(0, 0, 20, 20)}
        labels={fakeLabels}
        onClose={() => undefined}
        {...props}
      />,
    );

  it('from the handle: a selection the block is in changes as a whole', () => {
    const { editor } = mount('Bir\n\nİki');
    selectAllText(editor());
    menu(editor());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'L:slashHeading1' }));
    expect(md(editor())).toBe('# Bir\n\n# İki');
  });

  it('from the handle: a block outside the selection changes alone', () => {
    const { editor } = mount('Bir\n\nİki\n\nÜç');
    act(() => {
      editor().commands.setTextSelection({ from: 7, to: 10 });
    });
    menu(editor());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'L:slashHeading1' }));
    expect(md(editor())).toBe('# Bir\n\nİki\n\nÜç');
  });

  it('shows only the kinds in "turn into" mode', () => {
    const { editor } = mount('Bir');
    menu(editor(), { turnIntoOnly: true });
    expect(screen.getByRole('menu', { name: 'L:blockTurnInto' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'L:blockDelete' })).toBeNull();
    expect(screen.getByRole('menuitemradio', { name: 'L:slashText' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('from the selection toolbar', async () => {
    const { editor } = mount('Bir iki');
    selectInDom(editor(), 1, 4);
    const bar = await screen.findByRole('toolbar', { name: 'L:toolbar' });
    fireEvent.click(within(bar).getByRole('button', { name: 'L:blockTurnInto' }));
    const opened = await screen.findByRole('menu', { name: 'L:blockTurnInto' });
    fireEvent.click(within(opened).getByRole('menuitemradio', { name: 'L:slashBulletList' }));
    expect(md(editor())).toBe('- Bir iki');
  });

  it('from the "/" menu', async () => {
    const { editor } = mount('');
    act(() => {
      editor().commands.focus('end');
    });
    typeText(editor(), 'Bir /');
    const list = await screen.findByRole('listbox', { name: 'L:slashMenu' });
    typeText(editor(), 'tür');
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['L:blockTurnIntoL:slashTurnIntoDesc']),
    );
    act(() => {
      fireEvent.keyDown(editor().view.dom, { key: 'Enter' });
    });
    const opened = await screen.findByRole('menu', { name: 'L:blockTurnInto' });
    fireEvent.click(within(opened).getByRole('menuitemradio', { name: 'L:slashHeading2' }));
    expect(editor().state.doc.child(0).type.name).toBe('heading');
    expect(editor().state.doc.child(0).attrs.level).toBe(2);
  });

  it('light editors keep their short toolbar', async () => {
    const { editor } = mount('Bir', { variant: 'light' });
    selectAllText(editor());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'L:blockTurnInto', hidden: true })).toBeNull(),
    );
  });
});
