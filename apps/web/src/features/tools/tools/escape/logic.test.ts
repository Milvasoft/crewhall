// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/escape/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { escapeText, unescapeText, type EscapeTarget } from './logic';

const roundTrip = (s: string, t: EscapeTarget) => unescapeText(escapeText(s, t), t);

describe('escape', () => {
  it('escapes C# strings', () => {
    expect(escapeText('a"b\nc\t', 'csharp')).toBe('a\\"b\\nc\\t');
    expect(unescapeText('a\\"b\\nc', 'csharp')).toBe('a"b\nc');
  });

  it('escapes JSON strings', () => {
    expect(escapeText('he said "hi"', 'json')).toBe('he said \\"hi\\"');
    expect(roundTrip('tab\there "q"', 'json')).toBe('tab\there "q"');
  });

  it('escapes regex metacharacters', () => {
    expect(escapeText('a.b*c(d)', 'regex')).toBe('a\\.b\\*c\\(d\\)');
    expect(roundTrip('a.b+c?', 'regex')).toBe('a.b+c?');
  });

  it('escapes URLs and HTML', () => {
    expect(escapeText('a b&c', 'url')).toBe('a%20b%26c');
    expect(escapeText('<a href="x">&', 'html')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;');
    expect(roundTrip('<b>"&\'', 'html')).toBe('<b>"&\'');
  });

  it('round-trips C# unicode escapes', () => {
    expect(unescapeText('\\u0041\\u00e9', 'csharp')).toBe('Aé');
  });

  it('returns empty string for empty input across every target', () => {
    const targets: EscapeTarget[] = ['csharp', 'json', 'regex', 'url', 'html'];
    for (const t of targets) {
      expect(escapeText('', t)).toBe('');
      expect(unescapeText('', t)).toBe('');
    }
  });

  it('leaves non-ASCII and emoji untouched by C# escaping (no backslash to reinterpret)', () => {
    const s = 'café 😀';
    expect(escapeText(s, 'csharp')).toBe(s);
    expect(roundTrip(s, 'csharp')).toBe(s);
  });

  it('escapes every individual C# control character', () => {
    expect(escapeText('\\', 'csharp')).toBe('\\\\');
    expect(escapeText('\0', 'csharp')).toBe('\\0');
    expect(escapeText('\f', 'csharp')).toBe('\\f');
    expect(escapeText('\v', 'csharp')).toBe('\\v');
    expect(escapeText('\r', 'csharp')).toBe('\\r');
  });

  it('throws on a malformed C# unicode escape', () => {
    expect(() => unescapeText('\\uZZZZ', 'csharp')).toThrow();
  });

  it('JSON-escapes control characters as \\u escapes', () => {
    expect(escapeText('', 'json')).toBe('\\u0001');
  });

  it('throws on a malformed JSON escape sequence', () => {
    expect(() => unescapeText('\\u12', 'json')).toThrow();
  });

  it('round-trips Unicode and emoji through JSON escaping', () => {
    const s = 'héllo 😀 世界';
    expect(roundTrip(s, 'json')).toBe(s);
  });

  it('leaves already-safe text unchanged when regex-unescaping', () => {
    // "\a" isn't a recognized escaped metacharacter, so it passes through as-is.
    expect(unescapeText('\\a', 'regex')).toBe('\\a');
  });

  it('round-trips Unicode through URL escaping', () => {
    const s = 'héllo/世界?x=1 😀';
    expect(roundTrip(s, 'url')).toBe(s);
  });

  it('decodes numeric HTML entities (decimal and hex)', () => {
    expect(unescapeText('&#65;&#x42;', 'html')).toBe('AB');
  });

  it('decodes only one layer of HTML entities', () => {
    // "&amp;lt;" unescapes to "&lt;", not all the way to "<".
    expect(unescapeText('&amp;lt;', 'html')).toBe('&lt;');
  });
});
