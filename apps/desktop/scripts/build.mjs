// Bundles the app into dist/ (no node_modules at runtime): main and preload as CommonJS for
// Electron, the app's own pages as one browser script, plus static files.
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const require = createRequire(import.meta.url);

await rm(dist, { recursive: true, force: true });

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const common = {
  bundle: true,
  sourcemap: 'linked',
  logLevel: 'warning',
  legalComments: 'none',
  define: {
    // Signed macOS builds only: the keychain group of the Touch ID passkey authenticator.
    // The preload is sandboxed (no app.getVersion()): the bridge's version comes from here.
    __APP_VERSION__: JSON.stringify(version),
    __MAC_KEYCHAIN_GROUP__: JSON.stringify(process.env.CREWHALL_MAC_KEYCHAIN_GROUP ?? ''),
  },
};

await Promise.all([
  build({
    ...common,
    entryPoints: [join(root, 'src/main/index.ts')],
    outfile: join(dist, 'main.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  // Sandboxed preload: may require only "electron".
  build({
    ...common,
    entryPoints: [join(root, 'src/preload/index.ts')],
    outfile: join(dist, 'preload.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src/renderer/app.ts')],
    outfile: join(dist, 'renderer/app.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
  }),
]);

await mkdir(join(dist, 'renderer/fonts'), { recursive: true });
await cp(join(root, 'src/renderer/index.html'), join(dist, 'renderer/index.html'));
await cp(join(root, 'src/renderer/style.css'), join(dist, 'renderer/style.css'));
await cp(join(root, 'assets'), join(dist, 'assets'), { recursive: true });
const fonts = join(dirname(require.resolve('@fontsource-variable/nunito/package.json')), 'files');
await cp(
  join(fonts, 'nunito-latin-wght-normal.woff2'),
  join(dist, 'renderer/fonts/nunito-latin.woff2'),
);
await cp(
  join(fonts, 'nunito-latin-ext-wght-normal.woff2'),
  join(dist, 'renderer/fonts/nunito-latin-ext.woff2'),
);

// Remote control input: the N-API prebuilds of @jitsi/robotjs (ABI stable, so no electron-rebuild).
// Windows x64 and macOS universal; electron-builder keeps them out of the asar (asarUnpack).
const robot = join(dirname(require.resolve('@jitsi/robotjs/package.json')), 'prebuilds');
for (const dir of ['win32-x64', 'win32-arm64', 'darwin-x64+arm64']) {
  const from = join(robot, dir, '@jitsi+robotjs.node');
  if (!existsSync(from)) continue;
  await mkdir(join(dist, 'native', dir), { recursive: true });
  await cp(from, join(dist, 'native', dir, 'robotjs.node'));
}

// Virtual drive: the add-on, where scripts/build-native.mjs has built it (Windows, `dist:win`).
const cloudFiles = join(root, 'native/cloudfiles/build/Release/cloudfiles.node');
if (existsSync(cloudFiles)) {
  await mkdir(join(dist, 'native', `win32-${process.arch}`), { recursive: true });
  await cp(cloudFiles, join(dist, 'native', `win32-${process.arch}`, 'cloudfiles.node'));
}
