// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/regex-tester/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { explainRegex, runRegex, translateDotNet } from './logic';

describe('runRegex', () => {
  it('returns all global matches with groups', () => {
    const r = runRegex('(\\w)(\\w)', 'g', 'ab cd');
    expect(r.matches).toHaveLength(2);
    expect(r.matches[0]!.groups).toEqual(['a', 'b']);
    expect(r.matches[0]!.index).toBe(0);
  });

  it('captures named groups', () => {
    const r = runRegex('(?<year>\\d{4})', '', '2026');
    expect(r.matches[0]!.namedGroups.year).toBe('2026');
  });

  it('reports invalid patterns', () => {
    const r = runRegex('(', '', 'x');
    expect(r.error).toBeTruthy();
    expect(r.matches).toHaveLength(0);
  });

  it('does not infinite-loop on zero-length matches', () => {
    const r = runRegex('a*', 'g', 'aXa');
    expect(r.matches.length).toBeGreaterThan(0);
  });

  it('computes replacement', () => {
    const r = runRegex('(\\d+)', 'g', 'a1b2', '#$1');
    expect(r.replacement).toBe('a#1b#2');
  });

  it("leaves $N literal when the group doesn't exist (JS semantics)", () => {
    const r = runRegex('x', 'g', 'x', '$121');
    expect(r.replacement).toBe('$121');
  });

  it('translates common .NET constructs', () => {
    expect(translateDotNet("(?'year'\\d{4})")).toBe('(?<year>\\d{4})');
    expect(translateDotNet('\\Aabc\\z')).toBe('^abc$');
    const r = runRegex("(?'y'\\d{4})", '', '2026', undefined, 'dotnet');
    expect(r.matches[0]!.namedGroups.y).toBe('2026');
  });

  it('returns no matches and no error for an empty pattern', () => {
    expect(runRegex('', '', 'abc')).toEqual({ matches: [], error: null });
  });

  it('reports invalid flags as an error', () => {
    const r = runRegex('a', 'gg', 'aaa');
    expect(r.error).toBeTruthy();
    expect(r.matches).toHaveLength(0);
  });

  it('gives an empty namedGroups object when the pattern has no named groups', () => {
    const r = runRegex('(a)', '', 'a');
    expect(r.matches[0]!.namedGroups).toEqual({});
  });

  it('supports the multiline flag', () => {
    const r = runRegex('^b', 'm', 'a\nb');
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.index).toBe(2);
  });

  it('supports the case-insensitive flag', () => {
    const r = runRegex('ABC', 'i', 'xx abc xx');
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.match).toBe('abc');
  });

  it("respects the sticky flag's contiguous-match requirement", () => {
    // Sticky matches only find runs starting exactly at lastIndex, so the
    // non-adjacent "34" run is skipped even though it appears later.
    const r = runRegex('\\d+', 'gy', '12ab34');
    expect(r.matches.map((m) => m.match)).toEqual(['12']);
  });

  it('leaves the replacement equal to the input when nothing matches', () => {
    const r = runRegex('zzz', '', 'abc', 'X');
    expect(r.replacement).toBe('abc');
  });

  it('caps runaway global matches via the guardrail', () => {
    // A zero-width pattern matching at every position would otherwise
    // produce one match per character; the guardrail caps the total.
    const r = runRegex('(?:)', 'g', 'a'.repeat(15000));
    expect(r.matches.length).toBeLessThanOrEqual(10001);
    expect(r.matches.length).toBeLessThan(15000);
  });

  it('handles a catastrophic-backtracking-shaped pattern on a small input without hanging', () => {
    const r = runRegex('(a+)+$', '', 'a'.repeat(15) + '!');
    expect(r.error).toBeNull();
    expect(r.matches).toHaveLength(0);
  });
});

describe('explainRegex', () => {
  it('describes anchors, classes and quantifiers', () => {
    const tokens = explainRegex('^\\d{3}-\\w+$');
    const map = Object.fromEntries(tokens.map((t) => [t.token, t.description]));
    expect(map['^']).toContain('Start');
    expect(map['\\d']).toContain('digit');
    expect(map['{3}']).toContain('Exactly 3');
    expect(map['-']).toContain('Literal');
    expect(map['\\w']).toContain('word');
    expect(map['+']).toContain('One or more');
    expect(map['$']).toContain('End');
  });

  it('describes groups, sets and named groups', () => {
    const named = explainRegex('(?<year>[0-9]{4})');
    expect(named.some((t) => /Named capturing group “year”/.test(t.description))).toBe(true);
    expect(named.some((t) => /in the set/.test(t.description))).toBe(true);
  });

  it('marks lazy quantifiers', () => {
    const tokens = explainRegex('a+?');
    expect(tokens.find((t) => t.token === '+?')?.description).toContain('lazy');
  });

  it('describes lookaheads, lookbehinds and non-capturing groups', () => {
    expect(explainRegex('(?=x)')[0]!.description).toContain('Positive lookahead');
    expect(explainRegex('(?!x)')[0]!.description).toContain('Negative lookahead');
    expect(explainRegex('(?<=x)')[0]!.description).toContain('Positive lookbehind');
    expect(explainRegex('(?<!x)')[0]!.description).toContain('Negative lookbehind');
    expect(explainRegex('(?:x)')[0]!.description).toContain('Non-capturing group');
  });

  it('describes escape sequences: newline/tab, unicode, hex and back-references', () => {
    const map = (p: string) =>
      Object.fromEntries(explainRegex(p).map((t) => [t.token, t.description]));
    expect(map('\\n')['\\n']).toContain('Newline');
    expect(map('\\t')['\\t']).toContain('Tab');
    expect(map('\\u0041')['\\u0041']).toContain('U+0041');
    expect(map('\\x41')['\\x41']).toContain('0x41');
    expect(map('(a)\\1')['\\1']).toContain('Back-reference to group 1');
  });

  it('describes zero-or-more and optional quantifiers', () => {
    const star = explainRegex('a*').find((t) => t.token === '*');
    expect(star?.description).toContain('Zero or more');
    expect(star?.description).toContain('greedy');
    const opt = explainRegex('a?').find((t) => t.token === '?');
    expect(opt?.description).toContain('Optional');
  });

  it('treats an unclosed { as a literal character rather than a quantifier', () => {
    const tokens = explainRegex('a{2');
    expect(tokens).toEqual([{ token: 'a{2', description: 'Literal text “a{2”' }]);
  });
});
