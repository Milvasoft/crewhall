import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, nativeImage, session, type NativeImage } from 'electron';

const cacheFile = () => join(app.getPath('userData'), 'brand-icon.png');

/** The org's icon from the last run, so the tray shows it before the network answers. */
export function loadCachedIcon(): NativeImage | null {
  try {
    const image = nativeImage.createFromBuffer(readFileSync(cacheFile()));
    return image.isEmpty() ? null : image;
  } catch {
    return null;
  }
}

/**
 * Downloads the org's mark (or favicon) for the window, tray and notifications. PNG, JPEG and
 * ICO work; SVG does not (nativeImage cannot draw it), and then the Crewhall icon stays.
 */
export async function brandIcon(url: string): Promise<NativeImage | null> {
  try {
    const res = await session.defaultSession.fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('svg')) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return null;
    const png = image.resize({ width: 256, height: 256, quality: 'best' }).toPNG();
    await writeFile(cacheFile(), png);
    return nativeImage.createFromBuffer(png);
  } catch {
    return null;
  }
}
