import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav, RINGTONE_FILES, RINGTONES, renderRingtone, SOUND_SAMPLE_RATE } from './index';

/**
 * Writes the call, meeting and chat sounds to apps/web/public/sounds (committed; the mobile app
 * copies them with scripts/sync-call-sounds.mjs).
 * Run after changing src/ringtones.ts: pnpm --filter @crewhall/sounds sounds:generate
 */
export const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'apps',
  'web',
  'public',
  'sounds',
);

export function soundFiles(): { name: string; bytes: Uint8Array }[] {
  return (Object.keys(RINGTONES) as (keyof typeof RINGTONES)[]).map((key) => ({
    name: RINGTONE_FILES[key],
    bytes: encodeWav(renderRingtone(RINGTONES[key], SOUND_SAMPLE_RATE), SOUND_SAMPLE_RATE),
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of soundFiles()) {
    writeFileSync(join(OUT_DIR, f.name), f.bytes);
    const v = new DataView(f.bytes.buffer, f.bytes.byteOffset);
    const seconds = v.getUint32(40, true) / v.getUint32(28, true);
    console.log(`${f.name}: ${seconds.toFixed(2)} s, ${(f.bytes.length / 1024).toFixed(0)} KB`);
  }
}
