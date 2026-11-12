// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/emoji-picker/logic.ts. See THIRD_PARTY.md.
import emojiData from 'unicode-emoji-json';

/**
 * Searchable emoji list built from the bundled unicode-emoji-json dataset.
 * Pure and local.
 */

interface EmojiInfo {
  name: string;
  slug: string;
  group?: string;
}

const data = emojiData as unknown as Record<string, EmojiInfo>;

export interface EmojiEntry {
  char: string;
  name: string;
  slug: string;
  group: string;
}

export const EMOJIS: EmojiEntry[] = Object.entries(data).map(([char, info]) => ({
  char,
  name: info.name,
  slug: info.slug,
  group: info.group ?? 'Other',
}));

export const EMOJI_GROUPS: string[] = [...new Set(EMOJIS.map((e) => e.group))];

/** Filter emojis by a free-text query over name and slug, optionally by group. */
export function searchEmojis(query: string, group = 'All'): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  return EMOJIS.filter((e) => {
    if (group !== 'All' && e.group !== group) return false;
    if (!q) return true;
    return e.name.toLowerCase().includes(q) || e.slug.includes(q.replace(/\s+/g, '_'));
  });
}
