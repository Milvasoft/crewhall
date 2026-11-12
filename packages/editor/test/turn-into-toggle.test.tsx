import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { docToMarkdown, markdownToDoc, type EditorDoc } from '../src';
import {
  blockAtPos,
  canTurnIntoToggle,
  RichEditor,
  turnBlockIntoToggle,
  type RichEditorHandle,
} from '../src/react';
import { BlockMenu } from '../src/react/ui/BlockMenu';
import { fakeLabels } from './helpers/labels';

function mount(text: string) {
  const ref = createRef<RichEditorHandle>();
  const utils = render(
    <RichEditor value={markdownToDoc(text).doc} labels={fakeLabels} editorRef={ref} />,
  );
  return { ...utils, editor: () => ref.current!.getEditor() };
}
type Ed = ReturnType<ReturnType<typeof mount>['editor']>;

const md = (e: Ed) => docToMarkdown(e.getJSON() as EditorDoc).trimEnd();

describe('turning a block into a toggle', () => {
  const level = (e: Ed) => e.getJSON().content?.[0];

  it('makes a heading a toggle heading of the same text, with the caret in its body', () => {
    const { editor } = mount('## Kurulum **adımları**\n\nSonra');
    const e = editor();
    act(() => {
      expect(turnBlockIntoToggle(e, blockAtPos(e.state, 0), 2)).toBe(true);
    });
    expect(level(e)).toEqual({
      type: 'toggle',
      attrs: { summary: 'Kurulum adımları', level: 2 },
      content: [{ type: 'paragraph' }],
    });
    expect(e.state.selection.$from.parent.type.name).toBe('paragraph');
    expect(e.state.selection.$from.node(1).type.name).toBe('toggle');
    expect(md(e)).toContain(':::toggle[Kurulum adımları]{level=2}');
  });

  it('changes the kind of a toggle and keeps its body', () => {
    const { editor } = mount(':::toggle[Özet]\nGövde\n:::');
    const e = editor();
    act(() => {
      turnBlockIntoToggle(e, blockAtPos(e.state, 0), 1);
    });
    expect(level(e)).toMatchObject({ attrs: { summary: 'Özet', level: 1 } });
    expect(e.state.doc.textContent).toBe('Gövde');
    act(() => {
      turnBlockIntoToggle(e, blockAtPos(e.state, 0), null);
    });
    expect(level(e)).toMatchObject({ attrs: { summary: 'Özet', level: null } });
    expect(md(e)).toBe(':::toggle[Özet]\nGövde\n:::');
  });

  it('refuses what would lose content or does not fit', () => {
    const { editor } = mount('Görsel ![a](x.png) içeren\n\n- madde\n\n```\nkod\n```');
    const e = editor();
    const { state } = e;
    expect(canTurnIntoToggle(blockAtPos(state, 0), state)).toBe(false);
    // The first block of a list item must stay a paragraph.
    let inItem = -1;
    let code = -1;
    state.doc.descendants((n, pos, parent) => {
      if (n.type.name === 'paragraph' && parent?.type.name === 'listItem') inItem = pos;
      if (n.type.name === 'codeBlock') code = pos;
    });
    expect(canTurnIntoToggle(blockAtPos(state, inItem), state)).toBe(false);
    expect(canTurnIntoToggle(blockAtPos(state, code), state)).toBe(false);
  });

  it('offers the kinds in the menu, with only them on a toggle', () => {
    const { editor } = mount(':::toggle[Özet]\nGövde\n:::\n\nMetin');
    const e = editor();
    const onClose = () => undefined;
    const open = (pos: number) =>
      render(
        <BlockMenu
          editor={e}
          block={blockAtPos(e.state, pos)!}
          anchor={new DOMRect(0, 0, 10, 10)}
          labels={fakeLabels}
          onClose={onClose}
        />,
      );
    const onToggle = open(0);
    const group = () => screen.getByRole('group', { name: 'L:blockTurnInto' });
    expect(within(group()).getByRole('menuitemradio', { name: 'L:slashToggle' })).toBeChecked();
    expect(within(group()).queryByRole('menuitemradio', { name: 'L:slashHeading1' })).toBeNull();
    act(() => {
      fireEvent.click(
        within(group()).getByRole('menuitemradio', { name: 'L:slashToggleHeading3' }),
      );
    });
    expect(e.getJSON().content?.[0]).toMatchObject({ attrs: { level: 3 } });
    onToggle.unmount();

    const text = e.state.doc.child(0).nodeSize;
    open(text);
    expect(within(group()).getByRole('menuitemradio', { name: 'L:slashText' })).toBeChecked();
    expect(
      within(group()).getByRole('menuitemradio', { name: 'L:slashToggleHeading1' }),
    ).toBeInTheDocument();
  });
});
