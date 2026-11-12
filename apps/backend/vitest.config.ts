import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One Postgres container (Testcontainers) for the whole run; see test/global-setup.ts.
    globalSetup: ['./test/global-setup.ts'],
    // Generous: other worktrees run their own Testcontainers on the same machine.
    testTimeout: 90_000,
    hookTimeout: 180_000,
    // Test files share the database, so run them one after another.
    fileParallelism: false,
    // Own Vitest module cache: the default <workspace root>/node_modules/.vitest-cache is shared by
    // every package and parallel turbo runs race on it (ENOTEMPTY).
    fsModuleCachePath: fileURLToPath(new URL('./node_modules/.vitest-cache', import.meta.url)),
  },
});
