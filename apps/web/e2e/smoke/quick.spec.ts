import { expect, test } from '@playwright/test';
import { signIn, stamp } from './support';

test('add a link card to my surface and remove it again', async ({ page }) => {
  await signIn(page);
  const title = stamp('Duman testi');
  await page.getByRole('button', { name: 'Kart ekle' }).click();
  const gallery = page.getByRole('complementary', { name: 'Kart ekle' });
  await gallery.getByRole('button', { name: /^Link\s*Tek site/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Link ekle' });
  await dialog.getByLabel('Adres').fill('https://example.com');
  await dialog.getByLabel('Görünen ad').fill(title);
  await dialog.getByRole('button', { name: 'Ekle' }).click();
  const card = page.getByRole('article', { name: title });
  await expect(card).toBeVisible();

  // Cleanup through the card menu (right click).
  await card.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Kaldır' }).click();
  await expect(card).toHaveCount(0);
});
