import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { USER } from '@/mocks/seed';
import { openWikiDialog } from '@/components/wiki/dialogs';
import { resetWikiMock } from '@/mocks/wiki';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Template gallery (roadmap 8): pages, boards and spaces from the gallery; saving templates. */

const layout = {
  rangeRect: Range.prototype.getBoundingClientRect,
  rangeRects: Range.prototype.getClientRects,
  elRects: Element.prototype.getClientRects,
};
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

async function openGallery() {
  const user = userEvent.setup();
  renderApp('/pages/milvasoft');
  const sidebar = await screen.findByRole('complementary', { name: /Space/i });
  await user.click(await within(sidebar).findByRole('button', { name: 'Şablonlar' }));
  const dialog = await screen.findByRole('dialog', { name: 'Şablon galerisi' });
  return { user, dialog };
}

describe('template gallery (roadmap 8)', () => {
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
    // The wiki dialog store outlives a render.
    openWikiDialog(null);
  });

  it('shows page, board and space templates and filters by kind', async () => {
    signedInAs(USER.bugra);
    const { user, dialog } = await openGallery();
    const list = within(dialog).getByRole('listbox', { name: 'Şablon galerisi' });
    // Opened from the pages module: page templates first.
    expect(await within(list).findByRole('option', { name: /Toplantı notu/ })).toBeInTheDocument();
    expect(within(list).queryByRole('option', { name: /Oryantasyon görevleri/ })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Tümü' }));
    // The board template, and the space template whose preview lists that board.
    expect(within(list).getAllByRole('option', { name: /Oryantasyon görevleri/ })).toHaveLength(2);
    await user.click(within(dialog).getByRole('button', { name: 'Space' }));
    expect(
      within(list)
        .getAllByRole('option')
        .every((o) => /Oryantasyon/.test(o.textContent ?? '')),
    ).toBe(true);
  });

  it('creates a page from a template and opens it', async () => {
    signedInAs(USER.bugra);
    const { user, dialog } = await openGallery();
    await user.click(await within(dialog).findByRole('option', { name: /Toplantı notu/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Bu şablonu kullan' }));
    await waitFor(() => expect(window.location.pathname).toBeDefined());
    expect(await screen.findByDisplayValue('Toplantı notu')).toBeInTheDocument();
  });

  it('adds a space template to the space and opens its first page', async () => {
    signedInAs(USER.bugra);
    const { user, dialog } = await openGallery();
    await user.click(within(dialog).getByRole('button', { name: 'Space' }));
    await user.click(await within(dialog).findByRole('option', { name: /Oryantasyon/ }));
    await user.click(within(dialog).getByRole('button', { name: "Bu space'e ekle" }));
    expect(await screen.findByDisplayValue('Hoş geldin')).toBeInTheDocument();
    const sidebar = await screen.findByRole('complementary', { name: /Space/i });
    expect(await within(sidebar).findByText('Hoş geldin')).toBeInTheDocument();
  });

  it('saves a page as an org template that then shows in the gallery', async () => {
    signedInAs(USER.bugra);
    const user = userEvent.setup();
    renderApp('/pages/milvasoft');
    const sidebar = await screen.findByRole('complementary', { name: /Space/i });
    await user.click((await within(sidebar).findAllByRole('link', { name: /Milvaion/ }))[0]!);
    await user.click(await screen.findByRole('button', { name: 'Sayfa menüsü' }));
    await user.click(await screen.findByRole('menuitem', { name: /Şablon olarak kaydet/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Sayfayı şablon olarak kaydet' });
    const name = within(dialog).getByLabelText('Şablon adı');
    await user.clear(name);
    await user.type(name, 'Ürün özeti');
    await user.click(within(dialog).getByRole('radio', { name: 'Kurum' }));
    await user.click(within(dialog).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // The page view renders its own sidebar: query it again.
    const pageSidebar = await screen.findByRole('complementary', { name: /Space/i });
    await user.click(await within(pageSidebar).findByRole('button', { name: 'Şablonlar' }));
    const gallery = await screen.findByRole('dialog', { name: 'Şablon galerisi' });
    await user.click(within(gallery).getByRole('button', { name: /^Kurum/ }));
    expect(await within(gallery).findByRole('option', { name: /Ürün özeti/ })).toBeInTheDocument();
  });
});
