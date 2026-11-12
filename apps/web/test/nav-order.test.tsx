import { Toaster } from '@crewhall/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { applyNavOrder, fitRail, moveId } from '@/lib/shell/navOrder';
import { comboLabel, recordCombo, shortcutOf } from '@/lib/shell/shortcuts';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const rail = () =>
  within(screen.getByRole('navigation', { name: 'Modüller' }))
    .getAllByRole('link')
    .map((a) => a.getAttribute('href'));

describe('left menu order (Hesabım › Görünüm)', () => {
  it('orders listed ids first and keeps the rest in their default place', () => {
    const e = ['chat', 'drive', 'pages', 'meet'].map((id) => ({ id }));
    expect(applyNavOrder(e, ['meet', 'chat']).map((x) => x.id)).toEqual([
      'meet',
      'chat',
      'drive',
      'pages',
    ]);
    // Unknown ids (a module switched off) are ignored.
    expect(applyNavOrder(e, ['mail', 'pages']).map((x) => x.id)).toEqual([
      'pages',
      'chat',
      'drive',
      'meet',
    ]);
    expect(moveId(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
    expect(moveId(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
  });

  it('hides an entry from the rail, keeps it in the settings and brings it back', async () => {
    signedInAs(USER.bugra);
    renderApp('/account/appearance');
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Sol menü' });
    expect(rail()).toContain('/meetings');
    await user.click(within(list).getByRole('button', { name: 'Toplantılar gizle' }));
    await waitFor(() => expect(rail()).not.toContain('/meetings'));
    expect((await api.call('getUiPrefs')).railHidden).toEqual(['meet']);
    await user.click(within(list).getByRole('button', { name: 'Toplantılar göster' }));
    await waitFor(() => expect(rail()).toContain('/meetings'));
  });

  it('assigns a shortcut, refuses browser keys and a taken one, and the key navigates', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/account/appearance');
    render(<Toaster />);
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Sol menü' });
    await user.click(within(list).getByRole('button', { name: 'Toplantılar kısayolu' }));
    await user.keyboard('{Control>}t{/Control}');
    expect(await screen.findByText(/tarayıcı ya da sistemle çakışır/)).toBeInTheDocument();
    await user.keyboard('c');
    expect(await screen.findByText('Bu kısayol Chat için kullanılıyor.')).toBeInTheDocument();
    await user.keyboard('j');
    await waitFor(async () =>
      expect((await api.call('getUiPrefs')).railShortcuts).toEqual({ meet: 'g j' }),
    );
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('gj');
    await waitFor(() => expect(router.state.location.pathname).toBe('/meetings'));
  });

  it('does not take keys from a text field, and ? opens the list', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/admin/members');
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox'), 'gd');
    expect(router.state.location.pathname).toBe('/admin/members');
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('?');
    expect(await screen.findByRole('dialog', { name: 'Klavye kısayolları' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('records only keys that stay clear of the browser and the OS', () => {
    const press = (key: string, code: string, mods: Partial<KeyboardEvent> = {}) =>
      recordCombo({
        key,
        code,
        altKey: false,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        ...mods,
      });
    expect(press('j', 'KeyJ')).toEqual({ combo: 'g j' });
    expect(press('7', 'Digit7')).toEqual({ combo: 'g 7' });
    // macOS turns Alt Shift J into a symbol; the physical key still names it.
    expect(press('Ô', 'KeyJ', { altKey: true, shiftKey: true })).toEqual({ combo: 'alt+shift+j' });
    expect(press('t', 'KeyT', { ctrlKey: true })).toEqual({ reserved: true });
    expect(press('d', 'KeyD', { altKey: true })).toEqual({ reserved: true });
    expect(press('F5', 'F5')).toEqual({ reserved: true });
    expect(press('ş', 'Semicolon')).toEqual({ reserved: true });
    expect(press('Shift', 'ShiftLeft', { shiftKey: true })).toEqual({ waiting: true });
    expect(comboLabel('alt+shift+j')).toEqual(['Alt', 'Shift', 'J']);
    expect(shortcutOf('chat', { chat: '' })).toBe('');
    expect(shortcutOf('chat', undefined)).toBe('g c');
  });

  it('puts what does not fit under Diğer, keeps admin and the entry you are on', () => {
    const entry = (id: string, active = false) => ({ id, active });
    const modules = ['home', 'chat', 'drive', 'pages', 'boards', 'meet', 'mail'].map((id) =>
      entry(id),
    );
    const extra = [entry('admin')];
    expect(fitRail(modules, extra, 0).more).toEqual([]);
    expect(fitRail(modules, extra, 900).more).toEqual([]);
    const short = fitRail(modules, extra, 140 + 48 * 5);
    expect(short.extra.map((e) => e.id)).toEqual(['admin']);
    expect(short.modules.map((e) => e.id)).toEqual(['home', 'chat', 'drive']);
    expect(short.more.map((e) => e.id)).toEqual(['pages', 'boards', 'meet', 'mail']);
    const on = fitRail(
      modules.map((m) => entry(m.id, m.id === 'mail')),
      extra,
      140 + 48 * 5,
    );
    expect(on.modules.map((e) => e.id)).toEqual(['home', 'chat', 'mail']);
    expect(on.more.map((e) => e.id)).toEqual(['drive', 'pages', 'boards', 'meet']);
  });

  it('moves a module up from the settings, the rail follows and the order is saved', async () => {
    signedInAs(USER.bugra);
    renderApp('/account/appearance');
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Sol menü' });
    const before = rail();
    expect(before.indexOf('/meetings')).toBeGreaterThan(before.indexOf('/drive'));
    // Home cannot move; Toplantılar goes up above Çizimler, Panolar, Sayfalar, Drive and Chat.
    for (let i = 0; i < 5; i++) {
      await user.click(within(list).getByRole('button', { name: 'Toplantılar yukarı taşı' }));
    }
    // Right after Ana sayfa (the org logo links home too).
    await waitFor(() => expect(rail().indexOf('/meetings')).toBe(rail().lastIndexOf('/') + 1));
    // The phone app's order (navOrder) stays out of it.
    const saved = await api.call('getUiPrefs');
    expect(saved.railOrder?.slice(0, 2)).toEqual(['meet', 'chat']);
    expect(saved.navOrder).toEqual([]);
    expect(within(list).getByRole('button', { name: 'Toplantılar yukarı taşı' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Varsayılana dön' }));
    await waitFor(() => expect(rail()).toEqual(before));
    expect((await api.call('getUiPrefs')).railOrder).toEqual([]);
  });
});
