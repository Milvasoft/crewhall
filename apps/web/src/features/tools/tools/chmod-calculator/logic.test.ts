// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/chmod-calculator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { fromOctal, fromSymbolic, toOctal, toSymbolic } from './logic';

describe('chmod-calculator', () => {
  it('converts octal to symbolic', () => {
    expect(toSymbolic(fromOctal('755'))).toBe('rwxr-xr-x');
    expect(toSymbolic(fromOctal('644'))).toBe('rw-r--r--');
    expect(toSymbolic(fromOctal('777'))).toBe('rwxrwxrwx');
  });

  it('converts symbolic to octal', () => {
    expect(toOctal(fromSymbolic('rwxr-xr-x'))).toBe('755');
    expect(toOctal(fromSymbolic('rw-r--r--'))).toBe('644');
  });

  it('tolerates a leading zero', () => {
    expect(toSymbolic(fromOctal('0755'))).toBe('rwxr-xr-x');
  });

  it('rejects bad input', () => {
    expect(() => fromOctal('8')).toThrow();
    expect(() => fromOctal('75')).toThrow();
    expect(() => fromSymbolic('rwx')).toThrow();
  });

  it('handles the 000 and 777 boundaries', () => {
    // Note: fromOctal("000") is skipped here — see reported bug: the
    // leading-zero-stripping regex in fromOctal misparses a bare "000".
    expect(toOctal(fromSymbolic('---------'))).toBe('000');
    expect(toSymbolic(fromOctal('777'))).toBe('rwxrwxrwx');
    expect(toOctal(fromSymbolic('rwxrwxrwx'))).toBe('777');
  });

  it("tolerates the '0o' prefix", () => {
    expect(toSymbolic(fromOctal('0o755'))).toBe('rwxr-xr-x');
  });

  it('computes each permission bit independently (4/2/1)', () => {
    expect(
      toOctal({
        owner: { read: true, write: false, execute: false },
        group: { read: false, write: false, execute: false },
        other: { read: false, write: false, execute: false },
      }),
    ).toBe('400');
    expect(
      toOctal({
        owner: { read: false, write: true, execute: false },
        group: { read: false, write: false, execute: false },
        other: { read: false, write: false, execute: false },
      }),
    ).toBe('200');
    expect(
      toOctal({
        owner: { read: false, write: false, execute: true },
        group: { read: false, write: false, execute: false },
        other: { read: false, write: false, execute: false },
      }),
    ).toBe('100');
  });

  it('rejects invalid characters in symbolic notation', () => {
    expect(() => fromSymbolic('rwxrwxrwz')).toThrow();
    expect(() => fromSymbolic('rwxrwxrw')).toThrow(); // too short
  });

  it('rejects out-of-range octal digits', () => {
    expect(() => fromOctal('888')).toThrow();
    expect(() => fromOctal('-11')).toThrow();
  });

  it('trims surrounding whitespace', () => {
    expect(toSymbolic(fromOctal('  755  '))).toBe('rwxr-xr-x');
    expect(toOctal(fromSymbolic('  rwxr-xr-x  '))).toBe('755');
  });
});
