import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Sync tests write real files; parallel turbo runs make a disk slow.
    testTimeout: 30_000,
    // Own module cache: the shared one under the workspace root races in parallel turbo runs.
    fsModuleCachePath: fileURLToPath(new URL('./node_modules/.vitest-cache', import.meta.url)),
  },
});
