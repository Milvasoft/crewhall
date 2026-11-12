// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/jwt-decoder/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { claimRows, decodeJwt, isExpired } from './logic';

// {"alg":"HS256","typ":"JWT"} . {"sub":"123","name":"Ada","iat":1516239022,"exp":9999999999}
const TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJzdWIiOiIxMjMiLCJuYW1lIjoiQWRhIiwiaWF0IjoxNTE2MjM5MDIyLCJleHAiOjk5OTk5OTk5OTl9.' +
  'signature';

describe('jwt-decoder', () => {
  it('decodes header and payload', () => {
    const d = decodeJwt(TOKEN);
    expect(d.header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(d.payload.sub).toBe('123');
    expect(d.payload.name).toBe('Ada');
    expect(d.signature).toBe('signature');
  });

  it('accepts a signature-less 2-segment token', () => {
    const [h, p] = TOKEN.split('.');
    const d = decodeJwt(`${h}.${p}`);
    expect(d.signature).toBe('');
    expect(d.payload.sub).toBe('123');
  });

  it('rejects malformed tokens', () => {
    expect(() => decodeJwt('a.b.c.d')).toThrow(); // too many segments
    expect(() => decodeJwt('!!.!!')).toThrow(); // invalid Base64URL
    expect(() => decodeJwt('onlyone')).toThrow(); // too few segments
  });

  it('flags expiry', () => {
    expect(isExpired({ exp: 1 })).toBe(true);
    expect(isExpired({ exp: 9999999999 })).toBe(false);
  });

  it('renders time claims as ISO dates', () => {
    const rows = claimRows({ iat: 1516239022 });
    expect(rows[0]!.note).toContain('2018-01-18');
  });

  it('does NOT verify the signature: a garbage or mismatched signature still decodes', () => {
    const [h, p] = TOKEN.split('.');
    const withGarbageSig = decodeJwt(`${h}.${p}.this-is-not-a-real-signature-at-all`);
    expect(withGarbageSig.payload.sub).toBe('123');
    expect(withGarbageSig.signature).toBe('this-is-not-a-real-signature-at-all');

    // Empty signature segment (3 segments, last one blank) also decodes fine.
    const withEmptySig = decodeJwt(`${h}.${p}.`);
    expect(withEmptySig.payload.sub).toBe('123');
  });

  it('decodes a tampered payload as-is, without detecting the tampering', () => {
    const [h] = TOKEN.split('.');
    const tamperedPayload = b64url({ sub: 'attacker', admin: true });
    const d = decodeJwt(`${h}.${tamperedPayload}.signature`);
    expect(d.payload).toEqual({ sub: 'attacker', admin: true });
  });

  it('throws when the header is not valid Base64URL-encoded JSON', () => {
    const [, p] = TOKEN.split('.');
    expect(() => decodeJwt(`not-valid-base64url!!!.${p}.sig`)).toThrow();
  });

  it('throws when the payload is valid Base64URL but not JSON', () => {
    const [h] = TOKEN.split('.');
    const notJson = b64urlRaw('this is not json');
    expect(() => decodeJwt(`${h}.${notJson}.sig`)).toThrow(
      'Payload is not valid Base64URL-encoded JSON.',
    );
  });

  it('trims surrounding whitespace from the raw token', () => {
    const d = decodeJwt(`  ${TOKEN}  \n`);
    expect(d.payload.sub).toBe('123');
  });

  it('surfaces exp as expired when in the past, and valid when in the future', () => {
    const expired = claimRows({ exp: 1 }); // 1970
    expect(expired[0]!.note).toContain('expired');

    const valid = claimRows({ exp: 9999999999 }); // far future
    expect(valid[0]!.note).toContain('valid');
    expect(valid[0]!.note).not.toContain('not yet valid');
  });

  it('surfaces nbf as not-yet-valid when in the future', () => {
    const future = claimRows({ nbf: 9999999999 });
    expect(future[0]!.note).toContain('not yet valid');

    const past = claimRows({ nbf: 1 });
    expect(past[0]!.note).not.toContain('not yet valid');
  });

  it('isExpired is false when exp is absent', () => {
    expect(isExpired({})).toBe(false);
    expect(isExpired({ sub: '123' })).toBe(false);
  });

  it('renders non-time-claim object values as JSON strings', () => {
    const rows = claimRows({ roles: ['a', 'b'] });
    expect(rows[0]!.value).toBe('["a","b"]');
  });
});

// --- fixture helpers ---------------------------------------------------------

/** Base64URL-encode a JS value as a JWT segment. */
function b64url(value: unknown): string {
  return b64urlRaw(JSON.stringify(value));
}

/** Base64URL-encode a raw string as a JWT segment (no JSON.stringify). */
function b64urlRaw(raw: string): string {
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
