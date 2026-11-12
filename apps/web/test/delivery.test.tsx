import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDeliveryMock } from '@/mocks/delivery';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'crewhall-test',
  client_email: 'push@crewhall-test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
});

async function openPage() {
  signedInAs(USER.bugra);
  renderApp('/admin/delivery');
  const user = userEvent.setup();
  const email = await screen.findByRole('radiogroup', { name: 'E-posta' });
  return { user, email };
}

const save = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(
    within(screen.getByRole('region', { name: /kaydedilmemiş/i })).getByRole('button', {
      name: 'Kaydet',
    }),
  );

describe('Yönetim › Bildirim gönderimi', () => {
  beforeEach(() => {
    resetDeliveryMock();
  });

  it('switches e-mail to own SMTP; a missing field comes back on that field (422)', async () => {
    const { user, email } = await openPage();
    expect(within(email).getByRole('radio', { name: /Sunucu varsayılanı/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(within(email).getByRole('radio', { name: /Kendi SMTP sunucum/ }));
    // The sender hint shows the angle brackets (escaped in the message).
    expect(screen.getByText(/Crewhall <bildirim@ornek\.com>/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Sunucu'), 'smtp.ornek.com');
    await save(user);
    // Port and sender are missing: the server names the field, the page marks it.
    expect(await screen.findByText('Bu gönderim yolu için gerekli.')).toBeInTheDocument();
    expect(screen.getByLabelText('Port')).toHaveAttribute('aria-invalid', 'true');

    await user.type(screen.getByLabelText('Port'), '587');
    await user.type(screen.getByLabelText('Gönderen'), 'Crewhall <bildirim@ornek.com>');
    await user.type(screen.getByLabelText('Şifre'), 'gizli-sifre');
    await save(user);
    expect(await screen.findByText(/Kayıtlı/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /kaydedilmemiş/i })).toBeNull();
  });

  it('keeps, replaces and removes a stored secret', async () => {
    const { user, email } = await openPage();
    await user.click(within(email).getByRole('radio', { name: /Kendi SMTP sunucum/ }));
    await user.type(screen.getByLabelText('Sunucu'), 'smtp.ornek.com');
    await user.type(screen.getByLabelText('Port'), '465');
    await user.type(screen.getByLabelText('Gönderen'), 'bildirim@ornek.com');
    await user.type(screen.getByLabelText('Şifre'), 'ilk-sifre');
    await save(user);
    await screen.findByText(/Kayıtlı/);

    // Keep: nothing pending while the stored value is untouched.
    expect(screen.queryByRole('region', { name: /kaydedilmemiş/i })).toBeNull();
    // Replace, then change one's mind: empty again keeps it.
    await user.click(screen.getByRole('button', { name: 'Şifre: değiştir' }));
    await user.type(screen.getByLabelText('Şifre'), 'yeni-sifre');
    expect(screen.getByRole('region', { name: /Kaydedilmemiş 1/ })).toBeInTheDocument();
    await save(user);
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /kaydedilmemiş/i })).toBeNull(),
    );
    // Remove.
    await user.click(screen.getByRole('button', { name: 'Şifre: kaldır' }));
    expect(screen.getByText('Kaydedince kaldırılacak.')).toBeInTheDocument();
    await save(user);
    await waitFor(() => expect(screen.getByLabelText('Şifre')).toHaveValue(''));
    expect(screen.queryByText('Kaydedince kaldırılacak.')).toBeNull();
  });

  it('sends a test e-mail and shows the result', async () => {
    const { user } = await openPage();
    await user.click(screen.getByRole('button', { name: 'Test e-postası gönder' }));
    const result = await screen.findByRole('status', { name: 'Test sonucu' });
    expect(result).toHaveTextContent('Gönderildi (1 alıcı)');
    expect(result).toHaveTextContent('Sunucu varsayılanı');
  });

  it('push test without a device asks to sign in on the phone first', async () => {
    const { user } = await openPage();
    await user.click(screen.getByRole('button', { name: 'Test bildirimi gönder' }));
    const result = await screen.findByRole('status', { name: 'Test sonucu' });
    expect(result).toHaveTextContent('Gönderilemedi');
    expect(result).toHaveTextContent(/Önce mobil uygulamada oturum aç/);
  });

  it('direct push stores the Firebase service account and shows its project', async () => {
    const { user } = await openPage();
    const push = screen.getByRole('radiogroup', { name: 'Mobil bildirim' });
    await user.click(within(push).getByRole('radio', { name: /Doğrudan/ }));
    await user.click(screen.getByLabelText('Firebase hizmet hesabı (JSON)'));
    await user.paste('{"type":"service_account"}');
    await save(user);
    expect(await screen.findByText(/Geçerli bir Firebase hizmet hesabı değil/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Firebase hizmet hesabı (JSON)'));
    await user.click(screen.getByLabelText('Firebase hizmet hesabı (JSON)'));
    await user.paste(SERVICE_ACCOUNT);
    await save(user);
    expect(await screen.findByText(/proje crewhall-test/)).toBeInTheDocument();
  });

  it('shows the Notifike section only for Notifike and warns when its key was refused', async () => {
    resetDeliveryMock({ notifikeRejects: true, hasDevice: true });
    const { user, email } = await openPage();
    expect(screen.queryByRole('heading', { name: 'Notifike' })).toBeNull();
    await user.click(within(email).getByRole('radio', { name: /Notifike/ }));
    expect(screen.getByRole('heading', { name: 'Notifike' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Adres'), 'https://api.notifike.com');
    await user.type(screen.getByLabelText('API anahtarı'), 'nk_live_1234abcd');
    await save(user);
    expect(await screen.findByText(/•••• abcd/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Test e-postası gönder' }));
    expect(await screen.findByText(/Notifike anahtarı reddedildi/)).toBeInTheDocument();
  });
});
