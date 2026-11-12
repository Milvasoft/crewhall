// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/slugify-string/logic.ts. See THIRD_PARTY.md.
/**
 * Turn arbitrary text into a URL-safe slug. Pure and local.
 */

export interface SlugOptions {
  separator?: string;
  lowercase?: boolean;
}

export function slugify(input: string, opts: SlugOptions = {}): string {
  const { separator = '-', lowercase = true } = opts;
  let s = input
    .replace(/ı/g, 'i') // Turkish dotless i has no decomposition; keep it as a letter
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics (combining marks)
    .replace(/[^a-zA-Z0-9]+/g, separator); // non-alphanumerics → separator

  // Collapse repeats and trim leading/trailing separators.
  if (separator) {
    const esc = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`${esc}{2,}`, 'g'), separator);
    s = s.replace(new RegExp(`^${esc}+|${esc}+$`, 'g'), '');
  }
  return lowercase ? s.toLowerCase() : s;
}
