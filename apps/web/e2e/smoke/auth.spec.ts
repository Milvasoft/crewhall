import { expect, test } from '@playwright/test';
import { BUGRA, signInWithForm } from './support';

// These check the sign-in itself: start signed out even when real mode saved a session.
test.use({ storageState: { cookies: [], origins: [] } });

test('sign in with password and TOTP, reach the shell, sign out', async ({ page }) => {
  await signInWithForm(page, BUGRA);
  await expect(page.getByRole('navigation', { name: 'Modüller' })).toBeVisible();
  await page.getByRole('button', { name: 'Hesap menüsü' }).click();
  await page.getByRole('menuitem', { name: 'Çıkış yap' }).click();
  await expect(page.getByRole('heading', { name: 'Giriş yap' })).toBeVisible();
  // The guard keeps the app closed once signed out.
  await page.goto('/drive');
  await expect(page).toHaveURL(/\/login/);
});

test('a wrong password is refused without leaving the form', async ({ page }) => {
  await page.goto('/login');
  // An address of its own: failed attempts on a real account would lock it after five runs.
  await page.getByLabel('E-posta').fill(`duman-${Date.now()}@milvasoft.com`);
  await page.getByLabel('Şifre', { exact: true }).fill('yanlis-sifre-1234');
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
