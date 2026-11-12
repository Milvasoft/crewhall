import { expect, test } from '@playwright/test';

// Test credentials of the in-browser mock (apps/web/src/mocks/seed.ts, README).
const EMAIL = 'bugra@milvasoft.com';
const PASSWORD = 'crewhall-demo-2026';
const TOTP = '123456';

test('sign in, pass 2FA and create a space', async ({ page }) => {
  await page.goto('/?mock=reset');

  // Signed out: the guard sends us to /login with the tenant brand.
  await expect(page.getByRole('heading', { name: 'Giriş yap' })).toBeVisible();
  await expect(page.getByText('Milvasoft hesabınla devam et.')).toBeVisible();

  await page.getByLabel('E-posta').fill(EMAIL);
  await page.getByLabel('Şifre', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();

  // Second step: the six boxes behave as one field and submit on the last digit.
  await expect(page.getByRole('heading', { name: 'Doğrulama kodu' })).toBeVisible();
  await expect(page).toHaveURL(/\/login\/2fa/);
  await page.getByLabel('6 haneli doğrulama kodu').fill(TOTP);

  // Home (quick access empty state) inside the shell.
  await expect(page.getByRole('heading', { level: 1, name: /Ahmet/ })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Modüller' })).toBeVisible();

  // Ctrl K palette: "Yeni space oluştur" command opens the dialog.
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Komut paleti' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill('>yeni');
  await palette.getByRole('option', { name: /Yeni space oluştur/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Yeni space' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Ad').fill('Mobil');
  await dialog.getByRole('radio', { name: 'Mor' }).click();
  await dialog.getByLabel('Kişi ya da e-posta ekle').fill('sel');
  await dialog.getByRole('button', { name: /Selin Öztürk/ }).click();
  await dialog.getByRole('button', { name: 'Space oluştur' }).click();

  // Lands on the new space's settings with both members.
  await expect(page).toHaveURL(/\/spaces\/mobil\/settings$/);
  await expect(page.getByRole('heading', { name: 'Space ayarları' })).toBeVisible();
  await expect(page.getByText('selin@milvasoft.com')).toBeVisible();

  // The selector lists it with the owner role.
  await page.getByRole('button', { name: 'Space seç' }).click();
  await expect(page.getByRole('option', { name: /Mobil.*2 üye · Sahip/ })).toBeVisible();
});

test('english and dark theme on the sign-in page', async ({ page }) => {
  await page.goto('/login?mock=reset');
  await page.getByRole('button', { name: 'Dil' }).click();
  await page.getByRole('menuitem', { name: 'English' }).click();
  await page
    .getByRole('radio', { name: 'Koyu' })
    .or(page.getByRole('radio', { name: 'Dark' }))
    .click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
