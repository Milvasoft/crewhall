import type { TablesWsEvent } from '@crewhall/shared';
import type { Editor } from '@tiptap/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openWikiDialog } from '@/components/wiki/dialogs';
import { api } from '@/lib/api';
import { handleTablesEvent } from '@/lib/tables/api';
import { SPACE, USER } from '@/mocks/seed';
import { resetWikiMock } from '@/mocks/wiki';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** A table of the Tables module, live inside a page. */

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

const embed = (nodeId: string) => ({ type: 'embed', attrs: { nodeId, nodeType: 'table' } });

const setBody = (editor: Editor, ...content: unknown[]) =>
  act(() => {
    editor.commands.setContent({ type: 'doc', content } as never);
  });

async function firstTable() {
  const { items } = await api.call('listTables', { params: { spaceId: SPACE.milvasoft } });
  return items[0]!;
}

describe('table embedded in a page', () => {
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

  it('shows the rows of the table and a way into it', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const { editor } = await openPage();
    const table = await firstTable();
    const { items: rows } = await api.call('queryTableRows', {
      params: { tableId: table.id },
      query: { limit: 10 },
    });
    setBody(editor, embed(table.id));

    const card = await waitFor(() => {
      const el = document.querySelector('.wk-table-embed');
      if (!el || !el.querySelector('tbody tr')) throw new Error('not loaded');
      return el as HTMLElement;
    });
    expect(within(card).getByText(table.name)).toBeInTheDocument();
    expect(card.querySelectorAll('tbody tr')).toHaveLength(Math.min(rows.length, 10));
    const open = within(card).getByRole('link', { name: 'Aç' });
    expect(open.getAttribute('href')).toContain(`/tables/t/${table.id}`);
    const rowLink = card.querySelector('tbody a') as HTMLAnchorElement;
    expect(rowLink.getAttribute('href')).toContain(`row=${rows[0]!.id}`);
  });

  it('follows the table when someone changes a row', async () => {
    signedInAs(USER.bugra);
    const { queryClient } = renderApp('/pages/milvasoft');
    const { editor } = await openPage();
    const table = await firstTable();
    setBody(editor, embed(table.id));
    const firstCell = () => document.querySelector('.wk-table-embed tbody a');
    await waitFor(() => expect(firstCell()).not.toBeNull());

    const full = await api.call('getTable', { params: { tableId: table.id } });
    const primary = full.fields.find((f) => f.primary)!;
    const { items } = await api.call('queryTableRows', {
      params: { tableId: table.id },
      query: { limit: 1 },
    });
    await api.call('updateTableRow', {
      params: { tableId: table.id, rowId: items[0]!.id },
      body: { values: { [primary.id]: 'Yeni ad' } },
    });
    act(() => {
      handleTablesEvent(queryClient, {
        tableId: table.id,
        rev: full.rev + 1,
        rowIds: [items[0]!.id],
      } as TablesWsEvent);
    });
    await waitFor(() => expect(firstCell()).toHaveTextContent('Yeni ad'));
  });

  it('says so when the table cannot be seen', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const { editor } = await openPage();
    setBody(editor, embed('0190f0a0-0000-7000-8000-00000000dead'));
    expect(await screen.findByText('Erişim yok')).toBeInTheDocument();
  });

  it('links a table from the "/" menu', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const { user, editor } = await openPage();
    const table = await firstTable();
    setBody(editor, { type: 'paragraph' });
    act(() => {
      editor.commands.focus('start');
    });
    for (const ch of '/bağlı') {
      act(() => {
        const { view } = editor;
        const { from, to } = view.state.selection;
        const insert = () => view.state.tr.insertText(ch, from, to);
        const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, insert));
        if (!handled) view.dispatch(insert());
      });
    }
    await user.click(await screen.findByText('Bağlı tablo'));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: table.name }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(JSON.stringify(editor.getJSON())).toContain(`"nodeId":"${table.id}","nodeType":"table"`);
  });
});
