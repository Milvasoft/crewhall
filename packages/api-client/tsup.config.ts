import { defineConfig } from 'tsup';

// The published package stands alone: the contract (@crewhall/shared) is bundled in, types
// included, and only zod stays a dependency. Inside the monorepo the sources are used directly.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'neutral',
  target: 'es2022',
  dts: { resolve: true },
  sourcemap: true,
  clean: true,
  noExternal: [/^@crewhall\//],
  external: ['zod'],
});
