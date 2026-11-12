import { sha256 } from '@noble/hashes/sha2.js';
import { utf8 } from '../src/bytes';

/** Deterministic test bytes: SHA-256 chain over a label (same helper the vectors use). */
export function det(label: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let block = sha256(utf8(label));
  for (let o = 0; o < length; o += 32) {
    out.set(block.subarray(0, Math.min(32, length - o)), o);
    block = sha256(block);
  }
  return out;
}
