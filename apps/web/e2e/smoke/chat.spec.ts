import { expect, test } from '@playwright/test';
import { BUGRA, ELIF, REAL, secondSession, signIn, stamp } from './support';

/**
 * Real mode: Buğra and Elif in two isolated browser sessions; Elif's message reaches Buğra live
 * and Buğra's read receipt reaches Elif. Mock mode: one session (each browser has its own mock),
 * the mock's simulated colleague answers over the mocked socket.
 */
test('send a message and receive one live', async ({ page, browser }) => {
  await signIn(page, BUGRA);
  const text = stamp('Duman mesajı');

  if (!REAL) {
    await page.goto('/chat');
    await page.getByRole('link', { name: /Mert Aydın/ }).click();
    const box = page.getByRole('textbox', { name: 'Mert Aydın sohbetine mesaj yaz' });
    await box.fill(text);
    await box.press('Enter');
    await expect(page.getByRole('log').getByText(text)).toBeVisible();
    // Typing, then the simulated reply arrives through the socket.
    await expect(page.getByText('Mert yazıyor…').first()).toBeVisible();
    const before = await page.locator('[data-seq]').count();
    await expect
      .poll(() => page.locator('[data-seq]').count(), { timeout: 10_000 })
      .toBeGreaterThan(before);
    return;
  }

  // Buğra opens the direct chat with Elif.
  await page.goto('/chat');
  await page.getByRole('link', { name: /Elif Yıldız/ }).click();
  const log = page.getByRole('log');
  await expect(log).toBeVisible();

  const elif = await secondSession(browser, page, ELIF);
  // Same direct chat on Elif's side: its address is the same for both people.
  await elif.page.goto(new URL(page.url()).pathname);
  const box = elif.page.getByRole('textbox', { name: /sohbetine mesaj yaz/ });
  await box.fill(text);
  await box.press('Enter');

  // Live delivery to Buğra, and Buğra's read shows as "Görüldü" for Elif.
  await expect(log.getByText(text)).toBeVisible({ timeout: 5_000 });
  await expect(elif.page.getByText(/^Görüldü/)).toBeVisible({ timeout: 10_000 });

  // And back: Buğra answers.
  const reply = `${text} · yanıt`;
  const mine = page.getByRole('textbox', { name: /sohbetine mesaj yaz/ });
  await mine.fill(reply);
  await mine.press('Enter');
  await expect(elif.page.getByRole('log').getByText(reply)).toBeVisible({ timeout: 5_000 });
  await elif.context.close();
});
