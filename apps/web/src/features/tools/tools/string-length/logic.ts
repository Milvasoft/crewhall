// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/string-length/logic.ts. See THIRD_PARTY.md.
export interface TextStats {
  characters: number; // Unicode code points (user-perceived closer than UTF-16)
  utf16: number; // JS string length (UTF-16 code units)
  bytes: number; // UTF-8 byte length
  words: number;
  lines: number;
  sentences: number;
  charactersNoSpaces: number;
}

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

function byteLength(text: string): number {
  if (encoder) return encoder.encode(text).length;
  // Fallback for environments without TextEncoder.
  return unescape(encodeURIComponent(text)).length;
}

export function computeTextStats(text: string): TextStats {
  const codePoints = Array.from(text);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lines = text === '' ? 0 : text.split(/\r\n|\r|\n/).length;
  const sentences = (text.match(/[^.!?]+[.!?]+(\s|$)/g) || []).length;

  return {
    characters: codePoints.length,
    utf16: text.length,
    bytes: byteLength(text),
    words,
    lines,
    sentences,
    charactersNoSpaces: codePoints.filter((c) => !/\s/.test(c)).length,
  };
}
