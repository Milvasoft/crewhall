// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/emoji-picker/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { EMOJI_GROUPS, EMOJIS, searchEmojis } from './logic';

describe('emoji-picker', () => {
  it('loads a large emoji dataset', () => {
    expect(EMOJIS.length).toBeGreaterThan(1000);
    expect(EMOJIS[0]!.char).toBeTruthy();
  });

  it('finds emojis by name', () => {
    const rocket = searchEmojis('rocket');
    expect(rocket.some((e) => e.char === '🚀')).toBe(true);

    const grin = searchEmojis('grinning');
    expect(grin.some((e) => e.char === '😀')).toBe(true);
  });

  it('returns everything for an empty query', () => {
    expect(searchEmojis('').length).toBe(EMOJIS.length);
  });

  it('filters by group', () => {
    const results = searchEmojis('', 'Smileys & Emotion');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((e) => e.group === 'Smileys & Emotion')).toBe(true);
    expect(results.some((e) => e.char === '😀')).toBe(true);
    // An emoji from a different group should be excluded.
    expect(results.some((e) => e.name.includes('rocket'))).toBe(false);
  });

  it('combines a text query with a group filter', () => {
    const results = searchEmojis('rocket', 'Animals & Nature');
    expect(results.length).toBe(0);
  });

  it('is case-insensitive', () => {
    const upper = searchEmojis('ROCKET');
    expect(upper.some((e) => e.char === '🚀')).toBe(true);
  });

  it('matches multi-word queries against underscored slugs', () => {
    const results = searchEmojis('grinning face');
    expect(results.some((e) => e.char === '😀')).toBe(true);
  });

  it('returns an empty array when nothing matches', () => {
    expect(searchEmojis('zzzznotarealemojiquery')).toEqual([]);
  });

  it('exposes a non-empty, de-duplicated list of groups', () => {
    expect(EMOJI_GROUPS.length).toBeGreaterThan(0);
    expect(new Set(EMOJI_GROUPS).size).toBe(EMOJI_GROUPS.length);
  });
});
