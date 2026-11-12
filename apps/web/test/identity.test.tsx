import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { db } from '@/mocks/db';
import { identityMockState } from '@/mocks/identity';
import { MOCK_PASSWORD, USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

describe('module switches', () => {
  it('hides a disabled module from the rail and shows the disabled screen on its route', async () => {
    db().org!.settings.modules = { vault: false };
    signedInAs(USER.bugra);
    renderApp('/vault');
    expect(await screen.findByText('Bu modül kurumunda kapalı')).toBeInTheDocument();
    const rail = screen.getByRole('navigation', { name: 'Modüller' });
    expect(within(rail).queryByRole('link', { name: 'Kasa' })).toBeNull();
    expect(within(rail).getByRole('link', { name: 'Chat' })).toBeInTheDocument();
  });

  it('leaves boards and drawings out of Drive and Ctrl K while boards is off', async () => {
    db().org!.settings.modules = { boards: false };
    signedInAs(USER.bugra);
    renderApp('/drive/milvasoft');
    const user = userEvent.setup();
    // "Onboarding" is also a page in the sidebar tree, so look inside the folder table only.
    const table = await screen.findByRole('table', { name: 'Klasör içeriği' });
    expect(await within(table).findByText('Onboarding')).toBeInTheDocument();
    expect(screen.queryByText('Milvaion Yol Haritası')).toBeNull();
    expect(screen.queryByText('Hub mimarisi')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pano' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Yeni' }));
    expect(await screen.findByRole('menuitem', { name: 'Sayfa' })).toBeEnabled();
    expect(screen.queryByRole('menuitem', { name: 'Pano' })).toBeNull();
    await user.keyboard('{Escape}');

    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'Yol Harita');
    expect(await screen.findByText('Sonuç yok. Başka bir kelime dene.')).toBeInTheDocument();
  });

  it('saves the switches from Yönetim › Genel', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/general');
    const user = userEvent.setup();
    const chat = await screen.findByRole('switch', { name: /^Chat/ });
    expect(chat).toBeChecked();
    await user.click(chat);
    expect(screen.getByText('Kaydedilmemiş 1 değişiklik')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(db().org!.settings.modules?.chat).toBe(false));
    const rail = screen.getByRole('navigation', { name: 'Modüller' });
    await waitFor(() => expect(within(rail).queryByRole('link', { name: 'Chat' })).toBeNull());
  });
});

describe('sign-in with the identity module', () => {
  it('signs in with a directory account and goes on to 2FA', async () => {
    renderApp('/login');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: 'Dizin hesabıyla' }));
    await user.type(screen.getByLabelText('Active Directory hesabı'), 'elif');
    await user.type(screen.getByLabelText('Şifre'), MOCK_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Giriş yap' }));
    expect(await screen.findByRole('heading', { name: 'Doğrulama kodu' })).toBeInTheDocument();
  });

  it('offers the provider for an SSO-only domain and explains a refused password', async () => {
    renderApp('/login');
    const user = userEvent.setup();
    expect(
      await screen.findByRole('button', { name: 'Keycloak ile giriş yap' }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('E-posta'), 'ayse@partner.example.com');
    await user.tab();
    expect(await screen.findByText('Bu alan adı Keycloak ile giriş yapar.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Şifre'), 'whatever-123');
    await user.click(screen.getByRole('button', { name: 'Giriş yap' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'kurumun kimlik sağlayıcısıyla giriş yapmalı',
    );
  });

  it('shows an SSO round-trip error from the api in the form', async () => {
    renderApp('/login?ssoError=sso_account_not_linked');
    expect(await screen.findByRole('alert')).toHaveTextContent('Bu kimlikle eşleşen bir hesap yok');
  });

  it('hides the password form behind the emergency link when password sign-in is off', async () => {
    const m = identityMockState(db());
    m.policy.password.localLogin = false;
    m.providers = m.providers.filter((p) => p.kind !== 'ldap');
    renderApp('/login');
    const user = userEvent.setup();
    expect(
      await screen.findByRole('button', { name: 'Keycloak ile giriş yap' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Şifre')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Acil durum girişi (kurum sahibi)' }));
    expect(screen.getByLabelText('Şifre')).toBeInTheDocument();
  });
});

describe('Yönetim › Güvenlik (9.11)', () => {
  it('asks for the password before saving the policy', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/security');
    const user = userEvent.setup();
    expect(await screen.findByText(/üye kurdu/)).toBeInTheDocument();
    expect(screen.getByText("IP'n listede")).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Sızıntı listesi kontrolü' }));
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Kimliğini doğrula' });
    // The owner has a passkey, so it comes first; the password is the fallback.
    await user.click(within(dialog).getByRole('button', { name: 'Şifreyle doğrula' }));
    await user.type(within(dialog).getByLabelText('Şifre'), MOCK_PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: 'Şifreyle doğrula' }));
    await waitFor(() => expect(identityMockState(db()).policy.password.breachCheck).toBe(false));
  });
});

