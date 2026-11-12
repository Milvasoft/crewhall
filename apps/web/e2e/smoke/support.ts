import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Smoke suite helpers. Two modes:
 * - mock (default): the in-browser MSW mock started by playwright.config (no backend).
 * - real: E2E_BASE_URL=http://chat.localhost:4411 (a web dev server proxying to a real api).
 *   Accounts are the dev seed's (docs/contracts/backend-calistirma.md); TOTP codes are computed
 *   from E2E_TOTP_SECRET (the seed's shared dev secret by default).
 */
export const REAL = Boolean(process.env.E2E_BASE_URL);

export interface Account {
  email: string;
  name: RegExp;
  password: string;
}

const MOCK_PASSWORD = 'crewhall-demo-2026';
const SEED_PASSWORD = process.env.E2E_PASSWORD ?? 'Crewhall-dev-2026';
const SEED_TOTP_SECRET = process.env.E2E_TOTP_SECRET ?? 'CrewhallDevTotpSecret0123456789X';

export const BUGRA: Account = {
  email: process.env.E2E_EMAIL ?? 'bugra@milvasoft.com',
  name: /Ahmet/,
  password: REAL ? SEED_PASSWORD : MOCK_PASSWORD,
};
export const ELIF: Account = {
  email: process.env.E2E_EMAIL_2 ?? 'elif@milvasoft.com',
  name: /Elif/,
  password: REAL ? SEED_PASSWORD : MOCK_PASSWORD,
};

/** Saved sessions for real mode (global-setup.ts signs in once; TOTP codes are single use). */
export const AUTH_DIR = path.join(import.meta.dirname, '..', '.auth');
export const stateFile = (who: Account) => path.join(AUTH_DIR, `${who.email.split('@')[0]}.json`);
const USED = path.join(AUTH_DIR, 'used-totp.txt');

/** Shared space used by the Drive and quick access checks. */
export const SPACE = process.env.E2E_SPACE ?? 'milvasoft';

/** RFC 6238 (SHA-1, 6 digits, 30 s) over the raw secret, as better-auth's createOTP does. */
export function totp(secret = SEED_TOTP_SECRET, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const o = (h[h.length - 1] ?? 0) & 0xf;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

/** A unique, recognizable name for data the run creates (and removes again). */
export function stamp(prefix: string): string {
  return `${prefix} ${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
}

/**
 * A TOTP code that has not been used yet: the server takes each code once, so a second
 * sign-in inside the same 30 s window waits for the next one (also across test files).
 */
async function freshCode(page: Page): Promise<string> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  for (;;) {
    const used = fs.existsSync(USED) ? fs.readFileSync(USED, 'utf8').split(',') : [];
    const left = 30_000 - (Date.now() % 30_000);
    const code = totp();
    if (!used.includes(code) && left > 4_000) {
      fs.writeFileSync(USED, [...used.slice(-20), code].join(','));
      return code;
    }
    await page.waitForTimeout(left + 500);
  }
}

/**
 * Lands signed in on the home surface. Mock: through the sign-in form with the mock's fixed
 * code. Real: the page already carries Buğra's saved session; other accounts sign in.
 */
export async function signIn(page: Page, who: Account = BUGRA): Promise<void> {
  if (REAL) {
    await page.goto('/');
    // Either the saved session lands on home, or the guard sends us to the sign-in form.
    const home = page.getByRole('heading', { level: 1, name: who.name });
    const login = page.getByRole('heading', { name: 'Giriş yap' });
    await expect(home.or(login)).toBeVisible({ timeout: 30_000 });
    if (await home.isVisible()) return;
  }
  await signInWithForm(page, who);
}

/** The full sign-in form with the second step (TOTP). */
export async function signInWithForm(page: Page, who: Account = BUGRA): Promise<void> {
  await page.goto(REAL ? '/login' : '/login?mock=reset');
  await page.getByLabel('E-posta').fill(who.email);
  await page.getByLabel('Şifre', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Doğrulama kodu' })).toBeVisible();
  await page.getByLabel('6 haneli doğrulama kodu').fill(REAL ? await freshCode(page) : '123456');
  await expect(page.getByRole('heading', { level: 1, name: who.name })).toBeVisible();
}

/**
 * A second, isolated browser session (own cookies). In mock mode it gets a copy of the first
 * tab's mock database so both see the same org.
 */
export async function secondSession(
  browser: Browser,
  from: Page,
  who: Account,
): Promise<{ context: BrowserContext; page: Page }> {
  const saved = REAL && fs.existsSync(stateFile(who)) ? stateFile(who) : undefined;
  const context = await browser.newContext({
    locale: 'tr-TR',
    viewport: { width: 1280, height: 820 },
    storageState: saved,
  });
  const page = await context.newPage();
  if (!REAL) {
    const store = await from.evaluate(() => localStorage.getItem('crewhall.mock.db'));
    await page.goto('/login');
    await page.evaluate((s) => {
      const db = JSON.parse(s ?? '{}') as { auth: { sessionId: string | null } };
      db.auth.sessionId = null;
      localStorage.setItem('crewhall.mock.db', JSON.stringify(db));
    }, store);
    await page.goto('/login');
    await page.getByLabel('E-posta').fill(who.email);
    await page.getByLabel('Şifre', { exact: true }).fill(who.password);
    await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
    await page.getByLabel('6 haneli doğrulama kodu').fill('123456');
    await expect(page.getByRole('heading', { level: 1, name: who.name })).toBeVisible();
  } else {
    await signIn(page, who);
  }
  return { context, page };
}
