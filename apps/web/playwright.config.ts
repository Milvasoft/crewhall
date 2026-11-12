import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 5199);
/** Set to run against a real api through an already running web dev server (smoke suite only). */
const REAL_URL = process.env.E2E_BASE_URL;

/**
 * End-to-end flows against the in-browser MSW mock (no backend needed).
 * The dev server runs in mock mode on its own port so it never clashes with `pnpm dev`.
 * With E2E_BASE_URL only e2e/smoke runs, against that server (see e2e/smoke/support.ts).
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: REAL_URL ? 'smoke/**/*.spec.ts' : '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // One browser at a time against a real api: shared accounts, single-use TOTP codes.
  workers: REAL_URL ? 1 : undefined,
  globalSetup: REAL_URL ? './e2e/smoke/global-setup.ts' : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: REAL_URL ?? `http://localhost:${PORT}`,
    storageState: REAL_URL ? 'e2e/.auth/bugra.json' : undefined,
    locale: 'tr-TR',
    viewport: { width: 1280, height: 820 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 820 } },
    },
  ],
  webServer: REAL_URL
    ? undefined
    : {
        command: 'node node_modules/vite/bin/vite.js --mode mock',
        env: { PORT: String(PORT) },
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
