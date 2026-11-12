import { expect, test } from '@playwright/test';
import { signIn, stamp } from './support';

test('create a personal access token, see it once, then revoke it', async ({ page }) => {
  await signIn(page);
  const name = stamp('Duman token');
  await page.goto('/account/mcp');
  await expect(page.getByRole('heading', { level: 1, name: 'MCP ve API' })).toBeVisible();

  await page.getByRole('button', { name: 'Token oluştur' }).click();
  const dialog = page.getByRole('dialog', { name: "1 / 2 · Kişisel erişim token'ı" });
  await dialog.getByLabel('Ad', { exact: true }).fill(name);
  await dialog.getByRole('checkbox', { name: 'Drive yaz' }).check();
  await dialog.getByRole('button', { name: 'Oluştur' }).click();

  const done = page.getByRole('dialog', { name: '2 / 2 · Token oluşturuldu' });
  await expect(done.getByText(/^mhp_[A-Za-z0-9]{40}$/)).toBeVisible();
  await done.getByRole('button', { name: 'Kopyaladım, kapat' }).click();

  // Listed without its value; revoke it again.
  const row = page.getByRole('listitem').filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(page.getByText(/^mhp_[A-Za-z0-9]{40}$/)).toHaveCount(0);
  await row.getByRole('button', { name: 'İptal et' }).click();
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  if (await confirm.isVisible().catch(() => false)) {
    await confirm
      .getByRole('button', { name: /İptal et/ })
      .last()
      .click();
  }
  await expect(row).toHaveCount(0);
});
