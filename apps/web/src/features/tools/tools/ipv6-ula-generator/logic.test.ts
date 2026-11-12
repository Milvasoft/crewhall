// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv6-ula-generator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { generateUla, randomUla } from './logic';

describe('ipv6-ula-generator', () => {
  const bytes = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a]);

  it('builds an fd00::/8 ULA from a global id', () => {
    const u = generateUla(bytes, 0);
    expect(u.globalId).toBe('123456789a');
    expect(u.prefix48).toBe('fd12:3456:789a::/48');
    expect(u.prefix64).toBe('fd12:3456:789a:0000::/64');
    expect(u.firstAddress).toBe('fd12:3456:789a:0000::1');
  });

  it('applies the subnet id', () => {
    const u = generateUla(bytes, 0x2a);
    expect(u.subnetId).toBe('002a');
    expect(u.prefix64).toBe('fd12:3456:789a:002a::/64');
  });

  it('always starts with fd (locally assigned)', () => {
    const u = generateUla(new Uint8Array([0, 0, 0, 0, 0]));
    expect(u.prefix48.startsWith('fd00:')).toBe(true);
  });

  it('rejects short global ids', () => {
    expect(() => generateUla(new Uint8Array([1, 2, 3]))).toThrow();
  });

  it('ignores bytes beyond the first 5', () => {
    const u = generateUla(new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xff, 0xff]), 0);
    expect(u.globalId).toBe('123456789a');
    expect(u.prefix48).toBe('fd12:3456:789a::/48');
  });

  it('always forces the fd high byte even when the top Global ID byte is 0xff', () => {
    const u = generateUla(new Uint8Array([0xff, 0x34, 0x56, 0x78, 0x9a]));
    expect(u.prefix48.startsWith('fdff:')).toBe(true);
  });

  it('masks the subnet id to 16 bits, wrapping values above 0xffff', () => {
    const u = generateUla(bytes, 0x10000); // one past the max 16-bit value
    expect(u.subnetId).toBe('0000');
  });

  it('masks a negative subnet id into an unsigned 16-bit value', () => {
    const u = generateUla(bytes, -1);
    expect(u.subnetId).toBe('ffff');
  });

  it('defaults the subnet id to 0 when omitted', () => {
    const u = generateUla(bytes);
    expect(u.subnetId).toBe('0000');
  });
});

describe('randomUla', () => {
  it("produces a structurally valid ULA with RFC 4193's fixed fd prefix", () => {
    const u = randomUla();
    expect(u.globalId).toMatch(/^[0-9a-f]{10}$/);
    expect(u.prefix48).toMatch(/^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}::\/48$/);
    expect(u.prefix64).toMatch(/^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}:[0-9a-f]{4}::\/64$/);
    expect(u.firstAddress).toBe(u.prefix64.replace('::/64', '::1'));
  });

  it('applies the given subnet id', () => {
    const u = randomUla(0x2a);
    expect(u.subnetId).toBe('002a');
  });

  it('generates different global IDs across calls', () => {
    const ids = new Set(Array.from({ length: 10 }, () => randomUla().globalId));
    expect(ids.size).toBeGreaterThan(1);
  });
});
