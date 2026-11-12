// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/string-obfuscator/logic.ts. See THIRD_PARTY.md.
/**
 * Mask the middle of a string (e.g. secrets, emails) while keeping a few edge
 * characters visible. Pure and local.
 */

export interface ObfuscateOptions {
  keepFirst: number;
  keepLast: number;
  maskChar: string;
  keepSpaces: boolean;
}

export const DEFAULT_OBFUSCATE: ObfuscateOptions = {
  keepFirst: 3,
  keepLast: 3,
  maskChar: '*',
  keepSpaces: true,
};

export function obfuscate(input: string, opts: ObfuscateOptions): string {
  const { keepFirst, keepLast, maskChar, keepSpaces } = opts;
  const chars = Array.from(input);
  const n = chars.length;
  const mask = maskChar || '*';

  return chars
    .map((ch, i) => {
      if (keepSpaces && /\s/.test(ch)) return ch;
      if (i < keepFirst || i >= n - keepLast) return ch;
      return mask;
    })
    .join('');
}
