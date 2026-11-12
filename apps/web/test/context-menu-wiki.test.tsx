import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { USER } from '@/mocks/seed';
import { resetWikiMock } from '@/mocks/wiki';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

// The sidebar remounts when a page opens, so every lookup starts from the screen.
const sidebar = () => screen.getByRole('complementary', { name: /Space/i });
const rows = () => [...sidebar().querySelectorAll<HTMLElement>('[data-tree-page]')];
/** The title is the last span of the row link; an emoji icon may come before it. */
const row = (name: string) =>
  rows().find((r) => r.querySelector('a > span:last-child')?.textContent === name);
const indent = (name: string) => row(name)?.querySelector('a')?.style.paddingLeft;

async function openTree() {
  signedInAs(USER.bugra);
  const rendered = renderApp('/pages/milvasoft');
  await screen.findByRole('complementary', { name: /Space/i });
  await waitFor(() => expect(row('Milvaion')).toBeDefined());
  return { ...rendered, user: userEvent.setup() };
}

/** Right click an element and read the menu it opens. */
async function menuOf(el: HTMLElement) {
  fireEvent.contextMenu(el);
  return screen.findByRole('menu');
}

describe('Sayfalar › ağaçta sağ tık', () => {
  beforeEach(() => resetWikiMock());

  it('lists the page actions with the shortcuts the tree supports', async () => {
    await openTree();
    const menu = await menuOf(row('Milvaion')!);
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Aç↵',
      'Yeni sekmede aç',
      expect.stringMatching(/^Favoriler(e ekle|den çıkar)$/),
      'Alt sayfa ekle',
      'Yeniden adlandırF2',
      'Taşı…',
      'Kopyasını oluştur…',
      'Linki kopyala',
      'Çöp kutusuna taşıDel',
    ]);
  });

  it('renames a page from the menu, with F2 and by double-clicking its title', async () => {
    const { user } = await openTree();
    await user.click(
      within(await menuOf(row('Milvaion')!)).getByRole('menuitem', { name: /Yeniden adlandır/ }),
    );
    let dialog = await screen.findByRole('dialog', { name: 'Yeniden adlandır' });
    const input = within(dialog).getByLabelText('Ad');
    await waitFor(() => expect(input).toHaveValue('Milvaion'));
    await user.clear(input);
    await user.type(input, 'Milvaion v2{Enter}');
    // The tree catches up once the Drive dialog closes.
    await waitFor(() => expect(row('Milvaion v2')).toBeDefined());

    row('Milvaion v2')!.querySelector('a')!.focus();
    await user.keyboard('{F2}');
    dialog = await screen.findByRole('dialog', { name: 'Yeniden adlandır' });
    await user.click(within(dialog).getByRole('button', { name: 'Vazgeç' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    fireEvent.doubleClick(within(row('Milvaion v2')!).getByText('Milvaion v2'));
    expect(await screen.findByRole('dialog', { name: 'Yeniden adlandır' })).toBeInTheDocument();
  });

  it('adds a sub page under the page and opens it', async () => {
    const { router, user } = await openTree();
    expect(indent('Milvaion')).toBe('10px');
    await user.click(
      within(await menuOf(row('Milvaion')!)).getByRole('menuitem', { name: 'Alt sayfa ekle' }),
    );
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/p\//));
    // The new page sits one level under its parent.
    await waitFor(() => expect(indent('Başlıksız')).toBe('24px'));
  });

  it('moves a page to the trash with Del', async () => {
    const { user } = await openTree();
    row('Milvaion')!.querySelector('a')!.focus();
    await user.keyboard('{Delete}');
    await waitFor(() => expect(row('Milvaion')).toBeUndefined());
  });

  it('offers a new page on the empty area of the tree', async () => {
    const { router, user } = await openTree();
    const menu = await menuOf(sidebar().querySelector<HTMLElement>('[data-page-tree]')!);
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Yeni sayfa']);
    await user.click(items[0]!);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/p\//));
    await waitFor(() => expect(indent('Başlıksız')).toBe('10px'));
  });
});
