import fs from 'node:fs';
import { chromium, type FullConfig } from '@playwright/test';
import { BUGRA, ELIF, signInWithForm, stateFile } from './support';

/**
 * Real mode: sign Buğra and Elif in once and keep their sessions for every smoke test. A saved
 * session that still works is reused (each sign-in spends a TOTP code and counts toward the
 * api's 2FA rate limit).
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  const browser = await chromium.launch();
  for (const who of [BUGRA, ELIF]) {
    const saved = fs.existsSync(stateFile(who)) ? stateFile(who) : undefined;
    const context = await browser.newContext({ baseURL, locale: 'tr-TR', storageState: saved });
    const page = await context.newPage();
    // Through the browser: Node cannot resolve `<name>.localhost` hosts.
    let valid = false;
    if (saved) {
      await page.goto('/login');
      valid = await page.evaluate(async () => (await fetch('/api/v1/me')).ok);
    }
    if (!valid) await signInWithForm(page, who);
    await context.storageState({ path: stateFile(who) });
    await context.close();
  }
  await browser.close();
}
