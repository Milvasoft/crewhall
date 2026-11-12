import type { Editor } from '@tiptap/core';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openWikiDialog } from '@/components/wiki/dialogs';
import { isVideoNode } from '@/features/drive/fileKinds';
import { USER } from '@/mocks/seed';
import { resetWikiMock } from '@/mocks/wiki';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** An empty video block takes a video from Drive; other files cannot be picked for it. */

const layout = {
  rangeRect: Range.prototype.getBoundingClientRect,
  rangeRects: Range.prototype.getClientRects,
  elRects: Element.prototype.getClientRects,
};
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

describe('video files in pages', () => {
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

  it('knows a video by its type, or by its name while it is processed', () => {
    expect(isVideoNode({ type: 'file', name: 'a.mp4', mime: 'video/mp4' })).toBe(true);
    expect(isVideoNode({ type: 'file', name: 'kayit.webm', mime: null })).toBe(true);
    expect(isVideoNode({ type: 'file', name: 'rapor.pdf', mime: 'application/pdf' })).toBe(false);
    expect(isVideoNode({ type: 'folder', name: 'video.mp4', mime: null })).toBe(false);
  });

  it('plays a video chosen from Drive', async () => {
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
    act(() => {
      editor
        .chain()
        .focus('end')
        .insertContent({ type: 'video', attrs: { src: '' } })
        .run();
    });

    await user.click(await screen.findByRole('button', { name: "Drive'dan seç" }));
    const dialog = await screen.findByRole('dialog', { name: 'Oynatılacak videoyu seç' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Ada göre ara' }), 'mil');
    const video = await within(dialog).findByRole('button', { name: 'milvaion-demo.mp4' });
    const pdf = await within(dialog).findByRole('button', { name: 'milva-sunum-2025.pdf' });
    expect(pdf).toBeDisabled();
    await user.click(video);
    await user.click(within(dialog).getByRole('button', { name: 'Göm' }));

    await waitFor(() => {
      const json = JSON.stringify(editor.getJSON());
      expect(json).toMatch(
        /"type":"video","attrs":\{"src":"node:[^"]+","title":"milvaion-demo.mp4"/,
      );
    });
  });
});
