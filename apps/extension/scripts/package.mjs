// Packs dist/ into a zip for the Chrome Web Store, using the tools every platform has.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'manifest.json'))) throw new Error('Run the build first.');
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const outDir = join(root, 'release');
const stage = join(outDir, 'store');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(dist, stage, { recursive: true });

// The store refuses `key` and gives the item its own id; the key only fixes the id of a local build.
delete manifest.key;
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));

const zip = join(outDir, `crewhall-extension-${manifest.version}.zip`);
rmSync(zip, { force: true });
if (process.platform === 'win32') {
  // Windows' own tar, not Compress-Archive: that one writes `assets\a.css`, which is no zip path.
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-cf', zip, '-C', stage, ...readdirSync(stage)], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-qr', zip, '.'], { cwd: stage, stdio: 'inherit' });
}
rmSync(stage, { recursive: true, force: true });
console.log(zip);
