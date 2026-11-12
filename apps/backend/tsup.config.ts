import { defineConfig } from 'tsup';

// Workspace packages ship TypeScript sources, so they are bundled in;
// npm dependencies stay external and come from node_modules at runtime.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    worker: 'src/worker/index.ts',
    collab: 'src/collab/index.ts',
    otel: 'src/otel.ts',
    seed: 'src/scripts/seed.ts',
    crewhall: 'src/scripts/crewhall.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  noExternal: [/^@crewhall\//],
  // Dependencies of workspace packages that are not ours to externalize (e.g. `yaml` from
  // @crewhall/editor) get bundled; CommonJS ones call require() for Node builtins, which an
  // ESM bundle lacks. esbuild's require shim uses this one when it exists.
  banner: {
    js: "import { createRequire as __crewhallCreateRequire } from 'node:module'; const require = __crewhallCreateRequire(import.meta.url);",
  },
});
