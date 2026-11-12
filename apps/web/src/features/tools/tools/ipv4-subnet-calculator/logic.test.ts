// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ipv4-subnet-calculator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { calculateSubnet } from './logic';

describe('ipv4-subnet-calculator', () => {
  it('computes a /24', () => {
    const s = calculateSubnet('192.168.1.10/24');
    expect(s.network).toBe('192.168.1.0');
    expect(s.broadcast).toBe('192.168.1.255');
    expect(s.netmask).toBe('255.255.255.0');
    expect(s.wildcard).toBe('0.0.0.255');
    expect(s.firstHost).toBe('192.168.1.1');
    expect(s.lastHost).toBe('192.168.1.254');
    expect(s.totalHosts).toBe(256);
    expect(s.usableHosts).toBe(254);
    expect(s.isPrivate).toBe(true);
    expect(s.ipClass).toBe('C');
  });

  it('handles /31 and /32 edge cases', () => {
    const p2p = calculateSubnet('10.0.0.0/31');
    expect(p2p.usableHosts).toBe(2);
    expect(p2p.firstHost).toBe('10.0.0.0');
    expect(p2p.lastHost).toBe('10.0.0.1');

    const host = calculateSubnet('10.0.0.5/32');
    expect(host.usableHosts).toBe(1);
    expect(host.network).toBe('10.0.0.5');
  });

  it('accepts an explicit netmask', () => {
    const s = calculateSubnet('172.16.5.4 255.255.0.0');
    expect(s.prefix).toBe(16);
    expect(s.network).toBe('172.16.0.0');
    expect(s.isPrivate).toBe(true);
  });

  it('flags public addresses', () => {
    expect(calculateSubnet('8.8.8.8/24').isPrivate).toBe(false);
  });

  it('computes a /0 (the entire IPv4 space)', () => {
    const s = calculateSubnet('10.20.30.40/0');
    expect(s.network).toBe('0.0.0.0');
    expect(s.broadcast).toBe('255.255.255.255');
    expect(s.totalHosts).toBe(2 ** 32);
    expect(s.usableHosts).toBe(2 ** 32 - 2);
  });

  it('classifies IP address classes at their boundaries', () => {
    expect(calculateSubnet('127.0.0.1/32').ipClass).toBe('A');
    expect(calculateSubnet('191.255.255.255/32').ipClass).toBe('B');
    expect(calculateSubnet('223.255.255.255/32').ipClass).toBe('C');
    expect(calculateSubnet('224.0.0.0/32').ipClass).toBe('D (multicast)');
    expect(calculateSubnet('240.0.0.0/32').ipClass).toBe('E (reserved)');
  });

  it('flags private ranges at their exact boundaries', () => {
    expect(calculateSubnet('172.31.255.255/32').isPrivate).toBe(true);
    expect(calculateSubnet('172.32.0.0/32').isPrivate).toBe(false);
    expect(calculateSubnet('172.15.255.255/32').isPrivate).toBe(false);
    expect(calculateSubnet('192.168.255.255/32').isPrivate).toBe(true);
    expect(calculateSubnet('192.169.0.0/32').isPrivate).toBe(false);
    expect(calculateSubnet('9.255.255.255/32').isPrivate).toBe(false);
  });

  it('defaults to /32 when no prefix or mask is given', () => {
    const s = calculateSubnet('192.168.1.1');
    expect(s.prefix).toBe(32);
    expect(s.network).toBe('192.168.1.1');
    expect(s.usableHosts).toBe(1);
  });

  it('throws on malformed input', () => {
    expect(() => calculateSubnet('not.an.ip/24')).toThrow();
    expect(() => calculateSubnet('10.0.0.1/33')).toThrow();
    expect(() => calculateSubnet('300.0.0.1/24')).toThrow();
    // Non-contiguous netmask.
    expect(() => calculateSubnet('10.0.0.1 255.0.255.0')).toThrow();
  });
});
