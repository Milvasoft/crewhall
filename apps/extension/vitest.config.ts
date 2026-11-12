import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    testTimeout: 30_000,
    include: ['test/**/*.test.{ts,tsx}'],
    fsModuleCachePath: fileURLToPath(new URL('./node_modules/.vitest-cache', import.meta.url)),
  },
});
