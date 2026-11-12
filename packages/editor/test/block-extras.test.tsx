import { act, fireEvent, render, screen } from '@testing-library/react';
import { NodeSelection } from '@tiptap/pm/state';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { docToMarkdown, markdownToDoc, type EditorDoc } from '../src';
import {
  blockAtPos,
  blockColor,
  colorBlock,
  copyBlock,
  LONG_PRESS_MS,
  moveBlock,
  RichEditor,
  validateDoc,
  type RichEditorHandle,
} from '../src/react';
import { BlockMenu } from '../src/react/ui/BlockMenu';
import { fakeLabels } from './helpers/labels';

/** Block handle additions: Alt+Shift+↑/↓, copy, color, undo over Yjs, long-press drag. */

const doc = (md: string): EditorDoc => markdownToDoc(md).doc;

function mount(md: string, props: Partial<Parameters<typeof RichEditor>[0]> = {}) {
  const ref = createRef<RichEditorHandle>();
  render(<RichEditor value={doc(md)} labels={fakeLabels} editorRef={ref} {...props} />);
  return () => ref.current!.getEditor();
}
type Ed = ReturnType<ReturnType<typeof mount>>;

const blocks = (e: Ed) => e.state.doc.content.content.map((n) => `${n.type.name}:${n.textContent}`);

/** Position of the n-th top-level block. */
const posOf = (e: Ed, index: number) => {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += e.state.doc.child(i).nodeSize;
  return pos;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('keyboard and undo', () => {
  it('moves the block with Alt+Shift+↑ / ↓', () => {
    const e = mount('Bir\n\nİki\n\nÜç')();
    act(() => {
      e.commands.setTextSelection(posOf(e, 2) + 1);
    });
    act(() => {
      fireEvent.keyDown(e.view.dom, { key: 'ArrowUp', altKey: true, shiftKey: true });
    });
    expect(blocks(e)).toEqual(['paragraph:Bir', 'paragraph:Üç', 'paragraph:İki']);
    act(() => {
      fireEvent.keyDown(e.view.dom, { key: 'ArrowDown', altKey: true, shiftKey: true });
    });
    expect(blocks(e)).toEqual(['paragraph:Bir', 'paragraph:İki', 'paragraph:Üç']);
  });

  it('undoes a move over Yjs in one step, for both editors', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u));
    b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u));
    const first = mount('', { collaboration: { doc: a } });
    const second = mount('', { collaboration: { doc: b } });
    // Written by the other editor, so it is not in the first one's undo history.
    act(() => {
      second().commands.setContent(doc('Bir\n\nİki\n\nÜç'));
    });
    act(() => {
      moveBlock(first(), blockAtPos(first().state, posOf(first(), 2)), -1);
    });
    expect(blocks(second())).toEqual(['paragraph:Bir', 'paragraph:Üç', 'paragraph:İki']);
    act(() => {
      first().commands.undo();
    });
    expect(blocks(first())).toEqual(['paragraph:Bir', 'paragraph:İki', 'paragraph:Üç']);
    expect(blocks(second())).toEqual(['paragraph:Bir', 'paragraph:İki', 'paragraph:Üç']);
  });
});

describe('copy and color', () => {
  it('copies a block by selecting it and running the copy command', () => {
    const e = mount('Bir\n\nİki')();
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    act(() => {
      expect(copyBlock(e, blockAtPos(e.state, posOf(e, 1)))).toBe(true);
    });
    expect(exec).toHaveBeenCalledWith('copy');
    expect(e.state.selection).toBeInstanceOf(NodeSelection);
    expect(e.state.selection.from).toBe(posOf(e, 1));
  });

  it('colors a whole block, keeps it in the document and drops it in markdown', () => {
    const e = mount('- bir **kalın**\n- iki')();
    const item = () => blockAtPos(e.state, 1)!;
    expect(item().node.type.name).toBe('listItem');
    act(() => {
      colorBlock(e, item(), 'red-bg');
    });
    expect(blockColor(item())).toBe('red-bg');
    const json = e.getJSON() as EditorDoc;
    expect(validateDoc(json).ok).toBe(true);
    expect(JSON.stringify(json)).toContain('"type":"color","attrs":{"color":"red-bg"}');
    // Bold stays; markdown has no color.
    expect(docToMarkdown(json).trimEnd()).toBe('- bir **kalın**\n- iki');
    expect(e.view.dom.querySelector('span.ch-color[data-color="red-bg"]')).not.toBeNull();
    // A new color replaces it; null takes it off.
    act(() => {
      colorBlock(e, item(), 'blue');
    });
    expect(blockColor(item())).toBe('blue');
    act(() => {
      colorBlock(e, item(), null);
    });
    expect(blockColor(item())).toBeNull();
    expect(JSON.stringify(e.getJSON())).not.toContain('"color"');
  });

  it('offers copy and colors in the menu; a code block gets no colors', () => {
    const e = mount('Metin\n\n```\nkod\n```')();
    const menu = (pos: number) =>
      render(
        <BlockMenu
          editor={e}
          block={blockAtPos(e.state, pos)!}
          anchor={new DOMRect(0, 0, 20, 20)}
          labels={fakeLabels}
          onClose={() => undefined}
        />,
      );
    const first = menu(0);
    expect(screen.getByRole('menuitem', { name: 'L:blockCopy' })).toBeInTheDocument();
    const background = screen.getByRole('group', { name: 'L:blockColorBackground' });
    fireEvent.click(
      [...background.querySelectorAll('[role="menuitemradio"]')].find(
        (b) => b.getAttribute('aria-label') === 'L:colorGreen',
      )!,
    );
    expect(blockColor(blockAtPos(e.state, 0)!)).toBe('green-bg');
    first.unmount();

    menu(posOf(e, 1));
    expect(screen.queryByRole('group', { name: 'L:blockColor' })).toBeNull();
  });
});

