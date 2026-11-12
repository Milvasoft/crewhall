// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv4-range-expander/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { expandRange } from './logic';

describe('ipv4-range-expander', () => {
  it('finds the smallest enclosing CIDR', () => {
    const r = expandRange('192.168.1.5', '192.168.1.20');
    expect(r.cidr).toBe('192.168.1.0/27');
    expect(r.newStart).toBe('192.168.1.0');
    expect(r.newEnd).toBe('192.168.1.31');
    expect(r.addresses).toBe(32);
  });

  it('collapses an exact /24 range', () => {
    const r = expandRange('10.0.0.0', '10.0.0.255');
    expect(r.cidr).toBe('10.0.0.0/24');
    expect(r.addresses).toBe(256);
  });

  it('handles a single address (/32)', () => {
    const r = expandRange('1.2.3.4', '1.2.3.4');
    expect(r.prefix).toBe(32);
    expect(r.addresses).toBe(1);
  });

  it('normalizes reversed input', () => {
    const r = expandRange('192.168.1.20', '192.168.1.5');
    expect(r.inputStart).toBe('192.168.1.5');
    expect(r.inputEnd).toBe('192.168.1.20');
  });

  it('throws on a malformed IPv4 address', () => {
    expect(() => expandRange('999.1.1.1', '1.1.1.1')).toThrow();
    expect(() => expandRange('not-an-ip', '1.1.1.1')).toThrow();
  });

  it('expands the entire address space to /0', () => {
    const r = expandRange('0.0.0.0', '255.255.255.255');
    expect(r.prefix).toBe(0);
    expect(r.cidr).toBe('0.0.0.0/0');
    expect(r.netmask).toBe('0.0.0.0');
    expect(r.addresses).toBe(2 ** 32);
  });

  it('handles two adjacent addresses as a /31', () => {
    const r = expandRange('10.0.0.2', '10.0.0.3');
    expect(r.prefix).toBe(31);
    expect(r.newStart).toBe('10.0.0.2');
    expect(r.newEnd).toBe('10.0.0.3');
    expect(r.addresses).toBe(2);
  });

  it('computes the correct netmask for the smallest enclosing CIDR', () => {
    const r = expandRange('192.168.1.5', '192.168.1.20');
    expect(r.netmask).toBe('255.255.255.224');
  });
});