describe('Yönetim › SSO uygulamaları (9.12, 9.13)', () => {
  it('lists apps and shows a new client secret once', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/sso');
    const user = userEvent.setup();
    expect((await screen.findAllByText('Operasyon Paneli')).length).toBeGreaterThan(0);
    expect(screen.getByText('Secret 12 günde doluyor')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Uygulama ekle' }));
    const dialog = await screen.findByRole('dialog', { name: 'Yeni SSO uygulaması' });
    await user.type(within(dialog).getByLabelText('Ad'), 'Zamanlayıcı');
    await user.click(within(dialog).getByRole('textbox', { name: "Redirect URI'ler" }));
    await user.paste('https://scheduler.example.io/signin-oidc');
    await user.keyboard('{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Oluştur' }));
    const created = await screen.findByRole('dialog', { name: 'Zamanlayıcı' });
    expect(within(created).getByText(/yalnız şimdi gösteriliyor/)).toBeInTheDocument();
    const secret = identityMockState(db()).oidc.clients.find(
      (c) => c.name === 'Zamanlayıcı',
    )!.secret!;
    expect(within(created).getByText('zamanlayici')).toBeInTheDocument();
    await user.click(within(created).getByRole('button', { name: 'Göster' }));
    expect(within(created).getByText(secret)).toBeInTheDocument();
    await user.click(within(created).getByRole('button', { name: 'Kopyaladım, kapat' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }, 15_000);
});

describe('Yönetim › Entegrasyonlar (9.14)', () => {
  it('shows provider cards and tests a directory user', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/integrations');
    const user = userEvent.setup();
    expect(await screen.findByText('Keycloak')).toBeInTheDocument();
    expect(screen.getByText('SSO zorunlu')).toBeInTheDocument();
    const ad = screen.getByText('Active Directory').closest('section')!;
    await user.click(within(ad).getByRole('link', { name: 'Ayarlar' }));
    expect(await screen.findByRole('heading', { name: 'Active Directory' })).toBeInTheDocument();
    expect(screen.getByText('Kayıtlı')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Kullanıcı adı (isteğe bağlı)'), 'elif');
    await user.click(screen.getAllByRole('button', { name: 'Bağlantıyı test et' })[0]!);
    expect(await screen.findByText('Bağlantı başarılı')).toBeInTheDocument();
    expect(screen.getAllByText('Elif Yıldız').length).toBeGreaterThan(1);
    expect(screen.getByText('Servis hesabıyla oturum')).toBeInTheDocument();
  });

  it('creates an OpenLDAP connection from its preset', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/admin/integrations/identity/new?preset=openldap');
    const user = userEvent.setup();
    expect(await screen.findByDisplayValue(/inetOrgPerson/)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Sunucu adresi'));
    await user.paste('ldaps://ldap.example.com:636');
    await user.click(screen.getByLabelText('Arama kökü (base DN)'));
    await user.paste('ou=people,dc=example,dc=com');
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(
        /^\/admin\/integrations\/identity\/[0-9a-f-]{36}$/,
      ),
    );
    const saved = identityMockState(db()).providers.find((p) => p.preset === 'openldap')!;
    expect(saved.config).toMatchObject({ uidAttribute: 'entryUUID', useMemberOf: false });
  });
});

describe('OIDC consent (/sso/consent)', () => {
  it('shows the app, the person and the requested scopes', async () => {
    signedInAs(USER.bugra);
    const q = new URLSearchParams({
      client_id: 'helpdesk',
      redirect_uri: 'https://helpdesk.example.io/auth/callback',
      response_type: 'code',
      scope: 'openid profile email',
      state: 'xyz',
    });
    renderApp(`/sso/consent?${q}`);
    expect(
      await screen.findByRole('heading', {
        name: /Destek Masası, Milvasoft hesabınla giriş yapmak istiyor/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('helpdesk.example.io')).toBeInTheDocument();
    expect(screen.getByText('E-posta adresi')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'İzin ver' })).toBeEnabled();
  });

  it('refuses an unknown redirect URI', async () => {
    signedInAs(USER.bugra);
    const q = new URLSearchParams({
      client_id: 'helpdesk',
      redirect_uri: 'https://evil.example.net/cb',
      response_type: 'code',
      scope: 'openid',
    });
    renderApp(`/sso/consent?${q}`);
    expect(
      await screen.findByRole('heading', { name: 'Giriş isteği geçersiz' }),
    ).toBeInTheDocument();
  });

  it('sends a signed-out visitor to the login with a way back', async () => {
    const q = new URLSearchParams({
      client_id: 'helpdesk',
      redirect_uri: 'https://helpdesk.example.io/auth/callback',
      response_type: 'code',
      scope: 'openid',
    });
    const { router } = renderApp(`/sso/consent?${q}`);
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(String(router.state.location.search.redirect)).toContain('/sso/consent?');
  });
});