/** A touch event as the browser sends it (jsdom has no Touch constructor). */
function touch(target: Element, type: string, x = 0, y = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }],
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('long-press drag (touch)', () => {
  /** The finger at y = 10·n is over the n-th block (jsdom has no layout). */
  function touchable(md: string) {
    const e = mount(md)();
    vi.spyOn(e.view, 'posAtCoords').mockImplementation(({ top }) => {
      const index = Math.min(Math.max(Math.round(top / 10), 0), e.state.doc.childCount - 1);
      const pos = posOf(e, index) + 1;
      return { pos, inside: pos - 1 };
    });
    return e;
  }

  it('lifts the block after a long press and drops it where the finger lets go', () => {
    vi.useFakeTimers();
    const e = touchable('Bir\n\nİki\n\nÜç');
    const dom = e.view.dom;
    touch(dom, 'touchstart', 5, 0);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    expect(dom.querySelector('.ch-touch-lifted')?.textContent).toBe('Bir');
    const move = touch(dom, 'touchmove', 5, 20);
    expect(move.defaultPrevented).toBe(true);
    expect(dom.querySelector('.ch-touch-drop')).not.toBeNull();
    touch(dom, 'touchend');
    expect(blocks(e)).toEqual(['paragraph:İki', 'paragraph:Üç', 'paragraph:Bir']);
    expect(dom.querySelector('.ch-touch-lifted, .ch-touch-drop')).toBeNull();
    // One step back.
    act(() => {
      e.commands.undo();
    });
    expect(blocks(e)).toEqual(['paragraph:Bir', 'paragraph:İki', 'paragraph:Üç']);
  });

  it('moves list items one by one', () => {
    vi.useFakeTimers();
    const e = mount('- bir\n- iki\n- üç')();
    const list = e.state.doc.child(0);
    const items = [
      1,
      1 + list.child(0).nodeSize,
      1 + list.child(0).nodeSize + list.child(1).nodeSize,
    ];
    vi.spyOn(e.view, 'posAtCoords').mockImplementation(({ top }) => {
      const pos = items[Math.min(Math.round(top / 10), 2)]! + 2;
      return { pos, inside: -1 };
    });
    touch(e.view.dom, 'touchstart', 5, 20);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    // Before the first item (jsdom rects are empty: a finger above 0 is in the top half).
    touch(e.view.dom, 'touchmove', 5, -1);
    touch(e.view.dom, 'touchend');
    expect(docToMarkdown(e.getJSON() as EditorDoc).trimEnd()).toBe('- üç\n- bir\n- iki');
  });

  it('is a scroll when the finger moves first, and text selection while typing', () => {
    vi.useFakeTimers();
    const e = touchable('Bir\n\nİki');
    touch(e.view.dom, 'touchstart', 5, 0);
    touch(e.view.dom, 'touchmove', 5, 40);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    expect(e.view.dom.querySelector('.ch-touch-lifted')).toBeNull();

    vi.spyOn(e.view, 'hasFocus').mockReturnValue(true);
    touch(e.view.dom, 'touchstart', 5, 0);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    expect(e.view.dom.querySelector('.ch-touch-lifted')).toBeNull();
    touch(e.view.dom, 'touchend');
    expect(blocks(e)).toEqual(['paragraph:Bir', 'paragraph:İki']);
  });
});
