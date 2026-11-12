import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

/** Content scripts cannot be modules: this one is built apart, as a single classic script. */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: false,
    target: 'chrome127',
    lib: {
      entry: fileURLToPath(new URL('./src/content/capture.ts', import.meta.url)),
      formats: ['iife'],
      name: 'crewhallCapture',
      fileName: () => 'capture.js',
    },
  },
});
