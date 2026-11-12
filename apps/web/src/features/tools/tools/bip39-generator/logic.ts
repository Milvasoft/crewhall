// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/bip39-generator/logic.ts. See THIRD_PARTY.md.
import { WORDLIST } from './wordlist';

/**
 * BIP39 mnemonic generation and validation, implemented with the Web Crypto
 * API (SHA-256 checksum, PBKDF2-HMAC-SHA512 seed). Everything runs locally.
 */

const VALID_ENTROPY_BYTES = [16, 20, 24, 28, 32];
const VALID_WORD_COUNTS = [12, 15, 18, 21, 24];

// Web Crypto typings want ArrayBuffer-backed views; our Uint8Arrays are fine.
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', buf(data));
  return new Uint8Array(digest);
}

function bytesToBits(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(2).padStart(8, '0')).join('');
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Convert raw entropy into a mnemonic phrase. */
export async function entropyToMnemonic(entropy: Uint8Array): Promise<string> {
  if (!VALID_ENTROPY_BYTES.includes(entropy.length)) {
    throw new Error('Entropy must be 128–256 bits (in 32-bit steps).');
  }
  const checksumLength = (entropy.length * 8) / 32;
  const hash = await sha256(entropy);
  const bits = bytesToBits(entropy) + bytesToBits(hash).slice(0, checksumLength);

  const words: string[] = [];
  for (let i = 0; i < bits.length; i += 11) {
    words.push(WORDLIST[parseInt(bits.slice(i, i + 11), 2)]!);
  }
  return words.join(' ');
}

/** Generate a fresh mnemonic of the given strength (128–256 bits). */
export async function generateMnemonic(strengthBits = 128): Promise<string> {
  if (strengthBits % 32 !== 0 || strengthBits < 128 || strengthBits > 256) {
    throw new Error('Strength must be 128, 160, 192, 224 or 256 bits.');
  }
  const entropy = new Uint8Array(strengthBits / 8);
  crypto.getRandomValues(entropy);
  return entropyToMnemonic(entropy);
}

/** Validate a mnemonic and recover its entropy. Throws on any problem. */
export async function mnemonicToEntropy(mnemonic: string): Promise<Uint8Array> {
  const words = mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!VALID_WORD_COUNTS.includes(words.length)) {
    throw new Error('A mnemonic has 12, 15, 18, 21 or 24 words.');
  }

  let bits = '';
  for (const word of words) {
    const index = WORDLIST.indexOf(word);
    if (index < 0) throw new Error(`Not a BIP39 word: "${word}".`);
    bits += index.toString(2).padStart(11, '0');
  }

  const checksumLength = bits.length / 33;
  const entropyLength = bits.length - checksumLength;
  const entropyBits = bits.slice(0, entropyLength);
  const checksumBits = bits.slice(entropyLength);

  const entropy = new Uint8Array(entropyLength / 8);
  for (let i = 0; i < entropy.length; i++) {
    entropy[i] = parseInt(entropyBits.slice(i * 8, i * 8 + 8), 2);
  }

  const hash = await sha256(entropy);
  if (bytesToBits(hash).slice(0, checksumLength) !== checksumBits) {
    throw new Error('Invalid checksum — the mnemonic may be mistyped.');
  }
  return entropy;
}

export async function validateMnemonic(mnemonic: string): Promise<boolean> {
  try {
    await mnemonicToEntropy(mnemonic);
    return true;
  } catch {
    return false;
  }
}

/** Derive the 512-bit BIP39 seed (PBKDF2, 2048 iterations, SHA-512). */
export async function mnemonicToSeed(mnemonic: string, passphrase = ''): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    buf(enc.encode(mnemonic.normalize('NFKD'))),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const salt = enc.encode('mnemonic' + passphrase.normalize('NFKD'));
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: buf(salt), iterations: 2048, hash: 'SHA-512' },
    key,
    512,
  );
  return new Uint8Array(derived);
}
