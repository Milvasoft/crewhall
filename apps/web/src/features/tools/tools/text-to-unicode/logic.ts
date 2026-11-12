// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/text-to-unicode/logic.ts. See THIRD_PARTY.md.
/**
 * Convert text to Unicode escape sequences and back. Pure and local.
 */

export type UnicodeFormat = 'js' | 'es6' | 'u+' | 'html';

export const UNICODE_FORMATS: { id: UnicodeFormat; label: string; sample: string }[] = [
  { id: 'js', label: 'JS \\uXXXX', sample: '\\u0041' },
  { id: 'es6', label: 'ES6 \\u{...}', sample: '\\u{41}' },
  { id: 'u+', label: 'U+XXXX', sample: 'U+0041' },
  { id: 'html', label: 'HTML &#x…;', sample: '&#x41;' },
];

export function encodeUnicode(text: string, format: UnicodeFormat = 'js'): string {
  if (format === 'js') {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      out += '\\u' + text.charCodeAt(i).toString(16).padStart(4, '0');
    }
    return out;
  }

  const codePoints = Array.from(text, (c) => c.codePointAt(0) ?? 0);
  return codePoints
    .map((cp) => {
      const hex = cp.toString(16);
      if (format === 'es6') return `\\u{${hex}}`;
      if (format === 'u+') return `U+${hex.toUpperCase().padStart(4, '0')}`;
      return `&#x${hex};`;
    })
    .join(format === 'u+' ? ' ' : '');
}

/** Decode any mix of \uXXXX, \u{...}, U+XXXX, &#xHH; and &#DD; escapes to text. */
export function decodeUnicode(input: string): string {
  return input
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/U\+([0-9a-fA-F]{1,6})\s?/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}
