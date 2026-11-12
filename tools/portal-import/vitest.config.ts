import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 240_000,
    // The import test runs against the backend's real Postgres + S3 (Testcontainers).
    globalSetup: ['../../apps/backend/test/global-setup.ts'],
    fileParallelism: false,
    // Own module cache: the default <workspace root>/node_modules/.vitest-cache is shared by every
    // package and parallel turbo runs race on it (ENOTEMPTY).
    fsModuleCachePath: fileURLToPath(new URL('./node_modules/.vitest-cache', import.meta.url)),
  },
});
