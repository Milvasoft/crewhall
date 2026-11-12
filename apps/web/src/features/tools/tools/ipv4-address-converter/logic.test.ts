// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv4-address-converter/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { convertAddress, parseFlexible } from './logic';

describe('ipv4-address-converter', () => {
  it('parses several input formats to the same value', () => {
    const v = parseFlexible('192.168.1.1');
    expect(parseFlexible('3232235777')).toBe(v);
    expect(parseFlexible('0xc0a80101')).toBe(v);
    expect(parseFlexible('0b11000000101010000000000100000001')).toBe(v);
  });

  it('produces every representation', () => {
    const f = convertAddress('192.168.1.1');
    expect(f.decimal).toBe('3232235777');
    expect(f.hex).toBe('0xc0a80101');
    expect(f.binary).toBe('11000000.10101000.00000001.00000001');
    expect(f.ipv6).toBe('::ffff:192.168.1.1');
    expect(f.ipv6Hex).toBe('::ffff:c0a8:0101');
  });

  it('round-trips integer back to dotted', () => {
    expect(convertAddress('0').dotted).toBe('0.0.0.0');
    expect(convertAddress('4294967295').dotted).toBe('255.255.255.255');
  });

  it('rejects out-of-range and garbage', () => {
    expect(() => parseFlexible('4294967296')).toThrow();
    expect(() => parseFlexible('hello')).toThrow();
  });

  it('rejects empty input', () => {
    expect(() => parseFlexible('')).toThrow(/enter an address/i);
    expect(() => parseFlexible('   ')).toThrow(/enter an address/i);
  });

  it('rejects a negative decimal value', () => {
    expect(() => parseFlexible('-1')).toThrow();
  });

  it('accepts uppercase 0x/0o/0b prefixes', () => {
    const v = parseFlexible('192.168.1.1');
    expect(parseFlexible('0XC0A80101')).toBe(v);
    expect(parseFlexible('0O30052000401')).toBe(v);
  });

  it('handles the all-zero boundary in every representation', () => {
    const f = convertAddress('0');
    expect(f.dotted).toBe('0.0.0.0');
    expect(f.decimal).toBe('0');
    expect(f.hex).toBe('0x00000000');
    expect(f.octal).toBe('0o0');
    expect(f.binary).toBe('00000000.00000000.00000000.00000000');
    expect(f.ipv6).toBe('::ffff:0.0.0.0');
    expect(f.ipv6Hex).toBe('::ffff:0000:0000');
  });

  it('handles the max (broadcast) boundary in every representation', () => {
    const f = convertAddress('4294967295');
    expect(f.dotted).toBe('255.255.255.255');
    expect(f.hex).toBe('0xffffffff');
    expect(f.binary).toBe('11111111.11111111.11111111.11111111');
    expect(f.ipv6).toBe('::ffff:255.255.255.255');
    expect(f.ipv6Hex).toBe('::ffff:ffff:ffff');
  });
});
