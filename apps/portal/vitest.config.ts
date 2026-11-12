import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    css: false,
    // Vitest 5 keeps transformed modules in <workspace root>/node_modules/.vitest-cache by default,
    // shared by every package; parallel turbo runs then race on it (ENOTEMPTY). Keep our own.
    fsModuleCachePath: fileURLToPath(new URL('./node_modules/.vitest-cache', import.meta.url)),
  },
});
