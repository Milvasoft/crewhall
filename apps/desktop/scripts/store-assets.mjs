// Microsoft Store tiles (resources/appx/*.png) from resources/icon.png. electron-builder's appx target
// takes every file in that folder, under these names; a missing one falls back to its sample art.
//
// Runs in Electron, which is already here: its nativeImage resizes and writes PNG, so no image
// library is needed. The PNGs are committed; run this again only when the icon changes:
//   pnpm --filter @crewhall/desktop store:assets
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, nativeImage } from 'electron';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'resources', 'appx');

/** Name, width, height. The icon's own background fills a tile that is not square. */
const TILES = [
  ['StoreLogo.png', 50, 50],
  ['Square44x44Logo.png', 44, 44],
  ['SmallTile.png', 71, 71],
  ['Square150x150Logo.png', 150, 150],
  ['LargeTile.png', 310, 310],
  ['Wide310x150Logo.png', 310, 150],
];

function tile(icon, width, height) {
  const side = Math.min(width, height);
  const square = icon.resize({ width: side, height: side, quality: 'best' });
  if (width === height) return square.toPNG();
  // BGRA, as nativeImage hands it out: the icon in the middle, its corner colour around it.
  const src = square.toBitmap();
  const fill = src.subarray(0, 4);
  const dst = Buffer.alloc(width * height * 4);
  for (let i = 0; i < dst.length; i += 4) fill.copy(dst, i);
  const left = Math.floor((width - side) / 2);
  const top = Math.floor((height - side) / 2);
  for (let y = 0; y < side; y++) {
    src.copy(dst, ((top + y) * width + left) * 4, y * side * 4, (y + 1) * side * 4);
  }
  return nativeImage.createFromBitmap(dst, { width, height }).toPNG();
}

app.whenReady().then(() => {
  try {
    const icon = nativeImage.createFromPath(join(root, 'resources', 'icon.png'));
    if (icon.isEmpty()) throw new Error('resources/icon.png could not be read');
    mkdirSync(out, { recursive: true });
    for (const [name, width, height] of TILES) {
      writeFileSync(join(out, name), tile(icon, width, height));
      console.log(`${name} ${width}x${height}`);
    }
    const [b, g, r] = icon.toBitmap();
    console.log(
      `tile background (appx.backgroundColor): #${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`,
    );
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
