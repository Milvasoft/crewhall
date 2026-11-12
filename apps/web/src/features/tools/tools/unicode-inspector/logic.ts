// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/unicode-inspector/logic.ts. See THIRD_PARTY.md.
export interface CharInfo {
  char: string;
  codePoint: number;
  hex: string; // U+XXXX
  decimal: number;
  utf8: string; // space-separated hex bytes
  utf16: string; // space-separated hex code units
  htmlEntity: string;
}

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function utf8Bytes(char: string): string {
  const bytes = encoder
    ? Array.from(encoder.encode(char))
    : Array.from(unescape(encodeURIComponent(char))).map((c) => c.charCodeAt(0));
  return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function utf16Units(char: string): string {
  const units: string[] = [];
  for (let i = 0; i < char.length; i++) {
    units.push(char.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase());
  }
  return units.join(' ');
}

/** Break text into per-code-point details. */
export function inspect(text: string): CharInfo[] {
  return Array.from(text).map((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return {
      char,
      codePoint,
      hex: 'U+' + codePoint.toString(16).toUpperCase().padStart(4, '0'),
      decimal: codePoint,
      utf8: utf8Bytes(char),
      utf16: utf16Units(char),
      htmlEntity: `&#${codePoint};`,
    };
  });
}
