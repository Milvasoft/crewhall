import type { Editor } from '@tiptap/core';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openWikiDialog } from '@/components/wiki/dialogs';
import { USER } from '@/mocks/seed';
import { resetWikiMock } from '@/mocks/wiki';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** The live outline beside a page. */

const layout = {
  rangeRect: Range.prototype.getBoundingClientRect,
  rangeRects: Range.prototype.getClientRects,
  elRects: Element.prototype.getClientRects,
};
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

const heading = (level: number, text: string) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});

async function openPage() {
  const user = userEvent.setup();
  const sidebar = await screen.findByRole('complementary', { name: /Space/i });
  await user.click((await within(sidebar).findAllByRole('link', { name: /Milvaion/ }))[0]!);
  const dom = await waitFor(() => {
    const el = document.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
    if (!el?.editor?.isEditable) throw new Error('no editor yet');
    return el as HTMLElement & { editor: Editor };
  });
  return { user, editor: dom.editor };
}

const setBody = (editor: Editor, ...content: unknown[]) =>
  act(() => {
    editor.commands.setContent({ type: 'doc', content } as never);
  });

describe('page outline', () => {
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
  beforeEach(() => {
    resetWikiMock();
    openWikiDialog(null);
  });

  it('shows from two headings on, follows typing and jumps to a heading', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const { user, editor } = await openPage();

    setBody(editor, heading(1, 'Tek'));
    await waitFor(() =>
      expect(screen.queryByRole('navigation', { name: 'İçindekiler' })).toBeNull(),
    );

    setBody(editor, heading(1, 'Giriş'), heading(2, 'Kurulum'));
    const nav = await screen.findByRole('navigation', { name: 'İçindekiler' });
    const jump = within(nav).getByRole('button', { name: 'Kurulum' });

    const target = editor.view.dom.querySelector('h2') as HTMLElement;
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    await user.click(jump);
    expect(scroll).toHaveBeenCalledOnce();
    expect(jump).toHaveAttribute('aria-current', 'location');

    setBody(editor, heading(1, 'Giriş'), heading(2, 'Kurulum'), heading(2, 'Kullanım'));
    expect(await within(nav).findByRole('button', { name: 'Kullanım' })).toBeInTheDocument();
  });

  it('lights the heading being read as the page scrolls', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const { editor } = await openPage();
    setBody(editor, heading(1, 'Birinci'), heading(2, 'İkinci'));
    const nav = await screen.findByRole('navigation', { name: 'İçindekiler' });

    // The app shell scrolls; the first heading has passed the reading line, the second has not.
    const scroller = editor.view.dom.closest('article')!.parentElement!;
    scroller.style.overflowY = 'auto';
    const place = (el: Element, top: number) => {
      el.getBoundingClientRect = () => new DOMRect(0, top, 100, 20);
    };
    place(editor.view.dom.querySelector('h1')!, 20);
    place(editor.view.dom.querySelector('h2')!, 500);
    fireEvent.scroll(scroller);
    await waitFor(() =>
      expect(within(nav).getByRole('button', { name: 'Birinci' })).toHaveAttribute(
        'aria-current',
        'location',
      ),
    );

    place(editor.view.dom.querySelector('h2')!, 40);
    fireEvent.scroll(scroller);
    await waitFor(() =>
      expect(within(nav).getByRole('button', { name: 'İkinci' })).toHaveAttribute(
        'aria-current',
        'location',
      ),
    );
    expect(within(nav).getByRole('button', { name: 'Birinci' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('gives way to a side panel', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const { user, editor } = await openPage();
    setBody(editor, heading(1, 'Giriş'), heading(2, 'Kurulum'));
    await screen.findByRole('navigation', { name: 'İçindekiler' });
    await user.click(screen.getByRole('button', { name: /Yorumlar/ }));
    await waitFor(() =>
      expect(screen.queryByRole('navigation', { name: 'İçindekiler' })).toBeNull(),
    );
  });

  it('offers the contents block in the "/" menu', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const { user, editor } = await openPage();
    setBody(editor, { type: 'paragraph' }, heading(1, 'Giriş'));
    act(() => {
      editor.commands.focus('start');
    });
    for (const ch of '/içindekiler') {
      act(() => {
        const { view } = editor;
        const { from, to } = view.state.selection;
        const insert = () => view.state.tr.insertText(ch, from, to);
        const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, insert));
        if (!handled) view.dispatch(insert());
      });
    }
    await user.click(await screen.findByText('Sayfanın başlıklarını burada listeler'));
    expect(editor.state.doc.firstChild?.type.name).toBe('toc');
    const block = document.querySelector('.ch-toc') as HTMLElement;
    expect(within(block).getByRole('button', { name: 'Giriş' })).toBeInTheDocument();
  });
});
