import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    // Own Vitest module cache: the default <workspace root>/node_modules/.vitest-cache is shared by
    // every package and parallel turbo runs race on it (ENOTEMPTY).
    fsModuleCachePath: fileURLToPath(new URL('./node_modules/.vitest-cache', import.meta.url)),
  },
});
