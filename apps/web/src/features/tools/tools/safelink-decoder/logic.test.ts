// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/safelink-decoder/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { decodeSafelink } from './logic';

describe('safelink-decoder', () => {
  it('decodes an Outlook SafeLink', () => {
    const link =
      'https://na01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com%2Fpath%3Fa%3D1&data=abc&reserved=0';
    expect(decodeSafelink(link)).toBe('https://example.com/path?a=1');
  });

  it('decodes a generic ?u= wrapper', () => {
    expect(decodeSafelink('https://click.example.net/redirect?u=https%3A%2F%2Ffoo.dev')).toBe(
      'https://foo.dev',
    );
  });

  it('throws when no wrapped URL is present', () => {
    expect(() => decodeSafelink('https://example.com/plain')).toThrow();
    expect(() => decodeSafelink('not a url')).toThrow();
  });

  it('throws for empty or whitespace-only input', () => {
    expect(() => decodeSafelink('')).toThrow('Paste a wrapped link.');
    expect(() => decodeSafelink('   ')).toThrow('Paste a wrapped link.');
  });

  it('throws a distinct error for unparsable URLs', () => {
    expect(() => decodeSafelink('not a url')).toThrow("That doesn't look like a URL.");
  });

  it("decodes the 'q' and 'target' wrapper params", () => {
    expect(decodeSafelink('https://wrap.example/go?q=https%3A%2F%2Fbar.example')).toBe(
      'https://bar.example',
    );
    expect(decodeSafelink('https://wrap.example/go?target=https%3A%2F%2Fbaz.example')).toBe(
      'https://baz.example',
    );
  });

  it("prefers 'url' over later keys when several are present", () => {
    const link =
      'https://wrap.example/go?url=https%3A%2F%2Ffirst.example&u=https%3A%2F%2Fsecond.example';
    expect(decodeSafelink(link)).toBe('https://first.example');
  });

  it("skips a param whose decoded value doesn't look like an http(s) URL", () => {
    // 'url' decodes to a non-http(s) scheme, so it's rejected; 'u' is used instead.
    const link =
      'https://wrap.example/go?url=ftp%3A%2F%2Ffiles.example&u=https%3A%2F%2Ffallback.example';
    expect(decodeSafelink(link)).toBe('https://fallback.example');
  });

  it('accepts an uppercase HTTP(S) scheme in the decoded target', () => {
    expect(decodeSafelink('https://wrap.example/go?url=HTTPS%3A%2F%2Fexample.com')).toBe(
      'HTTPS://example.com',
    );
  });

  it('treats an empty param value as absent', () => {
    expect(() => decodeSafelink('https://wrap.example/go?url=')).toThrow(
      'No wrapped URL found (expected a `url=` style parameter).',
    );
  });
});
