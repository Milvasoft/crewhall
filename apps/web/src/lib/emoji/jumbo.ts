import animated from './animated.json';

/** Messages made of only this many emojis (or fewer) are shown large. */
export const JUMBO_MAX = 3;

const PICTO = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The emojis of an emoji-only message (1–3, spaces allowed), or null for any other text. */
export function jumboEmojis(text: string): string[] | null {
  const parts: string[] = [];
  for (const { segment } of segmenter.segment(text.trim())) {
    if (/^\s+$/u.test(segment)) continue;
    if (!PICTO.test(segment)) return null;
    parts.push(segment);
    if (parts.length > JUMBO_MAX) return null;
  }
  return parts.length ? parts : null;
}

const ANIMATED = new Set<string>(animated);
const hexOf = (s: string) => [...s].map((c) => c.codePointAt(0)!.toString(16)).join('_');

/** The Noto Animated Emoji file name for this emoji, when it is in the bundled set. */
export function animatedHex(emoji: string): string | null {
  const hex = hexOf(emoji);
  if (ANIMATED.has(hex)) return hex;
  const bare = hexOf(emoji.replace(/️/g, ''));
  if (ANIMATED.has(bare)) return bare;
  const dressed = `${bare}_fe0f`;
  return ANIMATED.has(dressed) ? dressed : null;
}
