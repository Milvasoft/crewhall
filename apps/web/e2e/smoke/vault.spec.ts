import { expect, test } from '@playwright/test';
import { signIn, stamp } from './support';

/** Vault password used for set-up (and to unlock when a real account is already set up). */
const VAULT_PASSWORD = process.env.E2E_VAULT_PASSWORD ?? 'Zeytin-Pusula-Kuzgun-Fener-73';

test('set up the vault (or unlock it), add a login and lock it', async ({ page }) => {
  await signIn(page);
  await page.goto('/vault');
  const setup = page.getByRole('heading', { name: 'Kasa şifreni oluştur' });
  const locked = page.getByRole('heading', { name: 'Kasa kilitli' });
  await expect(setup.or(locked)).toBeVisible();

  if (await setup.isVisible()) {
    await page.getByLabel('Kasa şifresi', { exact: true }).fill(VAULT_PASSWORD);
    await page.getByLabel('Kasa şifresi tekrar').fill(VAULT_PASSWORD);
    const next = page.getByRole('button', { name: 'Devam et' });
    await expect(next).toBeEnabled({ timeout: 15_000 });
    await next.click();
    await expect(page.getByRole('heading', { name: 'Kurtarma anahtarını sakla' })).toBeVisible();
    await expect(page.getByLabel('Kurtarma anahtarı', { exact: true })).toBeVisible();
    await page
      .getByRole('checkbox', { name: 'Kurtarma anahtarımı güvenli bir yere kaydettim' })
      .check();
    await page.getByRole('button', { name: 'Kasayı aç' }).click();
  } else {
    await page.getByLabel('Kasa şifresi').fill(VAULT_PASSWORD);
    await page.getByRole('button', { name: 'Kilidi aç' }).click();
  }
  await expect(page).toHaveURL(/\/vault\/[^/]+\/[^/]+/);

  // A login item: encrypted in the browser, listed by name.
  const name = stamp('Duman girişi');
  await page.getByRole('button', { name: 'Yeni öğe' }).first().click();
  await page.getByRole('button', { name: /^Giriş/ }).click();
  await page.getByLabel('Ad', { exact: true }).fill(name);
  await page.getByLabel('Kullanıcı adı', { exact: true }).fill('duman@milvasoft.com');
  await page.getByLabel('Şifre', { exact: true }).fill('Sadece-test-icin-42');
  await page.getByRole('button', { name: /^Kaydet/ }).click();
  const items = page.getByRole('region', { name: 'Öğeler' });
  await expect(items.getByRole('button', { name: new RegExp(name) })).toBeVisible();

  // Lock: back to the lock screen; nothing decrypted stays on the page.
  await page.getByRole('button', { name: 'Kilitle', exact: true }).click();
  await expect(locked).toBeVisible();
  await expect(page.getByText(name)).toHaveCount(0);
});
