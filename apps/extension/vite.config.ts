import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { buildManifest } from './src/manifest';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const version = (JSON.parse(readFileSync(here('./package.json'), 'utf8')) as { version: string })
  .version;

function manifestPlugin(): Plugin {
  return {
    name: 'crewhall-extension-manifest',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: JSON.stringify(buildManifest(version), null, 2),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), manifestPlugin()],
  base: '',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // The service worker cannot load chunks that ask for a preload helper at run time.
    modulePreload: false,
    target: 'chrome127',
    rolldownOptions: {
      input: {
        popup: here('./popup.html'),
        options: here('./options.html'),
        sidepanel: here('./sidepanel.html'),
        send: here('./send.html'),
        prompt: here('./prompt.html'),
        offscreen: here('./offscreen.html'),
        background: here('./src/background/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
