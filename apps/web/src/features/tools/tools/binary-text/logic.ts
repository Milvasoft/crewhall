// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/binary-text/logic.ts. See THIRD_PARTY.md.
/**
 * Text ↔ binary conversion. UTF-8 aware (multi-byte characters encode to
 * multiple bytes), pure and local.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encode text to a space-separated string of 8-bit binary bytes (UTF-8).
 * `separator` lets callers choose spaces (default), none, or newlines.
 */
export function textToBinary(text: string, separator = ' '): string {
  if (!text) return '';
  const bytes = encoder.encode(text);
  return Array.from(bytes, (b) => b.toString(2).padStart(8, '0')).join(separator);
}

/**
 * Decode a binary string back to text. Tolerant of any whitespace between
 * groups; also accepts one long unbroken run of bits (chunked into bytes).
 */
export function binaryToText(binary: string): string {
  const cleaned = binary.replace(/\s+/g, '');
  if (!cleaned) return '';
  if (!/^[01]+$/.test(cleaned)) {
    throw new Error('Binary may only contain 0, 1 and whitespace.');
  }
  if (cleaned.length % 8 !== 0) {
    throw new Error('Bit count must be a multiple of 8.');
  }
  const bytes = new Uint8Array(cleaned.length / 8);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleaned.slice(i * 8, i * 8 + 8), 2);
  }
  return decoder.decode(bytes);
}
