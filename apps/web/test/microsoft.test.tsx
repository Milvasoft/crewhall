import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Microsoft 365 integrations (sonraki-isler.md): admin wizard, upload link, mounts, add-in pane. */
describe('Yönetim › Entegrasyonlar › Microsoft 365', () => {
  it('is reached from the integrations page', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/integrations');
    const card = await screen.findByRole('region', { name: 'Microsoft 365 entegrasyonları' });
    expect(await within(card).findByText('Hiçbiri açık değil')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Kurulumu aç' })).toHaveAttribute(
      'href',
      '/admin/integrations/microsoft',
    );
  });

  it('saves the app registration, switches Entra on and shows a SCIM token once', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/integrations/microsoft');
    const user = userEvent.setup();
    const app = await screen.findByRole('region', { name: '1. Microsoft uygulama kaydı' });
    await user.type(
      within(app).getByLabelText('Tenant (dizin) kimliği'),
      'contoso.onmicrosoft.com',
    );
    await user.type(
      within(app).getByLabelText('Uygulama (istemci) kimliği'),
      '11111111-2222-4333-8444-555555555555',
    );
    await user.type(within(app).getByLabelText('İstemci gizli anahtarı'), 'gizli-anahtar-1234');
    await user.click(within(app).getByRole('button', { name: 'Kaydı kaydet' }));
    await within(app).findByText('Kayıtlı anahtar …1234');
    await user.click(within(app).getByRole('button', { name: 'Bağlantıyı dene' }));
    expect(await within(app).findByRole('status')).toHaveTextContent('Sites.ReadWrite.All');

    const entra = screen.getByRole('region', { name: 'Entra ID: giriş ve kullanıcı açma (SCIM)' });
    await user.click(within(entra).getByRole('switch'));
    await waitFor(() => expect(within(entra).getByRole('switch')).toBeChecked());
    await user.click(within(entra).getByRole('button', { name: 'SCIM anahtarı oluştur' }));
    expect(
      await within(entra).findByText("Bu anahtar yalnız şimdi gösterilir. Entra'ya yapıştır."),
    ).toBeInTheDocument();
    expect(within(entra).getByText(/Entra ID · …/)).toBeInTheDocument();
  }, 60_000);

  it('keeps Teams off until the bot id is given', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/integrations/microsoft');
    const user = userEvent.setup();
    const teams = await screen.findByRole('region', { name: 'Teams uygulaması' });
    expect(within(teams).getByRole('switch')).toBeDisabled();
    await user.type(
      within(teams).getByLabelText('Botun Microsoft App ID değeri'),
      '3c5e0f2a-1111-4c4c-8d8d-0123456789ab',
    );
    await user.click(within(teams).getByRole('button', { name: 'Kaydı kaydet' }));
    await waitFor(() => expect(within(teams).getByRole('switch')).toBeChecked());
    expect(within(teams).getByRole('link', { name: 'Uygulama paketini indir' })).toHaveAttribute(
      'href',
      expect.stringContaining('/api/integrations/teams/app.zip'),
    );
  });

  it('mounts a SharePoint library that space members then browse in Drive', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/integrations/microsoft');
    const user = userEvent.setup();
    const storage = await screen.findByRole('region', {
      name: 'Dış depolama: SharePoint, OneDrive ve SMB',
    });
    await user.click(
      within(storage).getByRole('switch', {
        name: 'Dış depolama: SharePoint, OneDrive ve SMB: Açık',
      }),
    );
    await waitFor(() =>
      expect(
        within(storage).getByRole('switch', {
          name: 'Dış depolama: SharePoint, OneDrive ve SMB: Açık',
        }),
      ).toBeChecked(),
    );
    const form = within(storage).getByRole('form', { name: 'Bağlantı ekle' });
    await user.type(within(form).getByLabelText('Görünen ad'), 'Finans raporları');
    await user.type(
      within(form).getByLabelText('Site adresi'),
      'https://contoso.sharepoint.com/sites/Finans',
    );
    const space = db().spaces.find((s) => s.kind === 'shared')!;
    await user.click(within(form).getByRole('combobox', { name: 'Alan' }));
    await user.click(await screen.findByRole('option', { name: space.name }));
    await user.click(within(form).getByRole('button', { name: 'Bağla' }));
    expect(
      await within(storage).findByText(`Finans raporları · ${space.name}`),
    ).toBeInTheDocument();

    renderApp(`/drive/${space.slug}`);
    await user.click(await screen.findByRole('link', { name: 'Finans raporları' }));
    expect(await screen.findByText('ozet.pdf')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'İndir: ozet.pdf' })).toHaveAttribute(
      'href',
      expect.stringContaining('/download?path=ozet.pdf'),
    );
  }, 60_000);
});

describe('public upload link', () => {
  it("uploads a file into the asking person's folder", async () => {
    renderApp('/u/demo');
    const user = userEvent.setup();
    expect(
      await screen.findByRole('heading', { name: 'Ahmet Buğra Kösen dosya istiyor' }),
    ).toBeInTheDocument();
    await user.upload(
      screen.getByLabelText('Dosya seç'),
      new File(['teklif'], 'teklif.pdf', { type: 'application/pdf' }),
    );
    await user.click(screen.getByRole('button', { name: 'Yükle' }));
    expect(await screen.findByText('teklif.pdf yüklendi')).toBeInTheDocument();
  });

  it('says when a link is closed', async () => {
    renderApp('/u/eski');
    expect(
      await screen.findByRole('heading', { name: 'Bu yükleme linki kapalı' }),
    ).toBeInTheDocument();
  });
});

describe('Outlook task pane', () => {
  it('explains itself outside Outlook', async () => {
    // jsdom: the Office.js script never loads.
    renderApp('/office/outlook?mode=read&client=crewhall-outlook-x');
    expect(
      await screen.findByText(
        "Bu sayfa Outlook içinde açılır. Eklentiyi Outlook'tan başlat.",
        {},
        { timeout: 8000 },
      ),
    ).toBeInTheDocument();
  });
});
