// Builds the Cloud Files add-on (native/cloudfiles) with node-gyp. Windows only, and it needs
// Visual Studio with the C++ tools, so it is not part of `build`: the app runs without the add-on,
// only the virtual drive stays off. `dist:win` runs it, and scripts/build.mjs copies the result.
//
// N-API is ABI stable: a build against Node's headers loads in Electron too.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('build-native: Windows only, nothing to do here.');
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const gyp = createRequire(import.meta.url).resolve('node-gyp/bin/node-gyp.js');

const result = spawnSync(process.execPath, [gyp, 'rebuild'], {
  cwd: join(root, 'native/cloudfiles'),
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
