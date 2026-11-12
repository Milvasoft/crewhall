import type { Editor } from '@tiptap/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openWikiDialog } from '@/components/wiki/dialogs';
import { api } from '@/lib/api';
import { USER } from '@/mocks/seed';
import { resetWikiMock } from '@/mocks/wiki';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** "Tamamlananları gizle": a person's view of one page; the document stays as it is. */

const layout = {
  rangeRect: Range.prototype.getBoundingClientRect,
  rangeRects: Range.prototype.getClientRects,
  elRects: Element.prototype.getClientRects,
};
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

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

const checkable = {
  type: 'doc',
  content: [
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: true },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bitti' }] }],
        },
        {
          type: 'taskItem',
          attrs: { checked: false },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Açık' }] }],
        },
      ],
    },
  ],
};

describe('hide completed to-dos', () => {
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

  it('appears when the page has any, hides per person, and leaves the document alone', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const { user, editor } = await openPage();
    expect(screen.queryByRole('button', { name: /Tamamlananları gizle/ })).toBeNull();

    act(() => {
      editor.commands.setContent(checkable);
    });
    const hide = await screen.findByRole('button', { name: 'Tamamlananları gizle (1)' });
    const before = JSON.stringify(editor.getJSON());
    const article = () => document.querySelector('article')!;
    expect(article()).not.toHaveClass('wk-hide-done');
    await user.click(hide);
    expect(article()).toHaveClass('wk-hide-done');
    const prefs = await api.call('getUiPrefs');
    expect(prefs.pagesHideDone).toHaveLength(1);
    expect(JSON.stringify(editor.getJSON())).toBe(before);

    await user.click(screen.getByRole('button', { name: 'Tamamlananları göster (1)' }));
    expect(article()).not.toHaveClass('wk-hide-done');
    await waitFor(async () => expect((await api.call('getUiPrefs')).pagesHideDone).toEqual([]));
  });
});
