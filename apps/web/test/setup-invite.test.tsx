import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { db, resetDb } from '@/mocks/db';
import { MOCK_INVITE_TOKEN, MOCK_SETUP_TOKEN, USER } from '@/mocks/seed';
import { renderApp } from './support/render';

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

describe('setup wizard', () => {
  it('sends org, owner, spaces and invitations in one request and shows links without SMTP', async () => {
    resetDb('setup');
    const { router } = renderApp('/setup');
    const user = userEvent.setup();

    // Step 1: the empty install asks for the setup token and shows the system checks.
    await user.type(await screen.findByLabelText('Kurulum anahtarı'), MOCK_SETUP_TOKEN);
    expect(screen.getByText('Sistem kontrolü')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Kurum adı'), 'Kuzey Lojistik');
    expect(screen.getByLabelText('Kurum kimliği')).toHaveValue('kuzey-lojistik');
    await user.click(screen.getByRole('button', { name: 'Devam' }));

    // Step 2: owner.
    await user.type(await screen.findByLabelText('Ad soyad'), 'Deniz Acar');
    await user.type(screen.getByLabelText('E-posta'), 'deniz@kuzey.test');
    await user.type(screen.getByLabelText('Şifre'), 'liman-kule-vinc-2026');
    await user.click(screen.getByRole('button', { name: 'Devam' }));

    // Step 3: the org name is the default space; add one more.
    await user.click(await screen.findByRole('button', { name: 'Space ekle' }));
    const names = screen.getAllByLabelText('Ad');
    await user.type(names[1] as HTMLElement, 'Depo');
    await user.click(screen.getByRole('button', { name: '2 space oluştur' }));

    // Step 4: invitations; the outside domain becomes a guest.
    const chips = await screen.findByPlaceholderText('Adresleri yapıştır ya da yaz');
    await user.type(chips, 'ece@kuzey.test ece@gmail.test ');
    expect(screen.getByText(/ece@gmail.test: kurum alan adı dışında/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Davet et ve bitir' }));

    // No SMTP in the empty install: the links are listed to copy.
    expect(await screen.findByRole('heading', { name: 'Davet bağlantıları' })).toBeInTheDocument();
    expect(screen.getAllByText(/\/invite\//)).toHaveLength(2);

    const s = db();
    expect(s.needsSetup).toBe(false);
    expect(s.spaces.filter((x) => x.kind === 'shared').map((x) => [x.name, x.isDefault])).toEqual([
      ['Kuzey Lojistik', true],
      ['Depo', false],
    ]);
    expect(s.invitations.map((i) => [i.email, i.role])).toEqual([
      ['ece@kuzey.test', 'member'],
      ['ece@gmail.test', 'guest'],
    ]);

    await user.click(screen.getByRole('button', { name: 'Devam' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/security/2fa-setup'));
    // ~6 s alone; a full turbo run beside other workspaces' test runs took past 20 s.
  }, 60_000);

  it('rejects a wrong setup token and returns to the first step', async () => {
    resetDb('setup');
    renderApp('/setup');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Kurulum anahtarı'), 'yanlis');
    await user.type(screen.getByLabelText('Kurum adı'), 'Kuzey');
    await user.click(screen.getByRole('button', { name: 'Devam' }));
    await user.type(await screen.findByLabelText('Ad soyad'), 'Deniz Acar');
    await user.type(screen.getByLabelText('E-posta'), 'deniz@kuzey.test');
    await user.type(screen.getByLabelText('Şifre'), 'liman-kule-vinc-2026');
    await user.click(screen.getByRole('button', { name: 'Devam' }));
    await user.click(await screen.findByRole('button', { name: '1 space oluştur' }));
    await user.click(await screen.findByRole('button', { name: 'Şimdilik atla' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/anahtar/i);
    expect(screen.getByLabelText('Kurulum anahtarı')).toBeInTheDocument();
  });
});

describe('invitation', () => {
  it('shows the spaces the invitee joins and creates the account', async () => {
    const { router } = renderApp(`/invite/${MOCK_INVITE_TOKEN}`);
    const user = userEvent.setup();
    expect(await screen.findByText('Hesabını oluştur')).toBeInTheDocument();
    expect(screen.getByText("Space'ler").parentElement).toHaveTextContent('MilvasoftDüzenleyen');
    await user.type(screen.getByLabelText('Ad soyad'), 'Ozan Kaya');
    await user.type(screen.getByLabelText('Şifre'), 'deniz-feneri-2026');
    await user.click(screen.getByRole('button', { name: 'Hesabı oluştur ve katıl' }));
    await waitFor(() => expect(router.state.location.pathname).not.toMatch(/invite/));
    const member = db().members.find(
      (m) => db().users.find((u) => u.id === m.userId)?.email === 'ozan.kaya@milvasoft.com',
    );
    expect(member?.role).toBe('member');
  });

  it('asks an existing account to sign in instead of signing up', async () => {
    db().invitations[0]!.email = 'selin@milvasoft.com';
    renderApp(`/invite/${MOCK_INVITE_TOKEN}`);
    expect(await screen.findByRole('heading', { name: 'Hesabınla giriş yap' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Ad soyad')).toBeNull();
  });

  it('warns when signed in with another account', async () => {
    signedInAs(USER.can);
    renderApp(`/invite/${MOCK_INVITE_TOKEN}`);
    expect(await screen.findByText(/Bu davet ozan.kaya@milvasoft.com için/)).toBeInTheDocument();
  });
});

describe('admin spaces', () => {
  it('lists every shared space, also ones the admin is not a member of', async () => {
    signedInAs(USER.elif);
    renderApp('/admin/spaces');
    const row = await screen.findByRole('row', { name: /Opsiyon/ });
    expect(within(row).getByText('Üye değilsin')).toBeInTheDocument();
    expect(
      within(screen.getByRole('row', { name: /^Milvasoft/ })).getByText(/Varsayılan/),
    ).toBeInTheDocument();
  });
});
