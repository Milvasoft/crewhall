import { expect, test } from '@playwright/test';
import { SPACE, signIn, stamp } from './support';

// 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('upload a file, preview it and move it to the trash', async ({ page }) => {
  await signIn(page);
  const name = `${stamp('duman').replace(' ', '-')}.png`;
  await page.goto(`/drive/${SPACE}`);
  const list = page.getByRole('table', { name: 'Klasör içeriği' });
  await expect(list).toBeVisible();

  await page
    .getByTestId('drive-file-input')
    .setInputFiles({ name, mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('region', { name: 'Yüklemeler' }).getByText(name)).toBeVisible();
  const row = list.getByRole('row', { name });
  await expect(row).toBeVisible();

  await row.dblclick();
  const viewer = page.getByRole('dialog', { name: `${name} önizlemesi` });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('img', { name })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();

  // Cleanup: trash (restorable for 30 days).
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Çöp kutusuna taşı' }).click();
  await expect(row).toHaveCount(0);
});
