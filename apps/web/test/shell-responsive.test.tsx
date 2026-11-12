import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** matchMedia that answers min-/max-width queries for a given viewport width. */
function setViewport(width: number) {
  window.matchMedia = (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query);
    const max = /max-width:\s*(\d+)px/.exec(query);
    const matches =
      (!min || width >= Number(min[1])) && (!max || width <= Number(max[1])) && Boolean(min || max);
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    } as MediaQueryList;
  };
}

const original = window.matchMedia;

describe('responsive shell (H10)', () => {
  beforeEach(() => {
    localStorage.removeItem('crewhall.tabletSidebar');
    signedInAs(USER.bugra);
  });
  afterEach(() => {
    window.matchMedia = original;
  });

  it('phone: bottom tabs instead of the rail, module sidebar in a drawer', async () => {
    setViewport(390);
    const { router } = renderApp('/drive/milvasoft');
    const user = userEvent.setup();
    const tabs = await screen.findByRole('navigation', { name: 'Modüller' });
    // Home and the first modules as tabs, the rest under "More".
    expect(within(tabs).getByRole('link', { name: /Drive/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(tabs).getByRole('button', { name: /Diğer/ })).toBeInTheDocument();
    expect(within(tabs).queryByRole('link', { name: /Kasa/ })).not.toBeInTheDocument();
    // Content takes the width: the sidebar is not on the page until the menu opens it.
    expect(await screen.findByRole('button', { name: 'Menüyü aç' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Space kenar çubuğu' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Menüyü aç' }));
    const drawer = await screen.findByRole('dialog', { name: 'Space kenar çubuğu' });
    await user.click(within(drawer).getByRole('link', { name: /Son açılanlar/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/drive/recent'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('phone: "More" lists the other modules and the account menu', async () => {
    setViewport(390);
    renderApp('/drive/milvasoft');
    const user = userEvent.setup();
    const tabs = await screen.findByRole('navigation', { name: 'Modüller' });
    await user.click(within(tabs).getByRole('button', { name: /Diğer/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Diğer' });
    expect(within(sheet).getByRole('link', { name: /Kasa/ })).toBeInTheDocument();
    expect(within(sheet).getByRole('link', { name: /Yönetim/ })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: /Çıkış yap/ })).toBeInTheDocument();
  });

  it('phone: the chat list is the screen on /chat, a chat has a back button', async () => {
    setViewport(390);
    const { router } = renderApp('/chat');
    const user = userEvent.setup();
    const list = await screen.findByRole('complementary', { name: 'Sohbet' });
    const first = (await within(list).findAllByRole('link')).find((a) =>
      a.getAttribute('href')?.startsWith('/chat/c/'),
    )!;
    await user.click(first);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/chat\/c\//));
    await user.click(await screen.findByRole('link', { name: 'Geri' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/chat'));
  });

  it('tablet: the sidebar starts hidden and the top-bar button pins it', async () => {
    setViewport(800);
    renderApp('/drive/milvasoft');
    const user = userEvent.setup();
    expect(await screen.findByRole('navigation', { name: 'Modüller' })).toBeInTheDocument();
    const show = await screen.findByRole('button', { name: 'Kenar çubuğunu göster' });
    expect(screen.queryByRole('complementary', { name: 'Space kenar çubuğu' })).toBeNull();
    await user.click(show);
    expect(
      await screen.findByRole('complementary', { name: 'Space kenar çubuğu' }),
    ).toBeInTheDocument();
    expect(localStorage.getItem('crewhall.tabletSidebar')).toBe('pinned');
    await user.click(screen.getByRole('button', { name: 'Kenar çubuğunu gizle' }));
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: 'Space kenar çubuğu' })).toBeNull(),
    );
  });

  it('phone: the top bar goes back to the previous screen', async () => {
    setViewport(390);
    const { router } = renderApp('/drive/milvasoft');
    const user = userEvent.setup();
    const tabs = await screen.findByRole('navigation', { name: 'Modüller' });
    // Opened on this page: nothing to go back to yet.
    expect(screen.queryByRole('button', { name: 'Geri' })).toBeNull();
    await user.click(within(tabs).getByRole('link', { name: /Sayfalar/ }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/pages/));
    await user.click(await screen.findByRole('button', { name: 'Geri' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/drive/milvasoft'));
  });

  it('phone: search opens full screen with a close button instead of Escape', async () => {
    setViewport(390);
    renderApp('/drive/milvasoft');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /içinde ara|Ara ya da/ }));
    const palette = await screen.findByRole('dialog', { name: /Komut|Ara/ });
    await user.click(within(palette).getByRole('button', { name: 'Kapat' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('phone: dialogs become a bottom sheet or fill the screen', async () => {
    setViewport(390);
    renderApp('/drive/milvasoft');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /içinde ara|Ara ya da/ }));
    // The 640 px palette fills the phone screen (no centred card, no rounded corners).
    const palette = await screen.findByRole('dialog', { name: /Komut|Ara/ });
    expect(palette.className).toMatch(/max-md:h-\[calc\(var\(--vvh/);
    expect(palette.className).toMatch(/max-md:rounded-none/);
  });

  it('phone: "More" closes on Escape, stays closed after back, asks before signing out (W5)', async () => {
    setViewport(390);
    const { router } = renderApp('/drive/milvasoft');
    const user = userEvent.setup();
    const tabs = await screen.findByRole('navigation', { name: 'Modüller' });
    const more = within(tabs).getByRole('button', { name: /Diğer/ });
    await user.click(more);
    await screen.findByRole('dialog', { name: 'Diğer' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(more).toHaveAttribute('aria-expanded', 'false'));

    await user.click(more);
    const sheet = await screen.findByRole('dialog', { name: 'Diğer' });
    await user.click(within(sheet).getByRole('button', { name: /Çıkış yap/ }));
    // One tap only asks.
    const ask = within(sheet).getByRole('group', { name: 'Çıkış yapılsın mı?' });
    expect(router.state.location.pathname).toBe('/drive/milvasoft');
    await user.click(within(ask).getByRole('button', { name: 'Vazgeç' }));
    await user.click(within(sheet).getByRole('link', { name: /Kasa/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/vault'));
    router.history.back();
    await waitFor(() => expect(router.state.location.pathname).toBe('/drive/milvasoft'));
    expect(more).toHaveAttribute('aria-expanded', 'false');
  });

  it('phone: page tools get their own row under the title (W6)', async () => {
    setViewport(390);
    renderApp('/p/milvaion-0190f0a0-0000-7000-8000-0000000017bf');
    const share = await screen.findByRole('button', { name: /Paylaş/ });
    const header = screen.getAllByRole('banner')[0]!;
    // The title row keeps back/menu, the title, search and the bell; tools sit below it.
    expect(header).not.toContainElement(share);
    expect(within(header).getByRole('button', { name: /Bildirimler/ })).toBeInTheDocument();
    expect(header.nextElementSibling).toContainElement(share);
  });

  it('phone: Drive rows are a list and a tap opens the item (W7)', async () => {
    setViewport(390);
    const { router } = renderApp('/drive/milvasoft');
    const user = userEvent.setup();
    const table = await screen.findByRole('table', { name: 'Klasör içeriği' });
    const row = (await within(table).findAllByRole('row'))[1]!;
    // Type and date move under the name.
    expect(row).toHaveTextContent(/Klasör ·/);
    await user.click(row);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/drive\/milvasoft\/folder\//));
  });

  it('desktop: rail and pinned sidebar, no menu button', async () => {
    renderApp('/drive/milvasoft');
    expect(
      await screen.findByRole('complementary', { name: 'Space kenar çubuğu' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Menüyü aç|Kenar çubuğunu/ })).toBeNull();
  });
});
