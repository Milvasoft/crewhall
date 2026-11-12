import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { markdownToDoc, type EditorDoc } from '../src';
import {
  blockAtPos,
  blockAtSelection,
  deleteBlock,
  duplicateBlock,
  moveBlock,
  RichEditor,
  turnBlockInto,
  type RichEditorHandle,
} from '../src/react';
import { BlockMenu } from '../src/react/ui/BlockMenu';
import { fakeLabels } from './helpers/labels';

/** Block actions of the drag handle menu and Alt+↑/↓ (Notion / Outline style). */

const doc = (md: string): EditorDoc => markdownToDoc(md).doc;

function mount(md: string, props: Partial<Parameters<typeof RichEditor>[0]> = {}) {
  const ref = createRef<RichEditorHandle>();
  render(<RichEditor value={doc(md)} labels={fakeLabels} editorRef={ref} {...props} />);
  return () => ref.current!.getEditor();
}

/** Top-level blocks as "type:text". */
const blocks = (editor: ReturnType<ReturnType<typeof mount>>) =>
  editor.state.doc.content.content.map((n) => `${n.type.name}:${n.textContent}`);

/** A real keydown (the keymap plugin), as when the person presses it. */
const press = (editor: ReturnType<ReturnType<typeof mount>>, key: 'ArrowUp' | 'ArrowDown') =>
  act(() => {
    fireEvent.keyDown(editor.view.dom, { key, altKey: true });
  });

/** Caret at the start of the n-th top-level block's text. */
function caretIn(editor: ReturnType<ReturnType<typeof mount>>, index: number) {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize;
  act(() => {
    editor.commands.setTextSelection(pos + 1);
  });
  return pos;
}

describe('block actions', () => {
  it('moves the block under the caret with Alt+↑ / Alt+↓ and keeps the caret in it', () => {
    const editor = mount('Bir\n\nİki\n\nÜç');
    caretIn(editor(), 1);
    press(editor(), 'ArrowUp');
    expect(blocks(editor())).toEqual(['paragraph:İki', 'paragraph:Bir', 'paragraph:Üç']);
    expect(blockAtSelection(editor().state)?.node.textContent).toBe('İki');
    press(editor(), 'ArrowDown');
    press(editor(), 'ArrowDown');
    expect(blocks(editor())).toEqual(['paragraph:Bir', 'paragraph:Üç', 'paragraph:İki']);
    // At the edge nothing happens.
    press(editor(), 'ArrowDown');
    expect(blocks(editor())).toEqual(['paragraph:Bir', 'paragraph:Üç', 'paragraph:İki']);
  });

  it('moves list items inside their list', () => {
    const editor = mount('- elma\n- armut\n- ayva');
    const e = editor();
    act(() => {
      // Inside "ayva", the last item.
      e.commands.setTextSelection(e.state.doc.content.size - 4);
    });
    const at = blockAtSelection(e.state)!;
    expect(at.node.type.name).toBe('listItem');
    act(() => {
      moveBlock(e, at, -1);
    });
    const items = e.state.doc.child(0).content.content.map((n) => n.textContent);
    expect(items).toEqual(['elma', 'ayva', 'armut']);
  });

  it('duplicates, deletes and turns blocks into other kinds', () => {
    const editor = mount('Başlık olacak\n\nKalan');
    const e = editor();
    act(() => {
      duplicateBlock(e, blockAtPos(e.state, 0));
    });
    expect(blocks(e)).toEqual([
      'paragraph:Başlık olacak',
      'paragraph:Başlık olacak',
      'paragraph:Kalan',
    ]);
    act(() => {
      deleteBlock(e, blockAtPos(e.state, 0));
    });
    expect(blocks(e)).toEqual(['paragraph:Başlık olacak', 'paragraph:Kalan']);

    act(() => {
      turnBlockInto(e, blockAtPos(e.state, 0), 'heading2');
    });
    expect(e.state.doc.child(0).type.name).toBe('heading');
    expect(e.state.doc.child(0).attrs.level).toBe(2);
    act(() => {
      turnBlockInto(e, blockAtPos(e.state, 0), 'bulletList');
    });
    expect(blocks(e)[0]).toBe('bulletList:Başlık olacak');

    // A list item turned into a heading leaves the list.
    const item = blockAtPos(e.state, 1)!;
    expect(item.node.type.name).toBe('listItem');
    act(() => {
      turnBlockInto(e, item, 'heading1');
    });
    expect(blocks(e)[0]).toBe('heading:Başlık olacak');
  });

  it('deleting the only block leaves an empty paragraph, the only list item its list', () => {
    const editor = mount('- tek madde\n\nSonra');
    const e = editor();
    act(() => {
      deleteBlock(e, blockAtPos(e.state, 1));
    });
    expect(blocks(e)).toEqual(['paragraph:Sonra']);
    act(() => {
      deleteBlock(e, blockAtPos(e.state, 0));
    });
    expect(blocks(e)).toEqual(['paragraph:']);
  });

  it('moves blocks over Yjs: the other editor sees the new order', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u));
    b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u));
    const first = mount('', { collaboration: { doc: a } });
    const second = mount('', { collaboration: { doc: b } });
    act(() => {
      first().commands.setContent(doc('Bir\n\nİki\n\nÜç'));
    });
    expect(blocks(second())).toEqual(['paragraph:Bir', 'paragraph:İki', 'paragraph:Üç']);
    caretIn(first(), 2);
    press(first(), 'ArrowUp');
    expect(blocks(second())).toEqual(['paragraph:Bir', 'paragraph:Üç', 'paragraph:İki']);
  });
});

