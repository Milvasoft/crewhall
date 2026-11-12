// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/numeronym-generator/logic.ts. See THIRD_PARTY.md.
/**
 * Numeronym generator: keep the first and last letters of a long word and
 * replace the middle with its letter count (e.g. "internationalization" →
 * "i18n", "accessibility" → "a11y"). Pure and local.
 */

/** Numeronym of a single alphabetic word; words of 3 letters or fewer are unchanged. */
export function numeronym(word: string): string {
  if (word.length <= 3) return word;
  return `${word[0]}${word.length - 2}${word[word.length - 1]}`;
}

/** Apply the numeronym transform to every word (4+ letters) in a text. */
export function numeronymText(text: string): string {
  return text.replace(/[A-Za-z]{4,}/g, (w) => numeronym(w));
}
