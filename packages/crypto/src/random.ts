import { CryptoError } from './bytes';

/** Fills the array with cryptographically secure random bytes. */
export type RandomSource = (out: Uint8Array) => void;

interface CryptoLike {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

let custom: RandomSource | null = null;

/**
 * Overrides the random source. Browsers and Node 20+ need nothing (Web Crypto
 * `getRandomValues`); React Native injects one (e.g. expo-crypto's getRandomValues).
 */
export function configureRandom(source: RandomSource | null) {
  custom = source;
}

function platformSource(): RandomSource {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new CryptoError(
      'random_unavailable',
      'no secure random source: call configureRandom() with the platform generator',
    );
  }
  return (out) => {
    // getRandomValues fills at most 65536 bytes per call.
    for (let i = 0; i < out.length; i += 65536) c.getRandomValues(out.subarray(i, i + 65536));
  };
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  (custom ?? platformSource())(out);
  // A broken injected source would silently ruin every key; reject the obvious failure.
  if (length >= 16 && out.every((b) => b === 0)) {
    throw new CryptoError('random_unavailable', 'random source returned zeros');
  }
  return out;
}

/** Uniform integer in [0, max) by rejection sampling: no modulo bias. */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0 || max > 2 ** 32) {
    throw new CryptoError('invalid_input', 'randomInt bound out of range');
  }
  const limit = 2 ** 32 - (2 ** 32 % max);
  for (;;) {
    const b = randomBytes(4);
    const n =
      (((b[0] as number) << 24) |
        ((b[1] as number) << 16) |
        ((b[2] as number) << 8) |
        (b[3] as number)) >>>
      0;
    if (n < limit) return n % max;
  }
}

/** Unbiased Fisher-Yates shuffle (copy). */
export function shuffle<T>(list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * UUID v7 (time ordered, RFC 9562). Vault and item ids are generated on the client
 * because they are bound into the ciphertext (AAD) before the server sees them.
 */
export function newId(now = Date.now()): string {
  const b = randomBytes(16);
  const ms = Math.floor(now);
  b[0] = Math.floor(ms / 2 ** 40) & 255;
  b[1] = Math.floor(ms / 2 ** 32) & 255;
  b[2] = (ms >>> 24) & 255;
  b[3] = (ms >>> 16) & 255;
  b[4] = (ms >>> 8) & 255;
  b[5] = ms & 255;
  b[6] = 0x70 | ((b[6] as number) & 0x0f);
  b[8] = 0x80 | ((b[8] as number) & 0x3f);
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
