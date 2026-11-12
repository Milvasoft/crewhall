import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRAY_SCALES, trayVariant } from '../src/common/tray-icon';

const assets = join(__dirname, '../assets');
const suffix = (scale: number) => (scale === 1 ? '' : `@${scale}x`);
/** Width and height from a PNG's IHDR. */
function pngSize(file: string): [number, number] {
  const b = readFileSync(join(assets, file));
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe('trayVariant', () => {
  it('follows the Windows taskbar theme, not the apps theme', () => {
    expect(trayVariant('win32', true)).toBe('tray-dark');
    expect(trayVariant('win32', false)).toBe('tray-light');
  });

  it('is a template image on macOS and the white mark on Linux', () => {
    expect(trayVariant('darwin', true)).toBe('trayTemplate');
    expect(trayVariant('darwin', false)).toBe('trayTemplate');
    expect(trayVariant('linux', false)).toBe('tray-dark');
  });

  it('ships every size, 16 to 32 px', () => {
    for (const variant of ['tray-light', 'tray-dark']) {
      for (const scale of TRAY_SCALES) {
        const px = 16 * scale;
        expect(pngSize(`${variant}${suffix(scale)}.png`), `${variant} ${scale}`).toEqual([px, px]);
      }
    }
    expect(pngSize('trayTemplate.png')).toEqual([16, 16]);
    expect(pngSize('trayTemplate@2x.png')).toEqual([32, 32]);
  });
});
