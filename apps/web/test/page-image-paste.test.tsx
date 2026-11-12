import type { Editor } from '@tiptap/core';
import { Slice } from '@tiptap/pm/model';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openWikiDialog } from '@/components/wiki/dialogs';
import { api } from '@/lib/api';
import { SPACE, USER } from '@/mocks/seed';
import { resetWikiMock } from '@/mocks/wiki';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** A pasted image lands in the space's Drive and the page refers to the file. */

const layout = {
  rangeRect: Range.prototype.getBoundingClientRect,
  rangeRects: Range.prototype.getClientRects,
  elRects: Element.prototype.getClientRects,
};
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

describe('images in pages', () => {
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

  it('uploads a pasted screenshot to Drive and stores a node reference', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const user = userEvent.setup();
    const sidebar = await screen.findByRole('complementary', { name: /Space/i });
    await user.click((await within(sidebar).findAllByRole('link', { name: /Milvaion/ }))[0]!);
    const dom = await waitFor(() => {
      const el = document.querySelector('.ProseMirror') as
        (HTMLElement & { editor?: Editor }) | null;
      if (!el?.editor?.isEditable) throw new Error('no editor yet');
      return el as HTMLElement & { editor: Editor };
    });
    const editor = dom.editor;
    const event = {
      clipboardData: {
        getData: () => '',
        files: [new File(['png-bytes'], 'image.png', { type: 'image/png' })],
      },
    } as unknown as ClipboardEvent;
    act(() => {
      editor.view.someProp('handlePaste', (f) => f(editor.view, event, Slice.empty));
    });
    await waitFor(() => expect(JSON.stringify(editor.getJSON())).toContain('"src":"node:'));

    // The app's own folder: Drive does not list it; asked for by role it comes back.
    const nodes = await api.call('listNodes', {
      params: { spaceId: SPACE.milvasoft },
      query: { limit: 100 },
    });
    expect(nodes.items.find((n) => n.name === 'Sayfa görselleri')).toBeUndefined();
    const folder = await api.call('createFolder', {
      params: { spaceId: SPACE.milvasoft },
      body: { name: 'Sayfa görselleri', system: 'page_images' },
    });
    const files = await api.call('listNodes', {
      params: { spaceId: SPACE.milvasoft },
      query: { parentId: folder!.id, limit: 100 },
    });
    expect(files.items.map((n) => n.name)).toEqual(['image.png']);
    expect(JSON.stringify(editor.getJSON())).toContain(`node:${files.items[0]!.id}`);
  });

  it('uploads a pasted document to Drive and embeds it as a card', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const user = userEvent.setup();
    const sidebar = await screen.findByRole('complementary', { name: /Space/i });
    await user.click((await within(sidebar).findAllByRole('link', { name: /Milvaion/ }))[0]!);
    const dom = await waitFor(() => {
      const el = document.querySelector('.ProseMirror') as
        (HTMLElement & { editor?: Editor }) | null;
      if (!el?.editor?.isEditable) throw new Error('no editor yet');
      return el as HTMLElement & { editor: Editor };
    });
    const editor = dom.editor;
    const event = {
      clipboardData: {
        getData: () => '',
        files: [new File(['%PDF'], 'rapor.pdf', { type: 'application/pdf' })],
      },
    } as unknown as ClipboardEvent;
    act(() => {
      editor.view.someProp('handlePaste', (f) => f(editor.view, event, Slice.empty));
    });
    await waitFor(() => expect(JSON.stringify(editor.getJSON())).toContain('"type":"embed"'));

    // The app's own folder: Drive does not list it; asked for by role it comes back.
    const nodes = await api.call('listNodes', {
      params: { spaceId: SPACE.milvasoft },
      query: { limit: 100 },
    });
    expect(nodes.items.find((n) => n.name === 'Sayfa ekleri')).toBeUndefined();
    const folder = await api.call('createFolder', {
      params: { spaceId: SPACE.milvasoft },
      body: { name: 'Sayfa ekleri', system: 'page_attachments' },
    });
    const files = await api.call('listNodes', {
      params: { spaceId: SPACE.milvasoft },
      query: { parentId: folder!.id, limit: 100 },
    });
    expect(files.items.map((n) => n.name)).toEqual(['rapor.pdf']);
    expect(JSON.stringify(editor.getJSON())).toContain(`"nodeId":"${files.items[0]!.id}"`);
    expect(await screen.findByText('rapor.pdf')).toBeInTheDocument();
  });
});
