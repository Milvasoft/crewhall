import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    css: false,
    // Whole-app renders (guards, mocks, the chat socket) run slow when several sessions share
    // the machine; 5 s timed out at random under load.
    testTimeout: 15_000,
    // Own Vitest module cache: the default <workspace root>/node_modules/.vitest-cache is shared by
    // every package and parallel turbo runs race on it (ENOTEMPTY).
    fsModuleCachePath: fileURLToPath(new URL('./node_modules/.vitest-cache', import.meta.url)),
  },
});
