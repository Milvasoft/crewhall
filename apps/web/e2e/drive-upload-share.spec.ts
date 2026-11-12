import { expect, test } from '@playwright/test';

// Test credentials of the in-browser mock (apps/web/src/mocks/seed.ts, README).
const EMAIL = 'bugra@milvasoft.com';
const PASSWORD = 'crewhall-demo-2026';
const TOTP = '123456';

/** 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('upload a file, preview it and open its public link signed out', async ({ page, browser }) => {
  await page.goto('/login?mock=reset');
  await page.getByLabel('E-posta').fill(EMAIL);
  await page.getByLabel('Şifre', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  await page.getByLabel('6 haneli doğrulama kodu').fill(TOTP);
  await expect(page.getByRole('heading', { level: 1, name: /Ahmet/ })).toBeVisible();

  // Drive › Sunumlar (3.4 → 3.7).
  await page.goto('/drive/milvasoft');
  const list = page.getByRole('table', { name: 'Klasör içeriği' });
  await list.getByText('Sunumlar', { exact: true }).dblclick();
  await expect(page.getByRole('heading', { level: 1, name: 'Sunumlar' })).toBeVisible();

  // Multipart upload through the fake object store; the panel reports it.
  await page.getByTestId('drive-file-input').setInputFiles({
    name: 'yol-haritasi.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  const panel = page.getByRole('region', { name: 'Yüklemeler' });
  await expect(panel.getByText('yol-haritasi.png')).toBeVisible();
  await expect(panel.getByText(/· Sunumlar/)).toBeVisible();
  const row = list.getByRole('row', { name: /yol-haritasi\.png/ });
  await expect(row).toBeVisible();

  // Viewer (3.8).
  await row.dblclick();
  const viewer = page.getByRole('dialog', { name: 'yol-haritasi.png önizlemesi' });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('img', { name: 'yol-haritasi.png' })).toBeVisible();

  // Share dialog (3.11): the public link address is shown once, on creation.
  await viewer.getByRole('button', { name: 'Paylaş…' }).click();
  const share = page.getByRole('dialog', { name: /yol-haritasi\.png.*paylaş/ });
  await share.getByRole('switch', { name: 'Herkese açık link' }).click();
  const address = share.getByText(/\/s\/[\w-]+$/);
  await expect(address).toBeVisible();
  const url = (await address.textContent()) ?? '';

  // Someone without an account opens it (19.1).
  const guest = await browser.newContext({ locale: 'tr-TR' });
  const other = await guest.newPage();
  // Same mock data: the guest's browser gets the signed-in tab's store.
  const store = await page.evaluate(() => localStorage.getItem('crewhall.mock.db'));
  await other.goto('/login');
  await other.evaluate((s) => {
    const db = JSON.parse(s ?? '{}') as { auth: { sessionId: string | null } };
    db.auth.sessionId = null;
    localStorage.setItem('crewhall.mock.db', JSON.stringify(db));
  }, store);
  await other.goto(new URL(url).pathname);
  await expect(other.getByText('yol-haritasi.png').first()).toBeVisible();
  await expect(other.getByRole('button', { name: 'İndir' })).toBeVisible();
  await expect(other.getByText('Linki bilen herkes')).toBeVisible();
  await guest.close();
});
