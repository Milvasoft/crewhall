// Lays out a release for the server's DESKTOP_UPDATES_DIR (apps/backend serves it at
// /api/v1/desktop/updates/<platform>/):
//
//   <out>/win/latest.yml, Crewhall-Setup-<v>.exe, Crewhall-Setup-<v>.exe.blockmap
//   <out>/mac/latest-mac.yml, Crewhall-<v>-mac.zip, .dmg, blockmaps
//
// Run after `pnpm dist:win` (or dist:mac on a Mac):
//   node scripts/publish-updates.mjs [--out <dir>]          (default: apps/desktop/updates)
//
// Blockmaps of earlier versions stay: electron-updater compares the installed version's blockmap
// with the new one and downloads only the changed blocks. Older installers are removed.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const out = resolve(outArg >= 0 && args[outArg + 1] ? args[outArg + 1] : join(root, 'updates'));
const release = join(root, 'release');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

function sha512(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha512');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => done(hash.digest('base64')));
  });
}

/** electron-builder's latest.yml shape: files[], then path/sha512 of the main file. */
async function feed(entries, main) {
  const lines = [`version: ${version}`, 'files:'];
  let mainSha = '';
  for (const name of entries) {
    const path = join(release, name);
    const hash = await sha512(path);
    if (name === main) mainSha = hash;
    lines.push(`  - url: ${name}`, `    sha512: ${hash}`, `    size: ${(await stat(path)).size}`);
  }
  lines.push(`path: ${main}`, `sha512: ${mainSha}`, `releaseDate: '${new Date().toISOString()}'`);
  return `${lines.join('\n')}\n`;
}

async function publish(platform, feedFile, installers, main) {
  const dir = join(out, platform);
  await mkdir(dir, { recursive: true });
  // Earlier installers go; every blockmap stays for differential updates.
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.blockmap') && !installers.includes(name) && name !== feedFile) {
      await rm(join(dir, name), { force: true });
    }
  }
  for (const name of installers) {
    await copyFile(join(release, name), join(dir, name));
    if (existsSync(join(release, `${name}.blockmap`))) {
      await copyFile(join(release, `${name}.blockmap`), join(dir, `${name}.blockmap`));
    }
  }
  // The feed last: an app that reads it finds every file in place.
  await writeFile(join(dir, feedFile), await feed(installers, main));
  console.log(`${platform}: ${version} → ${dir}`);
}

let published = 0;
const winInstaller = `Crewhall-Setup-${version}.exe`;
if (existsSync(join(release, winInstaller))) {
  await publish('win', 'latest.yml', [winInstaller], winInstaller);
  published++;
}
const macZip = `Crewhall-${version}-mac.zip`;
const macDmg = `Crewhall-${version}-mac.dmg`;
if (existsSync(join(release, macZip))) {
  const files = existsSync(join(release, macDmg)) ? [macZip, macDmg] : [macZip];
  await publish('mac', 'latest-mac.yml', files, macZip);
  published++;
}
if (published === 0) {
  console.error(`No installer for ${version} in ${release}; run dist:win or dist:mac first.`);
  process.exit(1);
}
