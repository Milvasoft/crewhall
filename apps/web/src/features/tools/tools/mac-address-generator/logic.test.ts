// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/mac-address-generator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { generateMac, macBytesFrom, randomMac } from './logic';

const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);

describe('mac-address-generator', () => {
  it('formats with separators and case', () => {
    expect(generateMac(bytes, { separator: ':', uppercase: false })).toBe('de:ad:be:ef:01:02');
    expect(generateMac(bytes, { separator: '-', uppercase: true })).toBe('DE-AD-BE-EF-01-02');
    expect(generateMac(bytes, { separator: '.', uppercase: false })).toBe('dead.beef.0102');
    expect(generateMac(bytes, { separator: '', uppercase: true })).toBe('DEADBEEF0102');
  });

  it('honors a fixed OUI prefix', () => {
    expect(generateMac(bytes, { separator: ':', uppercase: false, prefix: '00:11:22' })).toBe(
      '00:11:22:ef:01:02',
    );
  });

  it('only overrides as many bytes as the prefix provides', () => {
    expect(macBytesFrom(bytes, '00:11')).toEqual([0x00, 0x11, 0xbe, 0xef, 0x01, 0x02]);
  });

  it('ignores an empty or whitespace-only prefix', () => {
    expect(macBytesFrom(bytes, '')).toEqual([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    expect(macBytesFrom(bytes, '   ')).toEqual([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
  });

  it('caps a prefix longer than six octets at the first six bytes', () => {
    expect(macBytesFrom(bytes, 'aa:bb:cc:dd:ee:ff:11:22')).toEqual([
      0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
    ]);
  });

  it('defaults missing random bytes to 0', () => {
    expect(macBytesFrom(new Uint8Array([1, 2]))).toEqual([1, 2, 0, 0, 0, 0]);
  });

  it('randomMac produces well-formed, distinct addresses across calls', () => {
    const a = randomMac({ separator: ':', uppercase: false });
    const b = randomMac({ separator: ':', uppercase: false });
    const macPattern = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
    expect(a).toMatch(macPattern);
    expect(b).toMatch(macPattern);
    expect(a).not.toBe(b);
  });
});
