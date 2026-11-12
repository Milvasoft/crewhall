// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/totp-generator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, otpauthUri, totp } from './logic';

// RFC 4226/6238 test secret: ASCII "12345678901234567890".
const SECRET = new TextEncoder().encode('12345678901234567890');
// RFC 6238 Appendix B secrets for the SHA-256/SHA-512 test vectors.
const SECRET32 = new TextEncoder().encode('12345678901234567890123456789012');
const SECRET64 = new TextEncoder().encode(
  '1234567890123456789012345678901234567890123456789012345678901234',
);

describe('totp-generator', () => {
  it('round-trips base32', () => {
    expect(base32Encode(SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(new TextDecoder().decode(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'))).toBe(
      '12345678901234567890',
    );
  });

  it('matches RFC 4226 HOTP vectors', async () => {
    expect(await hotp(SECRET, 0)).toBe('755224');
    expect(await hotp(SECRET, 1)).toBe('287082');
    expect(await hotp(SECRET, 9)).toBe('520489');
  });

  it('matches the RFC 6238 TOTP vector at T=59', async () => {
    const r = await totp(SECRET, { now: 59, digits: 8, algorithm: 'SHA-1' });
    expect(r.code).toBe('94287082');
  });

  it('reports seconds remaining in the period', async () => {
    const r = await totp(SECRET, { now: 45, period: 30 });
    expect(r.secondsRemaining).toBe(15);
  });

  it('rejects invalid base32', () => {
    expect(() => base32Decode('1!')).toThrow();
  });

  it('matches the RFC 6238 TOTP vectors for SHA-256 and SHA-512 at T=59', async () => {
    const sha256 = await totp(SECRET32, { now: 59, digits: 8, algorithm: 'SHA-256' });
    expect(sha256.code).toBe('46119246');
    const sha512 = await totp(SECRET64, { now: 59, digits: 8, algorithm: 'SHA-512' });
    expect(sha512.code).toBe('90693936');
  });

  it('matches the RFC 6238 TOTP vectors at T=1111111109 across all three algorithms', async () => {
    expect((await totp(SECRET, { now: 1111111109, digits: 8 })).code).toBe('07081804');
    expect((await totp(SECRET32, { now: 1111111109, digits: 8, algorithm: 'SHA-256' })).code).toBe(
      '68084774',
    );
    expect((await totp(SECRET64, { now: 1111111109, digits: 8, algorithm: 'SHA-512' })).code).toBe(
      '25091201',
    );
  });

  it('truncates HOTP to the requested digit count', async () => {
    expect(await hotp(SECRET, 0, 4)).toBe('5224');
    expect(await hotp(SECRET, 0, 8)).toBe('84755224');
  });

  it('handles a counter beyond the 32-bit range (verified against a reference HMAC computation)', async () => {
    expect(await hotp(SECRET, 2 ** 31)).toBe('197202');
  });

  it('secondsRemaining wraps to the full period exactly on a period boundary', async () => {
    expect((await totp(SECRET, { now: 30, period: 30 })).secondsRemaining).toBe(30);
    expect((await totp(SECRET, { now: 0, period: 30 })).secondsRemaining).toBe(30);
  });

  it('base32 round-trips the empty buffer', () => {
    expect(base32Encode(new Uint8Array())).toBe('');
    expect(base32Decode('')).toEqual(new Uint8Array());
  });

  it('base32Decode is case-insensitive and ignores padding/whitespace', () => {
    const decoded = base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq====');
    expect(new TextDecoder().decode(decoded)).toBe('12345678901234567890');
  });

  it('builds a well-formed otpauth:// URI with the given parameters', () => {
    const uri = otpauthUri('GEZDGNBVGY3TQOJQ', {
      issuer: 'Acme Co',
      account: 'alice@example.com',
      digits: 8,
      period: 60,
      algorithm: 'SHA-256',
    });
    expect(uri).toBe(
      'otpauth://totp/Acme%20Co:alice%40example.com?secret=GEZDGNBVGY3TQOJQ&issuer=Acme%20Co&algorithm=SHA256&digits=8&period=60',
    );
  });

  it('otpauthUri defaults issuer, account, digits and period when omitted', () => {
    const uri = otpauthUri('GEZDGNBVGY3TQOJQ');
    expect(uri).toContain('issuer=Too%20Much%20Tools');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(uri).toContain('algorithm=SHA1');
  });
});