describe('block menu', () => {
  it('lists the actions and the kinds, marks the current one and runs a choice', async () => {
    const editor = mount('# Başlık\n\nMetin');
    const e = editor();
    const onClose = vi.fn();
    render(
      <BlockMenu
        editor={e}
        block={blockAtPos(e.state, 0)!}
        anchor={new DOMRect(0, 0, 20, 20)}
        labels={fakeLabels}
        onClose={onClose}
      />,
    );
    const menu = screen.getByRole('menu', { name: 'L:blockMenu' });
    expect(screen.getByRole('menuitem', { name: 'L:blockMoveUp' })).toBeDisabled();
    expect(screen.getByRole('menuitemradio', { name: 'L:slashHeading1' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Arrow keys move the focus between items.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('menuitem', { name: 'L:blockMoveDown' }),
      ),
    );
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'L:blockCopy' }));

    fireEvent.click(screen.getByRole('menuitem', { name: 'L:blockMoveDown' }));
    // A heading at the end gets the editor's trailing paragraph.
    expect(blocks(e).slice(0, 2)).toEqual(['paragraph:Metin', 'heading:Başlık']);
    expect(onClose).toHaveBeenCalled();
  });

  it('offers no "turn into" for blocks without text, such as a table', () => {
    const editor = mount('| a | b |\n| - | - |\n| 1 | 2 |');
    const e = editor();
    render(
      <BlockMenu
        editor={e}
        block={blockAtPos(e.state, 0)!}
        anchor={new DOMRect(0, 0, 20, 20)}
        labels={fakeLabels}
        onClose={() => undefined}
      />,
    );
    expect(screen.queryByRole('group', { name: 'L:blockTurnInto' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'L:blockDelete' })).toBeInTheDocument();
  });
});

describe('light variant', () => {
  it('offers only text blocks in the "/" menu', async () => {
    const editor = mount('', { variant: 'light' });
    act(() => {
      editor().commands.focus();
      editor().commands.insertContent('/');
    });
    const menu = await screen.findByRole('listbox', { name: 'L:slashMenu' });
    const titles = [...menu.querySelectorAll('.ch-slash-title')].map((n) => n.textContent);
    expect(titles).toContain('L:slashTaskList');
    expect(titles).not.toContain('L:slashTable');
    expect(titles).not.toContain('L:slashImage');
    expect(document.querySelector('.ch-editor--light')).not.toBeNull();
  });
});
