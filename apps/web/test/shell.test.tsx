import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';

/** Starts a session in the mock db, as if the person had signed in. */
function signedInAs(userId: string) {
  const s = db();
  s.sessions.push({
    id: 'test-session',
    userId,
    userAgent: 'test',
    ip: null,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  });
  s.auth.sessionId = 'test-session';
}

describe('app shell', () => {
  it('shows only the modules the person may use on the rail', async () => {
    signedInAs(USER.burak);
    renderApp('/');
    const rail = await screen.findByRole('navigation', { name: 'Modüller' });
    expect(within(rail).getByRole('link', { name: 'Drive' })).toBeInTheDocument();
    expect(within(rail).queryByRole('link', { name: 'Yönetim' })).toBeNull();
    expect(within(rail).queryByRole('link', { name: 'Portal' })).toBeNull();
  });

  it('keeps members out of the admin area', async () => {
    signedInAs(USER.burak);
    const { router } = renderApp('/admin/members');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('opens the command palette with Ctrl K and filters people', async () => {
    signedInAs(USER.bugra);
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: /Ahmet/ });
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Komut paleti' });
    await user.type(within(dialog).getByRole('combobox'), 'mert');
    expect(await within(dialog).findByRole('option', { name: /Mert Aydın/ })).toBeInTheDocument();
    expect(within(dialog).getByText('1 sonuç')).toBeInTheDocument();
  });

  it('renders a 404 inside the shell for unknown spaces', async () => {
    signedInAs(USER.bugra);
    renderApp('/drive/olmayan-space');
    expect(await screen.findByRole('heading', { name: 'Bu sayfa bulunamadı' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Modüller' })).toBeInTheDocument();
  });

  it('opens the re-auth dialog when the session ends while the app is open', async () => {
    signedInAs(USER.bugra);
    const { queryClient } = renderApp('/');
    await screen.findByRole('heading', { level: 1, name: /Ahmet/ });
    db().auth.sessionId = null;
    await act(() => queryClient.invalidateQueries());
    expect(
      await screen.findByRole('dialog', { name: 'Güvenlik için yeniden doğrula' }),
    ).toBeInTheDocument();
  });
});

describe('spaces', () => {
  it('creates a space with a member and opens its settings', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/drive/milvasoft');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Space seç' }));
    await user.click(await screen.findByRole('button', { name: 'Yeni space' }));
    const dialog = await screen.findByRole('dialog', { name: 'Yeni space' });
    await user.type(within(dialog).getByLabelText('Ad'), 'Mobil');
    await user.type(within(dialog).getByLabelText('Kişi ya da e-posta ekle'), 'sel');
    // Suggestions render in a portal (doc 02 · "Açılır paneller"), outside the dialog.
    await user.click(await screen.findByRole('button', { name: /Selin Öztürk/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Space oluştur' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/spaces/mobil/settings'));
    expect(await screen.findByRole('heading', { name: 'Space ayarları' })).toBeInTheDocument();
    expect(await screen.findByText('selin@milvasoft.com')).toBeInTheDocument();
    expect(db().spaces.find((s) => s.slug === 'mobil')).toBeTruthy();
  });

  it('lists the personal space first and keeps archived spaces apart', async () => {
    signedInAs(USER.bugra);
    renderApp('/drive/milvasoft');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Space seç' }));
    const list = await screen.findByRole('listbox', { name: "Space'lerin" });
    const names = within(list)
      .getAllByRole('option')
      .map((o) => o.textContent ?? '');
    expect(names[0]).toMatch(/^Kişisel/);
    expect(names.some((n) => n.includes('Eski web sitesi'))).toBe(false);
  });
});

describe('admin', () => {
  it('lists members with pending invitations and opens the member panel', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/members');
    expect(await screen.findByText('ozan.kaya@milvasoft.com')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('row', { name: /Mert Aydın/ }));
    const panel = await screen.findByRole('complementary', { name: 'Üye' });
    expect(within(panel).getByText('mert@milvasoft.com')).toBeInTheDocument();
  });

  it('keeps the org theme unpublishable while contrast fails', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/theme');
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const darkAccent = await screen.findByLabelText('Vurgu dark hex');
    await user.clear(darkAccent);
    await user.type(darkAccent, '#1D2A80');
    expect(await screen.findByText(/kontrast sorunu/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yayınla' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Otomatik düzelt' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Yayınla' })).toBeEnabled());
  });
});
