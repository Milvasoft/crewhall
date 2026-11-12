import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markdownToDoc, type EditorDoc, type JSONNode } from '../src';
import { RichEditor, type RichEditorHandle } from '../src/react';
import { fakeLabels } from './helpers/labels';

/** Text color and highlight of a selection, from the toolbar. */

const layout = {
  rangeRect: Range.prototype.getBoundingClientRect,
  rangeRects: Range.prototype.getClientRects,
  elRects: Element.prototype.getClientRects,
};
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

function mount(md: string, props: Partial<Parameters<typeof RichEditor>[0]> = {}) {
  const ref = createRef<RichEditorHandle>();
  render(
    <RichEditor value={markdownToDoc(md).doc} labels={fakeLabels} editorRef={ref} {...props} />,
  );
  return ref.current!.getEditor();
}
type Ed = ReturnType<typeof mount>;

/** A real selection in the first paragraph, which is what opens the toolbar. */
function select(e: Ed, from: number, to: number) {
  act(() => {
    e.commands.focus();
    e.commands.setTextSelection({ from, to });
    const p = e.view.dom.querySelector('p')!;
    const range = document.createRange();
    const text = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode()!;
    range.setStart(text, from - 1);
    range.setEnd(text, to - 1);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    e.view.dispatch(e.state.tr.setMeta('test', true));
  });
}

const colored = (e: Ed): [string, unknown][] => {
  const out: [string, unknown][] = [];
  const walk = (n: JSONNode) => {
    const mark = n.marks?.find((m) => m.type === 'color');
    if (n.type === 'text' && mark) out.push([n.text ?? '', mark.attrs?.color]);
    n.content?.forEach(walk);
  };
  (e.getJSON() as EditorDoc).content?.forEach(walk);
  return out;
};

const openColors = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'L:blockColor' }));
};

describe('text color in the selection toolbar', () => {
  beforeAll(() => {
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    Range.prototype.getClientRects = noRects;
    Element.prototype.getClientRects = noRects;
  });
  afterAll(() => {
    Range.prototype.getBoundingClientRect = layout.rangeRect;
    Range.prototype.getClientRects = layout.rangeRects;
    Element.prototype.getClientRects = layout.elRects;
  });

  it('colors only the selected words and goes back to the buttons', async () => {
    const e = mount('Bir iki üç', { textColor: true });
    select(e, 5, 8);
    await openColors();
    const text = screen.getByRole('radiogroup', { name: 'L:blockColorText' });
    fireEvent.click(within(text).getByRole('radio', { name: 'L:colorRed' }));
    expect(colored(e)).toEqual([['iki', 'red']]);
    expect(screen.queryByRole('radiogroup', { name: 'L:blockColorText' })).toBeNull();
    expect(screen.getByRole('button', { name: 'L:bold' })).toBeInTheDocument();
    expect(e.state.selection.from).toBe(5);
    expect(e.state.selection.to).toBe(8);
  });

  it('highlights, replaces a color and removes it', async () => {
    const e = mount('Bir iki üç', { textColor: true });
    select(e, 1, 4);
    await openColors();
    const bg = screen.getByRole('radiogroup', { name: 'L:blockColorBackground' });
    fireEvent.click(within(bg).getByRole('radio', { name: 'L:colorYellow' }));
    expect(colored(e)).toEqual([['Bir', 'yellow-bg']]);

    await openColors();
    const again = screen.getByRole('radiogroup', { name: 'L:blockColorBackground' });
    expect(within(again).getByRole('radio', { name: 'L:colorYellow' })).toBeChecked();
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'L:blockColorText' })).getByRole('radio', {
        name: 'L:colorBlue',
      }),
    );
    expect(colored(e)).toEqual([['Bir', 'blue']]);

    await openColors();
    fireEvent.click(screen.getByRole('radio', { name: 'L:blockColorDefault' }));
    expect(colored(e)).toEqual([]);
  });

  it('keeps other marks and is one undo step', async () => {
    const e = mount('**Bir** iki', { textColor: true });
    select(e, 1, 4);
    await openColors();
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'L:blockColorText' })).getByRole('radio', {
        name: 'L:colorGreen',
      }),
    );
    expect(colored(e)).toEqual([['Bir', 'green']]);
    expect(e.isActive('bold')).toBe(true);
    act(() => {
      e.commands.undo();
    });
    expect(colored(e)).toEqual([]);
  });

  it('closes on Escape without changing anything', async () => {
    const e = mount('Bir iki', { textColor: true });
    select(e, 1, 4);
    await openColors();
    const before = JSON.stringify(e.getJSON());
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('radiogroup', { name: 'L:blockColorText' })).toBeNull(),
    );
    expect(JSON.stringify(e.getJSON())).toBe(before);
  });

  it('is only offered where the host asks for it', async () => {
    const e = mount('Bir iki');
    select(e, 1, 4);
    await screen.findByRole('button', { name: 'L:bold' });
    expect(screen.queryByRole('button', { name: 'L:blockColor' })).toBeNull();
  });
});
